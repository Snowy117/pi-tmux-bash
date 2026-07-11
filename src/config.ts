import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";
import { loadConfigOrDefault, templatedString } from "@richardgill/pi-config";
import { z } from "zod";

export const BACKGROUND_BASH_STATUS_KEY = "backgroundBashTmuxCommands";
export const BASH_DURATION_SEPARATOR = "\n\n";
export const SHELL_IDENTIFIER_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Skip shell/tmux bookkeeping that should be owned by the new tmux window.
const DEFAULT_TMUX_ENV_EXPORT_DENYLIST = [
  "PWD",
  "OLDPWD",
  "SHLVL",
  "_",
  "TMUX",
  "TMUX_PANE",
] as const;

const DEFAULT_BASH_SYSTEM_PROMPT_SNIPPET = "Execute bash commands in background windows";
const DEFAULT_TMUX_SYSTEM_PROMPT_SNIPPET =
  "Inspect and control the background jobs created by bash tool";
const DEFAULT_BASH_TOOL_DESCRIPTION =
  'Execute a bash command in a background window. Output is truncated to last {{bashContextLines}} lines or {{maxOutputKb}}KB. Defaults to a {{defaultTimeoutSeconds}}s timeout, max {{maxTimeoutSeconds}}s; timeoutAction defaults to "{{defaultTimeoutAction}}". Use background for long-running commands.';
const DEFAULT_TMUX_TOOL_DESCRIPTION =
  "Inspect and control background jobs created by bash. Peek output is compact by default. Use action raw to load unfiltered tee output by window id or .out path.";
const DEFAULT_PEEK_EXPANDED_DISPLAY_LINES = 50;

export const MODEL_OUTPUT_COMPRESSION_MODES = ["off", "hypa"] as const;
export type ModelOutputCompression = (typeof MODEL_OUTPUT_COMPRESSION_MODES)[number];

export const HYPA_COMPRESS_KINDS = ["shell-output", "log", "code", "generic"] as const;
export type HypaCompressKind = (typeof HYPA_COMPRESS_KINDS)[number];

export const TMUX_ACTIONS = [
  "list",
  "peek",
  "raw",
  "kill",
  "poll",
  "unpoll",
  "list-polls",
  "wait",
] as const;
const DEFAULT_TMUX_ENABLED_ACTIONS = ["list", "peek", "raw", "kill", "wait"] as const;

const DEFAULT_SYSTEM_PROMPT_GUIDELINES = [
  'Use {{bashToolName}} with background: true or timeoutAction: "background" for long-running commands, servers, watchers, REPLs, interactive prompts, and background bash commands.',
  "Background bash commands will report automatically when they finish; do not keep polling manually unless you need interim output.",
  "Use {{tmuxToolName}} list to find background windows",
  "Use {{tmuxToolName}} peek/kill with a stable window id like @123.",
  "If asked, tell the user the background window id (e.g. @123) and they will know how to view it live.",
  "If a background command's completion is missing, its full output is saved in a .out file under {{outputDir}}; recover it with `find {{outputDir}} -name '*.out'` then read.",
  "Use {{tmuxToolName}} wait to block the current turn until a background window finishes. It waits up to {{maxTimeoutSeconds}}s; if the task finishes in time, its result is delivered automatically as a follow-up — no need to peek or poll.",
];

const DEFAULT_HYPA_RAW_RECOVERY_GUIDELINES = [
  "When bash/completion output includes a raw .out path (or looks over-compressed/missing details), recover unfiltered output with {{tmuxToolName}} raw (window id and/or path) or the read tool on that path — do not re-run non-idempotent commands.",
];

const promptTemplateVariables = [
  "bashContextLines",
  "bashToolName",
  "defaultTimeoutAction",
  "defaultTimeoutSeconds",
  "maxOutputKb",
  "maxTimeoutSeconds",
  "outputDir",
  "tmuxToolName",
];

const timeoutOrderIsValid = (config: {
  defaultTimeoutSeconds?: number;
  maxTimeoutSeconds?: number;
}): boolean =>
  config.defaultTimeoutSeconds === undefined ||
  config.maxTimeoutSeconds === undefined ||
  config.defaultTimeoutSeconds <= config.maxTimeoutSeconds;

