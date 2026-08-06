import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { sleep } from "@richardgill/lib";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ResolvedOptions } from "./config";
import { formatTmuxOutputForContext } from "./format-output";
import {
  formatConfiguredEnvExports,
  formatEnvironmentExportsForBash,
  tmuxCommand,
  tmuxWindowNameForCommand,
} from "./script";
import { toolError, type ExtensionState, type InteractiveShellSession } from "./state";
import type { ShellInput, ShellSignal } from "./tool-call-schemas";
import {
  calcTmuxSessionName,
  exec,
  execSafe,
  resolveWorkspaceRoot,
  sessionExists,
  shellQuote,
  TMUX_WINDOW_OPTIONS,
} from "./tmux-utils";

type InteractiveShellResultDetails = {
  sessionId: string;
  windowId: string;
  status: InteractiveShellSession["status"];
  exitCode?: number;
  outputFile: string;
};

const ensureRunDir = (state: ExtensionState, options: ResolvedOptions): string => {
  if (state.runDir) return state.runDir;

  state.runDir = join(options.outputDir, `shell-${process.pid}-${randomBytes(4).toString("hex")}`);
  mkdirSync(state.runDir, { recursive: true, mode: 0o700 });
  chmodSync(state.runDir, 0o700);
  return state.runDir;
};

const interactiveConfiguredEnvironment = (options: ResolvedOptions): Record<string, string> => {
  const env = { ...options.tmuxEnv };

  if (env.NO_COLOR === "1") delete env.NO_COLOR;
  if (env.PAGER === "cat") delete env.PAGER;
  if (env.DEBIAN_FRONTEND === "noninteractive") delete env.DEBIAN_FRONTEND;
  env.TERM = process.env.TERM && process.env.TERM !== "dumb"
    ? process.env.TERM
    : "xterm-256color";
  return env;
};

const createInteractiveScript = (
  runDir: string,
  sessionId: string,
  command: string,
  readyFile: string,
  statusFile: string,
  options: ResolvedOptions,
): string => {
  const scriptDir = join(runDir, "s");
  mkdirSync(scriptDir, { recursive: true, mode: 0o700 });
  chmodSync(scriptDir, 0o700);

  const scriptPath = join(scriptDir, `${sessionId}.interactive.sh`);
  writeFileSync(
    scriptPath,
    `#!/usr/bin/env bash
__ready_file=${shellQuote(readyFile)}
__status_file=${shellQuote(statusFile)}
while [ ! -e "$__ready_file" ]; do sleep 0.01; done
rm -f "$__ready_file"
${formatEnvironmentExportsForBash(process.env, options.tmuxEnvExportDenylist)}
${formatConfiguredEnvExports(interactiveConfiguredEnvironment(options))}
(
${command}
)
__rc=$?
printf '%s\n' "$__rc" > "$__status_file"
exit "$__rc"
`,
    { mode: 0o755 },
  );
  return scriptPath;
};

const setWindowOption = (
  windowId: string,
  option: string,
  value: string,
  options: ResolvedOptions,
): void => {
  exec(
    `${tmuxCommand(options)} set-window-option -q -t ${shellQuote(windowId)} ${option} ${shellQuote(value)}`,
  );
};

