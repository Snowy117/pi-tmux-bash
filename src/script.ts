import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { exec, execSafe, shellQuote, TMUX_WINDOW_OPTIONS } from "./tmux-utils";
import { displayCommandForCommand } from "./format-output";
import { DEFAULT_OPTIONS, SHELL_IDENTIFIER_REGEX, type ResolvedOptions } from "./config";
import type { CommandRunInfo } from "./state";

export const tmuxCommand = (options: ResolvedOptions): string => shellQuote(options.tmuxBinary);

const shellDoubleQuote = (value: string): string =>
  `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

const isExportableEnvironmentName = (name: string, denylist: ReadonlySet<string>): boolean =>
  SHELL_IDENTIFIER_REGEX.test(name) && !denylist.has(name);

export const formatEnvironmentExportsForBash = (
  env: NodeJS.ProcessEnv = process.env,
  denylist: readonly string[] = DEFAULT_OPTIONS.tmuxEnvExportDenylist,
): string => {
  const deniedNames = new Set(denylist);
  return Object.entries(env)
    .filter(
      ([name, value]) => value !== undefined && isExportableEnvironmentName(name, deniedNames),
    )
    .map(([name, value]) => `export ${name}=${shellQuote(value ?? "")}`)
    .join("\n");
};

export const formatConfiguredEnvExports = (env: Record<string, string>): string =>
  Object.entries(env)
    .filter(([name]) => SHELL_IDENTIFIER_REGEX.test(name))
    .map(([name, value]) => `export ${name}=${shellDoubleQuote(value)}`)
    .join("\n");

const commandLabel = (cmd: string, name: string | undefined, options: ResolvedOptions): string => {
  if (name) return name;

  const displayCommand = displayCommandForCommand(cmd, options.displayCommandStartMarker);
  const firstWord = displayCommand.split(/[|;&\s]/)[0];
  return firstWord?.split("/").pop() || "shell";
};

const replaceTmuxWindowNameVariable = (template: string, variable: string, value: string): string =>
  template.replace(new RegExp(`{{\\s*${variable}\\s*}}`, "g"), value);

export const tmuxWindowNameForCommand = (
  cmd: string,
  name: string | undefined,
  options: ResolvedOptions,
): string => {
  const displayCommand = displayCommandForCommand(cmd, options.displayCommandStartMarker);
  return Object.entries({
    command: displayCommand,
    name: name ?? "",
    nameOrCommand: commandLabel(cmd, name, options),
  })
    .reduce(
      (text, [variable, value]) => replaceTmuxWindowNameVariable(text, variable, value),
      options.tmuxWindowNameTemplate,
    )
    .slice(0, options.maxTmuxWindowNameLength);
};

export const exitCodeFilename = ({ session, windowId, id }: CommandRunInfo): string =>
  `${session}.${windowId}.${id}`;

export const outputFileForRun = (runDir: string, commandRun: CommandRunInfo): string =>
  join(runDir, `${exitCodeFilename(commandRun)}.out`);

export const closeWindowOnCompletion = (windowId: string, options: ResolvedOptions): void => {
  if (!options.autoCloseWindowsOnCompletion) return;
  execSafe(`${tmuxCommand(options)} kill-window -t ${shellQuote(windowId)}`);
};

const setWindowOptions = (
  windowId: string,
  values: Record<string, string>,
  options: ResolvedOptions,
): void => {
  Object.entries(values).forEach(([option, value]) => {
    execSafe(
      `${tmuxCommand(options)} set-window-option -q -t ${shellQuote(windowId)} ${option} ${shellQuote(value)}`,
    );
  });
};

export const createBashCommandScript = (
  runDir: string,
  session: string,
  cmd: string,
  displayCommand: string,
  options: ResolvedOptions,
): { id: string; scriptPath: string } => {
  const scriptDir = join(runDir, "s");
  mkdirSync(scriptDir, { recursive: true, mode: 0o700 });
  chmodSync(scriptDir, 0o700);

  const id = randomBytes(4).toString("hex");
  const scriptPath = join(scriptDir, `${session}.${id}.sh`);
  writeFileSync(
    scriptPath,
    `#!/usr/bin/env bash
__run_dir=${shellQuote(runDir)}
__session=${shellQuote(session)}
__id=${shellQuote(id)}
__tmux_binary=${shellQuote(options.tmuxBinary)}
__window_id=$("$__tmux_binary" display-message -p -t "\${TMUX_PANE:-}" '#{window_id}' 2>/dev/null || printf '@0')
__exit_code_file="$__run_dir/$__session.$__window_id.$__id"
__output_file="$__exit_code_file.out"
: > "$__output_file"
printf '$ %s\\n' ${shellQuote(displayCommand)}
${formatEnvironmentExportsForBash(process.env, options.tmuxEnvExportDenylist)}
${formatConfiguredEnvExports(options.tmuxEnv)}
(
${cmd}
) 2>&1 | tee -a "$__output_file"
__rc=\${PIPESTATUS[0]}
printf '%s\\n' "$__rc" > "$__exit_code_file"
if [ -n "\${SHELL:-}" ] && [ -x "\${SHELL:-}" ]; then
  exec "$SHELL" -l
fi
exec bash -l
`,
    { mode: 0o755 },
  );

  return { id, scriptPath };
};

type CreateBashWindowInput = {
  runDir: string;
  session: string;
  gitRoot: string;
  piSessionId: string;
  command: string;
  name?: string;
  sessionExists: boolean;
  options: ResolvedOptions;
};

export type RunWindowResult = {
  windowId: string;
  id: string;
  outputFile?: string;
};

export const tagBashWindow = (
  input: CreateBashWindowInput,
  displayCommand: string,
  scriptId: string,
  windowId: string,
): RunWindowResult => {
  const outputFile = outputFileForRun(input.runDir, {
    session: input.session,
    windowId,
    id: scriptId,
  });
  setWindowOptions(
    windowId,
    {
      [TMUX_WINDOW_OPTIONS.gitRoot]: input.gitRoot,
      [TMUX_WINDOW_OPTIONS.piSessionId]: input.piSessionId,
      [TMUX_WINDOW_OPTIONS.startedAt]: String(Math.floor(Date.now() / 1000)),
      [TMUX_WINDOW_OPTIONS.outputFile]: outputFile,
      [TMUX_WINDOW_OPTIONS.displayCommand]: displayCommand,
    },
    input.options,
  );

  return { windowId, id: scriptId, outputFile };
};

export const createBashWindow = (input: CreateBashWindowInput): RunWindowResult => {
  const displayCommand = displayCommandForCommand(
    input.command,
    input.options.displayCommandStartMarker,
  );
  const script = createBashCommandScript(
    input.runDir,
    input.session,
    input.command,
    displayCommand,
    input.options,
  );
  const createCommand = input.sessionExists
    ? `new-window -d -t ${shellQuote(input.session)}`
    : `new-session -d -s ${shellQuote(input.session)}`;
  const windowId = exec(
    `${tmuxCommand(input.options)} ${createCommand} -n ${shellQuote(tmuxWindowNameForCommand(input.command, input.name, input.options))} -c ${shellQuote(input.gitRoot)} -P -F '#{window_id}' ${shellQuote(script.scriptPath)}`,
  );
  return tagBashWindow(input, displayCommand, script.id, windowId);
};