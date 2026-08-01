import { execSafe, shellQuote, calcTmuxSessionName, resolveWorkspaceRoot, tmuxWindowFiltersForScope, sessionExists } from "./tmux-utils";
import { BACKGROUND_BASH_STATUS_KEY, type ResolvedOptions } from "./config";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const shellCommands = new Set(["bash", "zsh", "sh", "fish", "dash"]);

const hasChildProcesses = (pid: string): boolean =>
  Boolean(pid && execSafe(`pgrep -P ${shellQuote(pid)} | head -1`));

const isIdleShellProcess = (command: string, pid: string): boolean =>
  shellCommands.has(command) && !hasChildProcesses(pid);

const runningProcessListFormat = [
  "#{pane_current_command}",
  "#{pane_pid}",
  "#{@pi-tmux-bash-git-root}",
  "#{@pi-tmux-bash-pi-session-id}",
  "#{@pi-tmux-bash-output-file}",
].join("|||");

const countRunningBackgroundProcesses = (
  session: string,
  filters: { gitRoot?: string; piSessionId?: string },
  options: ResolvedOptions,
): number => {
  const raw = execSafe(
    `${shellQuote(options.tmuxBinary)} list-windows -t ${shellQuote(session)} -F ${shellQuote(runningProcessListFormat)}`,
  );
  if (!raw) return 0;

  return raw
    .split("\n")
    .map((line) => {
      const [command = "", pid = "", gitRoot = "", piSessionId = "", outputFile = ""] =
        line.split("|||");
      return { command, pid, gitRoot, piSessionId, outputFile };
    })
    .filter((window) => filters.gitRoot === undefined || window.gitRoot === filters.gitRoot)
    .filter(
      (window) => filters.piSessionId === undefined || window.piSessionId === filters.piSessionId,
    )
    .filter((window) => window.outputFile)
    .filter((window) => !isIdleShellProcess(window.command, window.pid)).length;
};

const formatBackgroundProcessStatus = (count: number): string | undefined =>
  count > 0 ? `${count} background proc${count === 1 ? "" : "s"}` : undefined;

export const updateBackgroundProcessStatus = (
  ctx: ExtensionContext,
  options: ResolvedOptions,
): void => {
  if (!ctx.hasUI) return;

  const gitRoot = resolveWorkspaceRoot(ctx.cwd, options.allowNonGitDirectories);
  if (!gitRoot) {
    ctx.ui.setStatus(BACKGROUND_BASH_STATUS_KEY, undefined);
    return;
  }

  const session = calcTmuxSessionName(gitRoot, options);
  const filters = tmuxWindowFiltersForScope(gitRoot, ctx.sessionManager.getSessionId(), options);
  const count = sessionExists(session, options.tmuxBinary)
    ? countRunningBackgroundProcesses(session, filters, options)
    : 0;
  ctx.ui.setStatus(BACKGROUND_BASH_STATUS_KEY, formatBackgroundProcessStatus(count));
};

export const updateStoredBackgroundProcessStatus = (
  state: { statusContext: ExtensionContext | null },
  options: ResolvedOptions,
): void => {
  if (!state.statusContext) return;

  try {
    updateBackgroundProcessStatus(state.statusContext, options);
  } catch {}
};