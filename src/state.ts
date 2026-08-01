import { randomBytes } from "node:crypto";
import { existsSync, chmodSync, mkdirSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { FSWatcher } from "node:fs";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type CommandRunInfo = {
  session: string;
  windowId: string;
  id: string;
  outputFile?: string;
};

export type Poller = {
  timer: NodeJS.Timeout;
  session: string;
  windowId: string;
  gitRoot: string;
  piSessionId: string;
  interval: number;
  lines: number;
  commandRun?: CommandRunInfo;
};

export type ExtensionState = {
  runDir: string | null;
  watcher: FSWatcher | null;
  foregroundExitCodeFiles: Set<string>;
  ownedExitCodeFiles: Set<string>;
  pollers: Map<string, Poller>;
  pendingPollMessageTimers: Set<NodeJS.Timeout>;
  statusContext: ExtensionContext | null;
  rawOutputByWindowId: Map<string, string>;
};

// ── Tool result helpers ────────────────────────────────────────────────

export const toolError = (text: string) => ({
  content: [{ type: "text" as const, text }],
  details: {},
  isError: true as const,
});

type TmuxRenderDetails = {
  summary: string;
  expandedLines: string[];
  collapsedLines: string[];
  attachLines?: string[];
};

export const renderedToolText = (
  text: string,
  render: TmuxRenderDetails,
  details: Record<string, unknown> = {},
) => ({ content: [{ type: "text" as const, text }], details: { ...details, render } });

export const summaryToolText = (summary: string, details: Record<string, unknown> = {}) =>
  renderedToolText(summary, { summary, expandedLines: [], collapsedLines: [] }, details);

// ── State management ───────────────────────────────────────────────────

const runDirPath = (options: import("./config").ResolvedOptions, id: string): string =>
  join(options.outputDir, id);

export const createState = (): ExtensionState => ({
  runDir: null,
  watcher: null,
  foregroundExitCodeFiles: new Set(),
  ownedExitCodeFiles: new Set(),
  pollers: new Map(),
  pendingPollMessageTimers: new Set(),
  statusContext: null,
  rawOutputByWindowId: new Map(),
});

export const resetRunDir = (
  state: ExtensionState,
  options: import("./config").ResolvedOptions,
  sessionId: string,
): void => {
  const encodedSessionId = Buffer.from(sessionId).toString("base64url").slice(0, 24);
  const id = `${encodedSessionId}-${process.pid}-${randomBytes(4).toString("hex")}`;
  state.runDir = runDirPath(options, id);
  mkdirSync(state.runDir, { recursive: true, mode: 0o700 });
  chmodSync(state.runDir, 0o700);
};

const cleanupRunDir = (runDir: string, preserveOutputFiles: boolean): void => {
  if (!existsSync(runDir)) return;
  if (!preserveOutputFiles) {
    rmSync(runDir, { recursive: true, force: true });
    return;
  }

  readdirSync(runDir, { withFileTypes: true })
    .filter((entry) => !entry.isFile() || !entry.name.endsWith(".out"))
    .forEach((entry) => rmSync(join(runDir, entry.name), { recursive: true, force: true }));
};

export const cleanupState = (
  state: ExtensionState,
  options: import("./config").ResolvedOptions,
): void => {
  state.watcher?.close();
  state.watcher = null;
  for (const poller of state.pollers.values()) clearInterval(poller.timer);
  state.pollers.clear();
  for (const timer of state.pendingPollMessageTimers.values()) clearTimeout(timer);
  state.pendingPollMessageTimers.clear();
  state.foregroundExitCodeFiles.clear();
  state.ownedExitCodeFiles.clear();
  state.statusContext = null;
  state.rawOutputByWindowId.clear();

  if (state.runDir) {
    cleanupRunDir(state.runDir, options.preserveOutputFiles);
    state.runDir = null;
  }
};