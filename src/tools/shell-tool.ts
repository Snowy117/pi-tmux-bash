import { Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ResolvedOptions } from "../config";
import { executeInteractiveShell } from "../interactive-shell";
import { renderPromptTemplate, resolveSystemPromptToolSnippet } from "../system-prompt";
import { toolError, type ExtensionState } from "../state";
import { buildShellToolCallSchema, type ShellInput } from "../tool-call-schemas";

const shellPromptGuidelines = (options: ResolvedOptions): string[] => {
  if (!options.systemPrompt) return [];
  return [
    `Use ${options.shellToolName} for commands that need a persistent PTY or stdin, such as REPLs and interactive prompts.`,
    `Start with ${options.shellToolName} action start, then continue with action write and the returned sessionId.`,
    `The start command is a Bash command. Keep it short and simple; prefer subsequent write calls over complex Bash syntax or command orchestration.`,
    `Include a newline in write input to submit a line. Use empty input to poll, SIGINT for Ctrl-C, EOF for Ctrl-D, and SIGTERM to stop the session.`,
  ];
};

const shellCallLabel = (args: Partial<ShellInput>): string => {
  if (args.action === "start") return args.command ?? "start";
  if (args.action === "write") return `${args.sessionId ?? "session"} write`;
  if (args.action === "kill") return `${args.sessionId ?? "session"} kill`;
  return "shell";
};

const resultText = (result: { content?: { type: string; text?: string }[] }): string =>
  result.content?.find((item) => item.type === "text")?.text ?? "";

export const registerInteractiveShellTool = (
  pi: ExtensionAPI,
  state: ExtensionState,
  options: ResolvedOptions,
): void => {
  const shellToolCallSchema = buildShellToolCallSchema(options, toolError);

  pi.registerTool({
    name: options.shellToolName,
    label: options.shellToolName,
    description: renderPromptTemplate(options.shellToolDescription, options),
    promptSnippet: resolveSystemPromptToolSnippet(options.shellSystemPromptSnippet, options),
    promptGuidelines: shellPromptGuidelines(options),
    parameters: shellToolCallSchema.typeBoxSchema,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      return shellToolCallSchema.handleInput(params, (input) =>
        executeInteractiveShell(input, ctx, state, options, signal),
      );
    },
    renderCall(args, theme) {
      return new Text(
        `${theme.fg("toolTitle", theme.bold(`${options.shellToolName} `))}${theme.fg("accent", shellCallLabel(args as Partial<ShellInput>))}`,
        0,
        0,
      );
    },
    renderResult(result) {
      return new Text(resultText(result), 0, 0);
    },
  });
};