const createInteractiveSession = (
  input: Extract<ShellInput, { action: "start" }>,
  ctx: ExtensionContext,
  state: ExtensionState,
  options: ResolvedOptions,
): InteractiveShellSession | ReturnType<typeof toolError> => {
  const gitRoot = resolveWorkspaceRoot(ctx.cwd, options.allowNonGitDirectories);
  if (!gitRoot) {
    return toolError("Error: not in a git repository (allowNonGitDirectories is false).");
  }

  const runDir = ensureRunDir(state, options);
  const id = `sh_${randomBytes(6).toString("hex")}`;
  const tmuxSession = calcTmuxSessionName(gitRoot, options);
  const piSessionId = ctx.sessionManager.getSessionId();
  const outputFile = join(runDir, `${id}.interactive.out`);
  const statusFile = join(runDir, `${id}.interactive.status`);
  const readyFile = join(runDir, `${id}.interactive.ready`);
  writeFileSync(outputFile, "", { mode: 0o600 });
  const scriptPath = createInteractiveScript(
    runDir,
    id,
    input.command,
    readyFile,
    statusFile,
    options,
  );
  const createCommand = sessionExists(tmuxSession, options.tmuxBinary)
    ? `new-window -d -t ${shellQuote(tmuxSession)}`
    : `new-session -d -s ${shellQuote(tmuxSession)}`;

  let windowId: string | undefined;
  try {
    windowId = exec(
      `${tmuxCommand(options)} ${createCommand} -n ${shellQuote(tmuxWindowNameForCommand(input.command, input.name, options))} -c ${shellQuote(gitRoot)} -P -F '#{window_id}' ${shellQuote(scriptPath)}`,
    );
    setWindowOption(windowId, "remain-on-exit", "on", options);
    setWindowOption(windowId, TMUX_WINDOW_OPTIONS.gitRoot, gitRoot, options);
    setWindowOption(windowId, TMUX_WINDOW_OPTIONS.piSessionId, piSessionId, options);
    setWindowOption(windowId, TMUX_WINDOW_OPTIONS.startedAt, String(Math.floor(Date.now() / 1000)), options);
    setWindowOption(windowId, TMUX_WINDOW_OPTIONS.interactiveSessionId, id, options);

    const pipeCommand = `cat >> ${shellQuote(outputFile)}`;
    exec(
      `${tmuxCommand(options)} pipe-pane -o -t ${shellQuote(windowId)} ${shellQuote(pipeCommand)}`,
    );
    writeFileSync(readyFile, "", { mode: 0o600 });
  } catch (error) {
    if (windowId) {
      execSafe(`${tmuxCommand(options)} kill-window -t ${shellQuote(windowId)}`);
    }
    return toolError(
      `Error: failed to start interactive shell: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const session: InteractiveShellSession = {
    id,
    tmuxSession,
    windowId,
    gitRoot,
    piSessionId,
    command: input.command,
    outputFile,
    statusFile,
    readyFile,
    outputOffset: 0,
    status: "running",
  };
  state.interactiveShellSessions.set(id, session);
  return session;
};

const refreshSessionStatus = (
  session: InteractiveShellSession,
  options: ResolvedOptions,
): void => {
  if (session.status !== "running") return;

  if (existsSync(session.statusFile)) {
    const value = readFileSync(session.statusFile, "utf8").trim();
    if (/^-?\d+$/.test(value)) {
      session.status = "exited";
      session.exitCode = parseInt(value, 10);
      return;
    }
  }

  const paneState = execSafe(
    `${tmuxCommand(options)} display-message -p -t ${shellQuote(session.windowId)} '#{pane_dead}:#{pane_exit_status}'`,
  );
  const [paneDead, paneExitStatus] = paneState?.split(":") ?? [];
  if (paneDead === "1") {
    session.status = "exited";
    if (paneExitStatus && /^-?\d+$/.test(paneExitStatus)) {
      session.exitCode = parseInt(paneExitStatus, 10);
    }
  } else if (paneState === null) {
    session.status = "exited";
  }
};

const outputSize = (session: InteractiveShellSession): number => {
  try {
    return statSync(session.outputFile).size;
  } catch {
    return 0;
  }
};

const waitForSessionUpdate = async (
  session: InteractiveShellSession,
  waitMs: number,
  options: ResolvedOptions,
  waitForExit = false,
  signal?: AbortSignal,
): Promise<void> => {
  const deadline = Date.now() + waitMs;
  for (;;) {
    refreshSessionStatus(session, options);
    if (session.status !== "running" || (!waitForExit && outputSize(session) > session.outputOffset)) break;
    if (signal?.aborted || Date.now() >= deadline) break;
    await sleep(25);
  }

  if (session.status === "exited") await sleep(50);
};

const readOutputDelta = (session: InteractiveShellSession): string => {
  if (!existsSync(session.outputFile)) return "";

  const content = readFileSync(session.outputFile);
  if (content.length < session.outputOffset) session.outputOffset = 0;
  const delta = content
    .subarray(session.outputOffset)
    .toString("utf8")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
  session.outputOffset = content.length;
  return delta;
};

const closeExitedWindow = (session: InteractiveShellSession, options: ResolvedOptions): void => {
  if (session.status !== "exited") return;
  execSafe(`${tmuxCommand(options)} kill-window -t ${shellQuote(session.windowId)}`);
};

const shellResult = (
  session: InteractiveShellSession,
  output: string,
  options: ResolvedOptions,
) => {
  const formattedOutput = output
    ? formatTmuxOutputForContext(output, {
        fullOutputPath: session.outputFile,
        truncationOptions: { maxBytes: options.maxOutputBytes, maxLines: options.bashContextLines },
      })
    : undefined;
  const summary = session.status === "running"
    ? `Interactive shell session ${session.id} is running.`
    : session.status === "killed"
      ? `Interactive shell session ${session.id} was killed.`
      : `Interactive shell session ${session.id} exited${session.exitCode === undefined ? "" : ` with code ${session.exitCode}`}.`;
  const text = formattedOutput?.text ? `${summary}\n\n${formattedOutput.text}` : summary;
  const details: InteractiveShellResultDetails = {
    sessionId: session.id,
    windowId: session.windowId,
    status: session.status,
    ...(session.exitCode === undefined ? {} : { exitCode: session.exitCode }),
    outputFile: session.outputFile,
  };
  return { content: [{ type: "text" as const, text }], details };
};

const requireSession = (
  sessionId: string,
  ctx: ExtensionContext,
  state: ExtensionState,
): InteractiveShellSession | ReturnType<typeof toolError> => {
  const session = state.interactiveShellSessions.get(sessionId);
  if (!session) return toolError(`Error: no interactive shell session ${sessionId}.`);
  if (session.piSessionId !== ctx.sessionManager.getSessionId()) {
    return toolError(`Error: interactive shell session ${sessionId} belongs to another Pi session.`);
  }
  return session;
};

const sendSignal = (
  session: InteractiveShellSession,
  signal: ShellSignal,
  options: ResolvedOptions,
): void => {
  if (signal === "SIGTERM") {
    execSafe(`${tmuxCommand(options)} kill-window -t ${shellQuote(session.windowId)}`);
    session.status = "killed";
    return;
  }

  if (signal === "EOF") {
    exec(`${tmuxCommand(options)} send-keys -t ${shellQuote(session.windowId)} C-d`);
    return;
  }

  const panePid = execSafe(
    `${tmuxCommand(options)} display-message -p -t ${shellQuote(session.windowId)} '#{pane_pid}'`,
  );
  const processGroup = panePid && /^\d+$/.test(panePid)
    ? execSafe(`ps -o tpgid= -p ${panePid}`)?.trim()
    : undefined;
  if (processGroup && /^\d+$/.test(processGroup) && parseInt(processGroup, 10) > 0) {
    try {
      process.kill(-parseInt(processGroup, 10), "SIGINT");
      return;
    } catch {}
  }

  exec(`${tmuxCommand(options)} send-keys -t ${shellQuote(session.windowId)} C-c`);
};

const sendInput = (
  session: InteractiveShellSession,
  input: string,
  options: ResolvedOptions,
): void => {
  if (!input) return;
  exec(
    `${tmuxCommand(options)} send-keys -l -t ${shellQuote(session.windowId)} ${shellQuote(input)}`,
  );
};

export const executeInteractiveShell = async (
  input: ShellInput,
  ctx: ExtensionContext,
  state: ExtensionState,
  options: ResolvedOptions,
  signal?: AbortSignal,
) => {
  if (input.action === "start") {
    const session = createInteractiveSession(input, ctx, state, options);
    if ("isError" in session) return session;
    await waitForSessionUpdate(session, input.waitMs, options, false, signal);
    const output = readOutputDelta(session);
    closeExitedWindow(session, options);
    return shellResult(session, output, options);
  }

  const session = requireSession(input.sessionId, ctx, state);
  if ("isError" in session) return session;
  refreshSessionStatus(session, options);

  if (input.action === "kill") {
    if (session.status === "running") {
      execSafe(`${tmuxCommand(options)} kill-window -t ${shellQuote(session.windowId)}`);
      session.status = "killed";
      await sleep(50);
    }
    return shellResult(session, readOutputDelta(session), options);
  }

  if (session.status === "running") {
    try {
      sendInput(session, input.input, options);
      if (input.signal) sendSignal(session, input.signal, options);
    } catch (error) {
      return toolError(
        `Error: failed to write to interactive shell ${session.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  await waitForSessionUpdate(session, input.waitMs, options, Boolean(input.signal), signal);
  if (input.signal === "SIGINT" && session.status === "exited" && session.exitCode === undefined) {
    session.exitCode = 130;
  }
  const output = readOutputDelta(session);
  closeExitedWindow(session, options);
  return shellResult(session, output, options);
};
