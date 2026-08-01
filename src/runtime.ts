import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { sleep } from "@richardgill/lib";
import type {
  AgentToolUpdateCallback,
  BashToolDetails,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { type ResolvedOptions } from "./config";
import type { BashInput } from "./tool-call-schemas";
import { toolError, type ExtensionState } from "./state";
import type { CommandRunInfo } from "./state";
import { exitCodeFilename, createBashWindow, tmuxWindowNameForCommand, closeWindowOnCompletion } from "./script";
import { readOutputFileTail, type OutputFileTail } from "./output";
import { startWatching } from "./watcher";
import { startPoller } from "./poller";
import { updateBackgroundProcessStatus } from "./status";
import { formatTmuxOutputForContext } from "./format-output";
import {
  calcTmuxSessionName,
  resolveWorkspaceRoot,
  sessionExists,
  execSafe,
  shellQuote,
} from "./tmux-utils";

// Re-exported for backwards compatibility
import { createState, resetRunDir, cleanupState } from "./state";
export { createState, resetRunDir, cleanupState, toolError, type ExtensionState, type CommandRunInfo };

// Re-export from sub-modules for backwards compatibility
export { updateBackgroundProcessStatus } from "./status";
export { executeTool } from "./actions";
export { readOutputFileTail } from "./output";
export { formatEnvironmentExportsForBash } from "./script";

type TmuxAction = import("./config").TmuxAction;

const runDirPath = (options: ResolvedOptions, id: string): string => join(options.outputDir, id);

const getRunDir = (state: ExtensionState, options: ResolvedOptions): string => {
  if (state.runDir) return state.runDir;

  state.runDir = runDirPath(options, randomBytes(8).toString("hex"));
  mkdirSync(state.runDir, { recursive: true, mode: 0o700 });
  chmodSync(state.runDir, 0o700);
  return state.runDir;
};

const timeoutBackgroundHint = (options: ResolvedOptions): string => {
  const actions = (["peek", "list", "kill"] as TmuxAction[]).filter((action) =>
    options.tmuxEnabledActions.includes(action),
  );
  if (actions.length === 0) return "Result will be reported when it finishes.";

  return `Use ${options.tmuxToolName} ${actions.join("/")} to inspect or stop it. Result will be reported when it finishes.`;
};

const bashUpdate = (text = "", details?: BashToolDetails) => ({
  content: text ? [{ type: "text" as const, text }] : [],
  details,
});

const formatModelFacingOutput = async (args: {
  rawText: string;
  rawSourceBytes?: number;
  rawSourceTruncated?: boolean;
  rawFilePath?: string;
  options: ResolvedOptions;
  contextLines: number;
  windowId?: string;
  state?: ExtensionState;
}): Promise<ReturnType<typeof formatTmuxOutputForContext>> => {
  if (args.state && args.windowId && args.rawFilePath) {
    args.state.rawOutputByWindowId.set(args.windowId, args.rawFilePath);
  }
  return formatTmuxOutputForContext(args.rawText, {
    fullOutputPath: args.rawFilePath,
    sourceBytes: args.rawSourceBytes,
    sourceTruncated: args.rawSourceTruncated,
    truncationOptions: { maxLines: args.contextLines, maxBytes: args.options.maxOutputBytes },
  });
};

const commandOutputTail = (
  windowId: string,
  lines: number,
  options: ResolvedOptions,
  outputFile?: string,
): OutputFileTail => {
  const fileOutput = readOutputFileTail(outputFile, options.maxOutputBytes);
  if (fileOutput !== null) return fileOutput;

  const text = execSafe(
    `${shellQuote(options.tmuxBinary)} capture-pane -t ${shellQuote(windowId)} -p -S -${lines}`
  ) ?? "";
  return { text, sourceBytes: Buffer.byteLength(text, "utf-8"), sourceTruncated: false };
};

const emitForegroundBashOutputUpdate = (
  onUpdate: AgentToolUpdateCallback<BashToolDetails | undefined> | undefined,
  windowId: string,
  outputFile: string | undefined,
  options: ResolvedOptions,
  lastText: string | undefined,
): string | undefined => {
  if (!onUpdate) return lastText;

  const rawOutput = commandOutputTail(windowId, options.bashContextLines, options, outputFile);
  const output = formatTmuxOutputForContext(rawOutput.text, {
    fullOutputPath: outputFile,
    showFullOutputPath: options.alwaysShowOutputFilePath,
    sourceBytes: rawOutput.sourceBytes,
    sourceTruncated: rawOutput.sourceTruncated,
    truncationOptions: { maxLines: options.bashContextLines, maxBytes: options.maxOutputBytes },
  });
  if (output.text === "(no output)" || output.text === lastText) return lastText;

  onUpdate(bashUpdate(output.text, output.details));
  return output.text;
};

const startForegroundBashOutputUpdates = (
  onUpdate: AgentToolUpdateCallback<BashToolDetails | undefined> | undefined,
  windowId: string,
  outputFile: string | undefined,
  options: ResolvedOptions,
): (() => void) => {
  let lastText: string | undefined;
  const update = () => {
    lastText = emitForegroundBashOutputUpdate(onUpdate, windowId, outputFile, options, lastText);
  };
  const timer = setInterval(update, options.foregroundBashUpdateIntervalMs);
  update();
  return () => clearInterval(timer);
};

const waitForExitCode = async (
  runDir: string,
  signal: AbortSignal | undefined,
  commandRun: CommandRunInfo,
  timeoutSeconds: number,
): Promise<number | "timeout" | "aborted"> => {
  const exitCodeFile = join(runDir, exitCodeFilename(commandRun));
  const deadline = Date.now() + timeoutSeconds * 1000;

  for (;;) {
    if (signal?.aborted) return "aborted";
    if (existsSync(exitCodeFile)) {
      const exitCode = parseInt(readFileSync(exitCodeFile, "utf-8").trim());
      unlinkSync(exitCodeFile);
      return exitCode;
    }
    if (Date.now() >= deadline) return "timeout";
    await sleep(100);
  }
};

const bashPollInterval = (params: BashInput): number =>
  "pollInterval" in params ? (params.pollInterval ?? 0) : 0;

const bashPollLines = (params: BashInput, options: ResolvedOptions): number =>
  "pollLines" in params ? (params.pollLines ?? options.pollContextLines) : options.pollContextLines;

const effectivePollInterval = (interval: number, options: ResolvedOptions): number =>
  options.pollDelivery === "model"
    ? Math.max(interval, options.minimumPollIntervalSeconds)
    : interval;

export const runBashInTmux = async (
  params: BashInput,
  signal: AbortSignal | undefined,
  onUpdate: AgentToolUpdateCallback<BashToolDetails | undefined> | undefined,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  state: ExtensionState,
  options: ResolvedOptions,
) => {
  const gitRoot = resolveWorkspaceRoot(ctx.cwd, options.allowNonGitDirectories);
  if (!gitRoot)
    return toolError("Error: not in a git repository (allowNonGitDirectories is false).");

  state.statusContext = ctx;
  startWatching(state, pi, options);
  const session = calcTmuxSessionName(gitRoot, options);
  const piSessionId = ctx.sessionManager.getSessionId();
  const runDir = getRunDir(state, options);
  const result = createBashWindow({
    runDir, session, gitRoot, piSessionId,
    command: params.command, name: params.name,
    sessionExists: sessionExists(session, options.tmuxBinary), options,
  });
  const commandRun = {
    session, windowId: result.windowId, id: result.id, outputFile: result.outputFile,
  };
  if (result.outputFile) {
    state.rawOutputByWindowId.set(result.windowId, result.outputFile);
  }
  const completionExitCodeFilename = exitCodeFilename(commandRun);
  state.ownedExitCodeFiles.add(completionExitCodeFilename);

  updateBackgroundProcessStatus(ctx, options);

  if (params.background === true) {
    const requestedPollInterval = bashPollInterval(params);
    const pollInterval = effectivePollInterval(requestedPollInterval, options);
    if (requestedPollInterval > 0)
      startPoller(pi, state, session, result.windowId, pollInterval, bashPollLines(params, options), options, gitRoot, piSessionId, commandRun);
    return {
      content: [{ type: "text" as const, text: `Started in background window: ${tmuxWindowNameForCommand(params.command, params.name, options)} ${result.windowId}.${requestedPollInterval > 0 ? ` Polling every ${pollInterval}s.` : ""}\nResult will be reported when it finishes.` }],
      details: undefined,
    };
  }

  onUpdate?.(bashUpdate());
  const stopForegroundUpdates = startForegroundBashOutputUpdates(onUpdate, result.windowId, result.outputFile, options);
  state.foregroundExitCodeFiles.add(completionExitCodeFilename);
  const exitCode = await waitForExitCode(runDir, signal, commandRun, params.timeout).finally(() => {
    stopForegroundUpdates();
    state.foregroundExitCodeFiles.delete(completionExitCodeFilename);
  });
  if (exitCode !== "timeout" || params.timeoutAction !== "background") {
    state.ownedExitCodeFiles.delete(completionExitCodeFilename);
  }
  const rawOutput = commandOutputTail(result.windowId, options.bashContextLines, options, result.outputFile);
  const output = await formatModelFacingOutput({
    rawText: rawOutput.text, rawSourceBytes: rawOutput.sourceBytes, rawSourceTruncated: rawOutput.sourceTruncated,
    rawFilePath: result.outputFile, options, contextLines: options.bashContextLines, windowId: result.windowId, state,
  });
  const text = output.text;

  if (exitCode === "aborted") {
    execSafe(`${shellQuote(options.tmuxBinary)} kill-window -t ${shellQuote(result.windowId)}`);
    updateBackgroundProcessStatus(ctx, options);
    throw new Error(`${text}\n\nCommand aborted`);
  }

  if (exitCode === "timeout") {
    if (params.timeoutAction !== "background") {
      execSafe(`${shellQuote(options.tmuxBinary)} kill-window -t ${shellQuote(result.windowId)}`);
      updateBackgroundProcessStatus(ctx, options);
      throw new Error(`${text}\n\nCommand timed out after ${params.timeout} seconds`);
    }

    const requestedPollInterval = bashPollInterval(params);
    const pollInterval = effectivePollInterval(requestedPollInterval, options);
    if (requestedPollInterval > 0)
      startPoller(pi, state, session, result.windowId, pollInterval, bashPollLines(params, options), options, gitRoot, piSessionId, commandRun);
    const timeoutText = `Still running after ${params.timeout}s in the background as window ${result.windowId}${requestedPollInterval > 0 ? ` and polling every ${pollInterval}s` : ""}. ${timeoutBackgroundHint(options)}`;
    return {
      content: [{ type: "text" as const, text: [text, timeoutText].filter(Boolean).join("\n\n") }],
      details: { ...output.details, outcome: "timed-out-background" as const },
    };
  }

  closeWindowOnCompletion(result.windowId, options);
  updateBackgroundProcessStatus(ctx, options);

  if (exitCode !== 0) {
    throw new Error(`${text}\n\nCommand exited with code ${exitCode}`);
  }

  return { content: [{ type: "text" as const, text }], details: output.details };
};