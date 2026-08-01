import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { sleep } from "@richardgill/lib";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmuxWindowFiltersForScope, shellQuote, execSafe } from "./tmux-utils";
import { readOutputFileTail, type OutputFileTail } from "./output";
import { exitCodeFilename, outputFileForRun, closeWindowOnCompletion, tmuxCommand } from "./script";
import { updateStoredBackgroundProcessStatus } from "./status";
import { type ResolvedOptions } from "./config";
import { formatCompletionSummary, formatRenderedBashResult, hasOnlyEmptyBashOutput, formatTmuxOutputForContext, type BashOutputRenderDetails } from "./format-output";
import type { CommandRunInfo, Poller, ExtensionState } from "./state";
import type { TmuxWindow } from "./tmux-utils";
import { getWindows } from "./tmux-utils";

const isBashCreatedWindow = (window: TmuxWindow): boolean =>
  Boolean(window.outputFile && window.displayCommand);

export const getBashCreatedWindows = (
  session: string,
  options: ResolvedOptions,
  filters: Parameters<typeof getWindows>[1] = {},
): TmuxWindow[] => getWindows(session, filters, options.tmuxBinary).filter(isBashCreatedWindow);

const bashWindowOutput = (window: TmuxWindow, options: ResolvedOptions): OutputFileTail =>
  readOutputFileTail(window.outputFile, options.maxOutputBytes) ?? {
    text: "",
    sourceBytes: 0,
    sourceTruncated: false,
  };

export const formatBashWindowOutput = (
  window: TmuxWindow,
  options: ResolvedOptions,
  contextLines: number,
) => {
  const rawOutput = bashWindowOutput(window, options);
  return formatTmuxOutputForContext(rawOutput.text, {
    fullOutputPath: window.outputFile,
    sourceBytes: rawOutput.sourceBytes,
    sourceTruncated: rawOutput.sourceTruncated,
    truncationOptions: {
      maxLines: contextLines,
      maxBytes: options.maxOutputBytes,
    },
  });
};

const pollerKey = (session: string, windowId: string): string => `${session}:${windowId}`;

const readExitCodeFile = (
  state: ExtensionState,
  commandRun?: CommandRunInfo,
): number | undefined => {
  if (!commandRun || !state.runDir) return undefined;

  const filename = exitCodeFilename(commandRun);
  const exitCodeFile = join(state.runDir, filename);
  if (!existsSync(exitCodeFile)) return undefined;

  const exitCode = parseInt(readFileSync(exitCodeFile, "utf-8").trim());
  unlinkSync(exitCodeFile);
  state.foregroundExitCodeFiles.delete(filename);
  state.ownedExitCodeFiles.delete(filename);
  return exitCode;
};

const stopPoller = (state: ExtensionState, session: string, windowId: string): boolean => {
  const key = pollerKey(session, windowId);
  const poller = state.pollers.get(key);
  if (!poller) return false;

  clearInterval(poller.timer);
  state.pollers.delete(key);
  return true;
};

export { stopPoller };

type CustomMessageInput = Parameters<ExtensionAPI["sendMessage"]>[0];

type PollMessageRenderDetails = {
  summary: string;
  command: string;
  output: BashOutputRenderDetails;
  attachLines: string[];
};

type CompletionMessageRenderDetails = {
  summary: string;
  output: BashOutputRenderDetails;
  exitCode: number;
  status: "success" | "failed";
};

const pollMessageDetails = (
  window: TmuxWindow,
  output: ReturnType<typeof formatTmuxOutputForContext>,
): PollMessageRenderDetails => ({
  summary: `background poll: ${window.title} ${window.id}`,
  command: `$ ${window.displayCommand ?? window.title}`,
  output: output.details.render,
  attachLines: [],
});

const formatPollMessage = (details: PollMessageRenderDetails): string =>
  [
    details.summary,
    ` ${details.command}`,
    ...formatRenderedBashResult(details.output, { expanded: true }).split("\n").map((l) => ` ${l}`),
  ].join("\n");

const pollCustomMessage = (
  window: TmuxWindow,
  output: ReturnType<typeof formatTmuxOutputForContext>,
): CustomMessageInput => {
  const details = pollMessageDetails(window, output);
  return {
    customType: "tmux-bash-poll",
    content: formatPollMessage(details),
    details,
    display: true,
  };
};

