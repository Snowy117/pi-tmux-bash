import { existsSync } from "node:fs";
import { sleep } from "@richardgill/lib";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TmuxInput } from "./tool-call-schemas";
import type { ExtensionState } from "./state";
import type { ResolvedOptions } from "./config";
import type { TmuxWindowFilters } from "./tmux-utils";
import {
  calcTmuxSessionName,
  resolveWorkspaceRoot,
  exec,
  sessionExists,
  shellQuote,
  tmuxWindowFiltersForScope,
} from "./tmux-utils";
import { tmuxCommand, closeWindowOnCompletion } from "./script";
import { stopPoller, startPoller } from "./poller";
import { updateBackgroundProcessStatus } from "./status";
import { formatTmuxOutputForContext, formatRenderedBashResult } from "./format-output";
import { toolError, summaryToolText, renderedToolText } from "./state";
import { peekAction, rawAction, listAction, requireBashWindowById, findBashWindowById, getBashCreatedWindows } from "./peek-raw";

const COMPLETION_DELIVERY_GRACE_MS = 200;

const killAction = (
  params: Extract<TmuxInput, { action: "kill" }>,
  session: string,
  filters: TmuxWindowFilters,
  state: ExtensionState,
  options: ResolvedOptions,
) => {
  if (!sessionExists(session, options.tmuxBinary))
    return toolError(`No background session '${session}'.`);

  const window = requireBashWindowById("kill", session, filters, options, params.window);
  if ("isError" in window) return window;

  exec(`${tmuxCommand(options)} kill-window -t ${shellQuote(params.window)}`);
  stopPoller(state, session, window.id);
  return summaryToolText(`Killed background window: ${window.title} ${window.id}.`);
};

const pollAction = (
  params: Extract<TmuxInput, { action: "poll" }>,
  session: string,
  gitRoot: string,
  piSessionId: string,
  filters: TmuxWindowFilters,
  state: ExtensionState,
  pi: ExtensionAPI,
  options: ResolvedOptions,
) => {
  const window = requireBashWindowById("poll", session, filters, options, params.window);
  if ("isError" in window) return window;

  if (params.pollInterval <= 0)
    return toolError("Error: pollInterval must be greater than 0 for poll action.");

  const pollInterval = options.pollDelivery === "model"
    ? Math.max(params.pollInterval, options.minimumPollIntervalSeconds)
    : params.pollInterval;

  startPoller(pi, state, session, window.id, pollInterval, params.pollLines, options, gitRoot, piSessionId);
  return summaryToolText(`Polling ${window.title} every ${pollInterval}s.`);
};

const unpollAction = (
  params: Extract<TmuxInput, { action: "unpoll" }>,
  session: string,
  filters: TmuxWindowFilters,
  state: ExtensionState,
  options: ResolvedOptions,
) => {
  const window = requireBashWindowById("unpoll", session, filters, options, params.window);
  if ("isError" in window) return window;

  return summaryToolText(
    stopPoller(state, session, window.id)
      ? `Stopped polling ${window.title}`
      : `No poller for ${window.title}.`,
  );
};

const pollerMatchesFilters = (poller: { gitRoot: string; piSessionId: string }, filters: TmuxWindowFilters): boolean =>
  (filters.gitRoot === undefined || poller.gitRoot === filters.gitRoot) &&
  (filters.piSessionId === undefined || poller.piSessionId === filters.piSessionId);

const listPollsAction = (
  session: string,
  filters: TmuxWindowFilters,
  state: ExtensionState,
  options: ResolvedOptions,
) => {
  const pollers = [...state.pollers.values()]
    .filter((poller) => poller.session === session)
    .filter((poller) => pollerMatchesFilters(poller, filters));
  if (pollers.length === 0) return summaryToolText("No active pollers.");

  const windows = getBashCreatedWindows(session, options, filters);
  const lines = pollers.map((poller) => {
    const title = windows.find((w) => w.id === poller.windowId)?.title ?? poller.windowId;
    return `  ${title} every ${poller.interval}s (${poller.lines} lines)`;
  });
  return renderedToolText(`Active pollers:\n\n${lines.join("\n")}`,
    { summary: "Active pollers:", expandedLines: ["", ...lines], collapsedLines: ["", ...lines] },
    { pollers: pollers.map((p) => ({ session: p.session, windowId: p.windowId, gitRoot: p.gitRoot, piSessionId: p.piSessionId, interval: p.interval, lines: p.lines })) },
  );
};

const waitAction = async (
  params: Extract<TmuxInput, { action: "wait" }>,
  session: string,
  filters: TmuxWindowFilters,
  options: ResolvedOptions,
  signal: AbortSignal | undefined,
) => {
  if (!sessionExists(session, options.tmuxBinary))
    return toolError(`No background session '${session}'.`);

  const window = requireBashWindowById("wait", session, filters, options, params.window);
  if ("isError" in window)
    return summaryToolText(`Background window ${params.window} is no longer running; it already finished and its result was delivered on completion.`);

  const exitCodeFile = window.outputFile?.replace(/\.out$/, "");
  const timeoutSeconds = options.maxTimeoutSeconds + 1;
  const deadline = Date.now() + timeoutSeconds * 1000;

  const isFinished = (): boolean =>
    Boolean(exitCodeFile && existsSync(exitCodeFile)) ||
    !findBashWindowById(session, filters, options, params.window);

  for (;;) {
    if (signal?.aborted)
      return summaryToolText(`Wait aborted; ${window.title} ${window.id} still running in the background.`);
    if (isFinished()) {
      await sleep(COMPLETION_DELIVERY_GRACE_MS);
      return summaryToolText(`Background window ${window.title} ${window.id} finished; result delivered automatically.`);
    }
    if (Date.now() >= deadline)
      return summaryToolText(`Background window ${window.title} ${window.id} still running after ${timeoutSeconds}s; result will be reported when it finishes.`);
    await sleep(100);
  }
};

export const executeTool = async (
  params: TmuxInput,
  ctx: ExtensionContext,
  state: ExtensionState,
  pi: ExtensionAPI,
  options: ResolvedOptions,
  signal?: AbortSignal,
) => {
  const gitRoot = resolveWorkspaceRoot(ctx.cwd, options.allowNonGitDirectories);
  if (!gitRoot)
    return toolError("Error: not in a git repository (allowNonGitDirectories is false).");

  const piSessionId = ctx.sessionManager.getSessionId();
  const session = calcTmuxSessionName(gitRoot, options);
  const filters = tmuxWindowFiltersForScope(gitRoot, piSessionId, options);
  if (params.action === "peek") return peekAction(params, session, filters, options);
  if (params.action === "raw") return rawAction(params, session, filters, state, options);
  if (params.action === "list") return listAction(session, filters, options);
  if (params.action === "kill") {
    const result = killAction(params, session, filters, state, options);
    updateBackgroundProcessStatus(ctx, options);
    return result;
  }
  if (params.action === "poll")
    return pollAction(params, session, gitRoot, piSessionId, filters, state, pi, options);
  if (params.action === "unpoll") return unpollAction(params, session, filters, state, options);
  if (params.action === "wait") return waitAction(params, session, filters, options, signal);
  return listPollsAction(session, filters, state, options);
};