const nonEmptyStringSchema = z.string().trim().min(1);
const positiveIntegerSchema = z.number().int().positive();

const gitRootTmuxSessionNameTemplateSchema = templatedString({
  variables: ["gitRootSessionName"],
  missing: "keep",
}).refine(
  (template) => template.includes("{{gitRootSessionName}}"),
  'gitRootTmuxSessionNameTemplate must include "{{gitRootSessionName}}" as the git root session placeholder',
);
const promptTemplateSchema = templatedString({
  variables: promptTemplateVariables,
  missing: "keep",
})
  .trim()
  .min(1);
const promptToolEntrySchema = z.union([promptTemplateSchema, z.literal(false)]);
const promptGuidelinesSchema = z.array(promptTemplateSchema);
const tmuxActionSchema = z.enum(TMUX_ACTIONS);
const modelOutputCompressionSchema = z.enum(MODEL_OUTPUT_COMPRESSION_MODES);
const hypaCompressKindSchema = z.enum(HYPA_COMPRESS_KINDS);
const tmuxWindowNameTemplateSchema = templatedString({
  variables: ["command", "name", "nameOrCommand"],
  missing: "keep",
});

const buildTmuxBashOptionsSchema = () =>
  z
    .object({
      // When not inside a git repository, fall back to the current working directory instead of
      // erroring with "not in a git repository". Set to false to restore the original behavior.
      allowNonGitDirectories: z.boolean().default(true),
      gitRootTmuxSessionNameTemplate: gitRootTmuxSessionNameTemplateSchema.default(
        "{{gitRootSessionName}}-bg",
      ),
      tmuxSessionScope: z.enum(["git-root", "global"]).default("global"),
      globalTmuxSessionName: nonEmptyStringSchema.default("pi-background"),
      tmuxWindowScope: z.enum(["pi-session", "git-root", "all"]).default("pi-session"),
      bashToolName: nonEmptyStringSchema.default("bash"),
      tmuxToolName: nonEmptyStringSchema.default("bg_jobs"),
      tmuxEnabledActions: z
        .array(tmuxActionSchema)
        .default(() => [...DEFAULT_TMUX_ENABLED_ACTIONS]),
      bashPollIntervalEnabled: z.boolean().default(false),
      bashToolDescription: promptTemplateSchema.default(DEFAULT_BASH_TOOL_DESCRIPTION),
      tmuxToolDescription: promptTemplateSchema.default(DEFAULT_TMUX_TOOL_DESCRIPTION),
      tmuxBinary: nonEmptyStringSchema.default("tmux"),
      tmuxEnvExportDenylist: z
        .array(nonEmptyStringSchema)
        .default(() => [...DEFAULT_TMUX_ENV_EXPORT_DENYLIST]),
      foregroundBashUpdateIntervalMs: positiveIntegerSchema.default(250),
      bashContextLines: positiveIntegerSchema.default(DEFAULT_MAX_LINES),
      // Max characters of the command shown in the TUI tool-call title; 0 shows the full command.
      bashCommandDisplayLength: z.number().int().nonnegative().default(80),
      bashCompactDisplayLines: positiveIntegerSchema.default(5),
      bashTruncatedCompactDisplayLines: positiveIntegerSchema.default(2),
      bashExpandedDisplayLines: positiveIntegerSchema.default(DEFAULT_MAX_LINES),
      completedContextLines: positiveIntegerSchema.default(20),
      completedCompactDisplayLines: positiveIntegerSchema.default(5),
      completedTruncatedCompactDisplayLines: positiveIntegerSchema.default(2),
      completedExpandedDisplayLines: positiveIntegerSchema.default(20),
      pollContextLines: positiveIntegerSchema.default(30),
      pollCompactDisplayLines: positiveIntegerSchema.default(5),
      pollTruncatedCompactDisplayLines: positiveIntegerSchema.default(2),
      pollExpandedDisplayLines: positiveIntegerSchema.default(30),
      peekContextLines: positiveIntegerSchema.default(DEFAULT_MAX_LINES),
      peekCompactDisplayLines: positiveIntegerSchema.default(5),
      peekTruncatedCompactDisplayLines: positiveIntegerSchema.default(2),
      peekExpandedDisplayLines: positiveIntegerSchema.default(DEFAULT_PEEK_EXPANDED_DISPLAY_LINES),
      tmuxWindowNameTemplate: tmuxWindowNameTemplateSchema.default("{{nameOrCommand}}"),
      maxTmuxWindowNameLength: positiveIntegerSchema.default(30),
      autoCloseWindowsOnCompletion: z.boolean().default(true),
      alwaysShowOutputFilePath: z.boolean().default(false),
      preserveOutputFiles: z.boolean().default(true),
      outputDir: nonEmptyStringSchema.default("/tmp/pi-bg-jobs"),
      defaultTimeoutSeconds: positiveIntegerSchema.default(30),
      defaultTimeoutAction: z.enum(["kill", "background"]).default("background"),
      maxTimeoutSeconds: positiveIntegerSchema.default(60),
      defaultPollInterval: z.number().int().nonnegative().default(0),
      pollDelivery: z.enum(["model", "display"]).default("model"),
      minimumPollIntervalSeconds: positiveIntegerSchema.default(10),
      displayCommandStartMarker: z.string().default("# SHIM_END"),
      maxOutputBytes: positiveIntegerSchema.default(DEFAULT_MAX_BYTES),
      modelOutputCompression: modelOutputCompressionSchema.default("off"),
      hypaBinary: nonEmptyStringSchema.default("hypa"),
      hypaCompressKind: hypaCompressKindSchema.default("shell-output"),
      hypaCompressMaxTokens: z.number().int().nonnegative().default(2000),
      hypaCompressTimeoutMs: positiveIntegerSchema.default(15_000),
      hypaCompressMinBytes: z.number().int().nonnegative().default(2048),
      hypaCompressShowRawPath: z.boolean().default(true),
      unwrapHypaCommandWrapper: z.boolean().default(true),
      systemPrompt: z.boolean().default(true),
      bashSystemPromptSnippet: promptToolEntrySchema.default(DEFAULT_BASH_SYSTEM_PROMPT_SNIPPET),
      tmuxSystemPromptSnippet: promptToolEntrySchema.default(DEFAULT_TMUX_SYSTEM_PROMPT_SNIPPET),
      systemPromptGuidelines: promptGuidelinesSchema.default(() => [
        ...DEFAULT_SYSTEM_PROMPT_GUIDELINES,
        ...DEFAULT_HYPA_RAW_RECOVERY_GUIDELINES,
      ]),
    })
    .refine(timeoutOrderIsValid, {
      message: "defaultTimeoutSeconds must be less than or equal to maxTimeoutSeconds",
    });