const completionMessageDetails = (
  exitCode: number,
  output: ReturnType<typeof formatTmuxOutputForContext>,
): CompletionMessageRenderDetails => ({
  summary: formatCompletionSummary(exitCode),
  output: output.details.render,
  exitCode,
  status: exitCode === 0 ? "success" : "failed",
});

const formatCompletionMessage = (details: CompletionMessageRenderDetails): string => {
  if (hasOnlyEmptyBashOutput(details.output)) return details.summary;

  return `${details.summary}\n\n\`\`\`\n${formatRenderedBashResult(details.output, { expanded: true })}\n\`\`\``;
};

const completionCustomMessage = (exitCode: number, output: ReturnType<typeof formatTmuxOutputForContext>): CustomMessageInput => {
  const details = completionMessageDetails(exitCode, output);
  return {
    customType: "tmux-bash-completion",
    content: formatCompletionMessage(details),
    details,
    display: true,
  };
};

const effectivePollInterval = (interval: number, options: ResolvedOptions): number =>
  options.pollDelivery === "model"
    ? Math.max(interval, options.minimumPollIntervalSeconds)
    : interval;

const sendPollMessageWhenIdle = (
  pi: ExtensionAPI,
  state: ExtensionState,
  message: CustomMessageInput,
): void => {
  if (state.statusContext?.isIdle?.() !== false) {
    pi.sendMessage(message, { triggerTurn: false });
    return;
  }

  const timer = setTimeout(() => {
    state.pendingPollMessageTimers.delete(timer);
    sendPollMessageWhenIdle(pi, state, message);
  }, 100);
  state.pendingPollMessageTimers.add(timer);
};

const deliverCompletionAndCloseOnSuccess = async (
  pi: ExtensionAPI,
  message: CustomMessageInput,
  windowId: string,
  state: ExtensionState,
  options: ResolvedOptions,
): Promise<void> => {
  try {
    await pi.sendMessage(message, { triggerTurn: true, deliverAs: "steer" });
  } catch {
    return;
  }
  closeWindowOnCompletion(windowId, options);
  updateStoredBackgroundProcessStatus(state, options);
};

export const startPoller = (
  pi: ExtensionAPI,
  state: ExtensionState,
  session: string,
  windowId: string,
  interval: number,
  lines: number,
  options: ResolvedOptions,
  gitRoot: string,
  piSessionId: string,
  commandRun?: CommandRunInfo,
): void => {
  if (interval <= 0) return;

  stopPoller(state, session, windowId);
  let lastText: string | undefined;
  const tick = async (): Promise<void> => {
    const filters = tmuxWindowFiltersForScope(gitRoot, piSessionId, options);
    const window = getBashCreatedWindows(session, options, filters).find(
      (item) => item.id === windowId,
    );
    if (!window) {
      stopPoller(state, session, windowId);
      updateStoredBackgroundProcessStatus(state, options);
      return;
    }

    const exitCode = readExitCodeFile(state, commandRun);
    const completed = exitCode !== undefined;
    const outputFile = commandRun?.outputFile ?? window.outputFile;
    const outputLines = completed ? options.completedContextLines : lines;
    const completedRawOutput = completed
      ? readOutputFileTail(outputFile, options.maxOutputBytes)
      : undefined;
    const output = completedRawOutput
      ? formatTmuxOutputForContext(completedRawOutput.text, {
          fullOutputPath: outputFile,
          sourceBytes: completedRawOutput.sourceBytes,
          sourceTruncated: completedRawOutput.sourceTruncated,
          truncationOptions: {
            maxLines: outputLines,
            maxBytes: options.maxOutputBytes,
          },
        })
      : formatBashWindowOutput(window, options, outputLines);
    if (!completed && options.pollDelivery === "display" && output.text === lastText) return;

    lastText = output.text;
    if (completed) stopPoller(state, session, windowId);

    const message = completed
      ? completionCustomMessage(exitCode, output)
      : pollCustomMessage(window, output);

    if (completed) {
      await deliverCompletionAndCloseOnSuccess(pi, message, windowId, state, options);
    } else if (options.pollDelivery === "model") {
      pi.sendMessage(message, { triggerTurn: true, deliverAs: "followUp" });
    } else {
      sendPollMessageWhenIdle(pi, state, message);
    }
  };
  const timer = setInterval(() => void tick().catch(() => {}), interval * 1000);

  state.pollers.set(pollerKey(session, windowId), {
    timer,
    session,
    windowId,
    gitRoot,
    piSessionId,
    interval,
    lines,
    commandRun,
  });
};