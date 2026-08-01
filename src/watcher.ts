import { existsSync, readFileSync, unlinkSync, watch } from "node:fs";
import type { FSWatcher } from "node:fs";
import { join } from "node:path";
import { execSafe, shellQuote } from "./tmux-utils";
import { readOutputFileTail } from "./output";
import { formatCompletionSummary, formatRenderedBashResult, hasOnlyEmptyBashOutput, type BashOutputRenderDetails } from "./format-output";
import { formatTmuxOutputForContext } from "./format-output";
import { closeWindowOnCompletion } from "./script";
import { stopPoller } from "./poller";
import { updateStoredBackgroundProcessStatus } from "./status";
import { type ResolvedOptions } from "./config";
import type { CommandRunInfo, ExtensionState } from "./state";

const tmuxCommand = (options: ResolvedOptions): string => shellQuote(options.tmuxBinary);

const parseExitCodeFilename = (filename: string): CommandRunInfo | null => {
  const lastDot = filename.lastIndexOf(".");
  const secondLastDot = filename.lastIndexOf(".", lastDot - 1);
  if (secondLastDot === -1) return null;

  const session = filename.slice(0, secondLastDot);
  const windowTarget = filename.slice(secondLastDot + 1, lastDot);
  if (!windowTarget) return null;

  return {
    session,
    windowId: windowTarget.startsWith("@") ? windowTarget : `@${windowTarget}`,
    id: filename.slice(lastDot + 1),
  };
};

type CustomMessageInput = Parameters<import("@earendil-works/pi-coding-agent").ExtensionAPI["sendMessage"]>[0];

type CompletionMessageRenderDetails = {
  summary: string;
  output: BashOutputRenderDetails;
  exitCode: number;
  status: "success" | "failed";
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

const deliverCompletionAndCloseOnSuccess = async (
  pi: import("@earendil-works/pi-coding-agent").ExtensionAPI,
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

const handleCompletedExitCodeFile = async (
  state: ExtensionState,
  pi: import("@earendil-works/pi-coding-agent").ExtensionAPI,
  exitCodeFilePath: string,
  filename: string,
  options: ResolvedOptions,
): Promise<boolean> => {
  const parsed = parseExitCodeFilename(filename);
  if (!parsed) return false;

  const exitCode = readFileSync(exitCodeFilePath, "utf-8").trim();
  if (!/^-?\d+$/.test(exitCode)) return false;
  unlinkSync(exitCodeFilePath);

  const outputFile = `${exitCodeFilePath}.out`;
  const fileOutput = readOutputFileTail(outputFile, options.maxOutputBytes);
  const fallbackOutput =
    fileOutput === null
      ? (execSafe(
          `${tmuxCommand(options)} capture-pane -t ${shellQuote(parsed.windowId)} -p -S -${options.completedContextLines}`,
        ) ?? "")
      : "";
  const rawOutput = fileOutput ?? {
    text: fallbackOutput,
    sourceBytes: Buffer.byteLength(fallbackOutput, "utf-8"),
    sourceTruncated: false,
  };
  const output = formatTmuxOutputForContext(rawOutput.text, {
    fullOutputPath: fileOutput === null ? undefined : outputFile,
    sourceBytes: rawOutput.sourceBytes,
    sourceTruncated: rawOutput.sourceTruncated,
    truncationOptions: {
      maxLines: options.completedContextLines,
      maxBytes: options.maxOutputBytes,
    },
  });
  const code = parseInt(exitCode);
  stopPoller(state, parsed.session, parsed.windowId);

  await deliverCompletionAndCloseOnSuccess(
    pi,
    completionCustomMessage(code, output),
    parsed.windowId,
    state,
    options,
  );
  return true;
};

const handleExitCodeFile = async (
  state: ExtensionState,
  pi: import("@earendil-works/pi-coding-agent").ExtensionAPI,
  runDir: string,
  filename: string,
  options: ResolvedOptions,
): Promise<void> => {
  if (!state.ownedExitCodeFiles.has(filename)) return;
  if (state.foregroundExitCodeFiles.has(filename)) return;

  const exitCodeFilePath = join(runDir, filename);
  if (!existsSync(exitCodeFilePath)) return;

  try {
    if (await handleCompletedExitCodeFile(state, pi, exitCodeFilePath, filename, options)) {
      state.ownedExitCodeFiles.delete(filename);
    }
  } catch {}
};

export const startWatching = (
  state: ExtensionState,
  pi: import("@earendil-works/pi-coding-agent").ExtensionAPI,
  options: ResolvedOptions,
): void => {
  if (state.watcher || !state.runDir) return;

  state.watcher = watch(state.runDir, (_eventType, filename) => {
    if (!filename || filename.endsWith(".sh") || filename.endsWith(".out")) return;
    setTimeout(
      () =>
        void handleExitCodeFile(state, pi, state.runDir!, filename.toString(), options).catch(() => {}),
      100,
    );
  });
};