export const TmuxBashOptionsSchema = buildTmuxBashOptionsSchema();
export const TmuxBashConfigSchema = buildTmuxBashOptionsSchema();

type ParsedTmuxBashOptions = z.input<typeof TmuxBashOptionsSchema>;
type ParsedResolvedOptions = z.output<typeof TmuxBashOptionsSchema>;

export type TmuxAction = (typeof TMUX_ACTIONS)[number];

export type TmuxBashOptions = Omit<
  ParsedTmuxBashOptions,
  "tmuxEnabledActions" | "tmuxEnvExportDenylist"
> & {
  tmuxEnabledActions?: readonly TmuxAction[];
  tmuxEnvExportDenylist?: readonly string[];
};

export type ResolvedOptions = Omit<
  ParsedResolvedOptions,
  "tmuxEnabledActions" | "tmuxEnvExportDenylist"
> & {
  tmuxEnabledActions: readonly TmuxAction[];
  tmuxEnvExportDenylist: readonly string[];
};

export const DEFAULT_OPTIONS: ResolvedOptions = TmuxBashOptionsSchema.parse({});

export const resolveOptions = (input: TmuxBashOptions = {}): ResolvedOptions =>
  TmuxBashOptionsSchema.parse(input);

// Example:
// const options = loadTmuxBashConfig();
//
// Reads ~/.pi/agent/tmux-bash.jsonc with the same schema as the extension entrypoint.
// Falls back to DEFAULT_OPTIONS for omitted config.
// Use this when another extension wants to target the same tmux session/window scope.
export const loadTmuxBashConfig = (): ResolvedOptions =>
  resolveOptions(
    loadConfigOrDefault({
      filename: "tmux-bash.jsonc",
      schema: TmuxBashConfigSchema,
    }),
  );
