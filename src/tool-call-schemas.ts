import { defineZodToolCall } from "@richardgill/pi-zod-tool-call";
import { z } from "zod";
import type { TmuxAction } from "./config";

type SchemaOptions = {
  bashToolName: string;
  shellToolName?: string;
  tmuxToolName: string;
  defaultTimeoutSeconds: number;
  defaultTimeoutAction: "kill" | "background";
  maxTimeoutSeconds: number;
  defaultPollInterval: number;
  pollContextLines: number;
  tmuxEnabledActions: readonly TmuxAction[];
  bashPollIntervalEnabled: boolean;
  shellDefaultWaitMs?: number;
  shellMaxWaitMs?: number;
};

type InvalidInput<TInvalidResult> = (message: string) => TInvalidResult;

const command = z.string().min(1).describe("Bash command to execute.");
const name = z.string().optional().describe("Optional background window name.");
const backgroundFalse = z.literal(false).optional();
const tmuxWindowId = z
  .string()
  .regex(/^@\d+$/)
  .describe("Background window id, e.g. @123.");
const tmuxAction = <TAction extends string>(action: TAction) =>
  z.literal(action).describe("Action.");

const timeout = (options: SchemaOptions) =>
  z
    .number()
    .int()
    .positive()
    .max(options.maxTimeoutSeconds)
    .default(options.defaultTimeoutSeconds)
    .describe("Seconds before timeoutAction.");

const pollInterval = (options: SchemaOptions) =>
  z
    .number()
    .int()
    .nonnegative()
    .default(options.defaultPollInterval)
    .describe("Seconds between background check-ins.");

const pollLines = (options: SchemaOptions) =>
  z
    .number()
    .int()
    .positive()
    .default(options.pollContextLines)
    .describe("Lines captured per check-in.");

const backgroundTimeoutAction = z
  .enum(["kill", "background"])
  .optional()
  .describe('"kill" or "background" on timeout.');

const foregroundTimeoutAction = (options: SchemaOptions) =>
  z
    .enum(["kill", "background"])
    .default(options.defaultTimeoutAction)
    .describe('"kill" or "background" on timeout.');

const background = z.literal(true).describe("Return immediately and keep running in the background.");

const bashPollProperties = (options: SchemaOptions) =>
  options.bashPollIntervalEnabled
    ? { pollInterval: pollInterval(options), pollLines: pollLines(options) }
    : {};

type BackgroundBashInput = {
  command: string;
  name?: string;
  background: true;
  timeout: number;
  timeoutAction?: "kill" | "background";
  pollInterval?: number;
  pollLines?: number;
};

type ForegroundBashInput = {
  command: string;
  name?: string;
  background?: false;
  timeout: number;
  timeoutAction: "kill" | "background";
  pollInterval?: number;
  pollLines?: number;
};

export type BashInput = BackgroundBashInput | ForegroundBashInput;

export type TmuxInput =
  | { action: "list" }
  | { action: "kill"; window: string }
  | { action: "list-polls" }
  | { action: "peek"; window: string }
  | { action: "raw"; window?: string; path?: string }
  | { action: "poll"; window: string; pollInterval: number; pollLines: number }
  | { action: "unpoll"; window: string }
  | { action: "wait"; window: string };

export type ShellSignal = "SIGINT" | "EOF" | "SIGTERM";

export type ShellInput =
  | {
      action: "start";
      command: string;
      name?: string;
      waitMs: number;
    }
  | {
      action: "write";
      sessionId: string;
      input: string;
      signal?: ShellSignal;
      waitMs: number;
    }
  | {
      action: "kill";
      sessionId: string;
    };

const buildBashInputSchema = (options: SchemaOptions): z.ZodType<BashInput> => {
  const pollProperties = bashPollProperties(options);

  return z.union([
    z.object({
      command,
      name,
      background,
      timeout: timeout(options),
      timeoutAction: backgroundTimeoutAction,
      ...pollProperties,
    }),
    z.object({
      command,
      name,
      background: backgroundFalse,
      timeout: timeout(options),
      timeoutAction: foregroundTimeoutAction(options),
      ...pollProperties,
    }),
  ]) as unknown as z.ZodType<BashInput>;
};

const tmuxInputSchemas = (options: SchemaOptions) => ({
  list: z.object({ action: tmuxAction("list") }),
  kill: z.object({ action: tmuxAction("kill"), window: tmuxWindowId }),
  "list-polls": z.object({ action: tmuxAction("list-polls") }),
  peek: z.object({ action: tmuxAction("peek"), window: tmuxWindowId }),
  raw: z
    .object({
      action: tmuxAction("raw"),
      window: tmuxWindowId.optional().describe("Stable window id like @123 when still listed."),
      path: z
        .string()
        .min(1)
        .optional()
        .describe("Absolute path to a bash tee .out file under the configured outputDir."),
    })
    .refine((value) => Boolean(value.window || value.path), {
      message: "raw requires window and/or path",
    }),
  poll: z.object({
    action: tmuxAction("poll"),
    window: tmuxWindowId,
    pollInterval: z
      .number()
      .int()
      .nonnegative()
      .default(options.defaultPollInterval)
      .describe("Seconds between check-ins."),
    pollLines: z
      .number()
      .int()
      .positive()
      .default(options.pollContextLines)
      .describe("Lines captured per check-in."),
  }),
  unpoll: z.object({ action: tmuxAction("unpoll"), window: tmuxWindowId }),
  wait: z.object({ action: tmuxAction("wait"), window: tmuxWindowId }),
});

const buildTmuxInputSchema = (options: SchemaOptions): z.ZodType<TmuxInput> => {
  const schemas = tmuxInputSchemas(options);
  const enabledSchemas = options.tmuxEnabledActions.map((action) => schemas[action]);
  const [firstSchema, ...remainingSchemas] = enabledSchemas;

  if (!firstSchema) return z.never() as z.ZodType<TmuxInput>;
  if (remainingSchemas.length === 0) return firstSchema as z.ZodType<TmuxInput>;

  return z.discriminatedUnion("action", [firstSchema, ...remainingSchemas]) as z.ZodType<TmuxInput>;
};

const shellWaitMs = (options: SchemaOptions) =>
  z
    .number()
    .int()
    .nonnegative()
    .max(options.shellMaxWaitMs ?? 10000)
    .default(options.shellDefaultWaitMs ?? 1000)
    .describe("Milliseconds to wait for output or process completion before returning.");

const shellSessionId = z
  .string()
  .regex(/^sh_[a-f0-9]{12}$/)
  .describe("Interactive shell session id returned by action start.");

const buildShellInputSchema = (options: SchemaOptions): z.ZodType<ShellInput> =>
  z.discriminatedUnion("action", [
    z.object({
      action: z.literal("start"),
      command: z
        .string()
        .min(1)
        .describe("Bash command to start in a persistent tmux PTY. Keep it concise and avoid complex Bash syntax."),
      name,
      waitMs: shellWaitMs(options),
    }),
    z.object({
      action: z.literal("write"),
      sessionId: shellSessionId,
      input: z
        .string()
        .max(65536)
        .default("")
        .describe("Literal input to send. Use an empty string to poll for new output."),
      signal: z
        .enum(["SIGINT", "EOF", "SIGTERM"])
        .optional()
        .describe("Optional control signal: SIGINT sends Ctrl-C, EOF sends Ctrl-D, SIGTERM stops the session."),
      waitMs: shellWaitMs(options),
    }),
    z.object({
      action: z.literal("kill"),
      sessionId: shellSessionId,
    }),
  ]) as z.ZodType<ShellInput>;

export const buildBashToolCallSchema = <TInvalidResult>(
  options: SchemaOptions,
  invalidInput: InvalidInput<TInvalidResult>,
) =>
  defineZodToolCall({
    toolName: options.bashToolName,
    zodSchema: buildBashInputSchema(options),
    invalidInput,
  });

export const buildTmuxToolCallSchema = <TInvalidResult>(
  options: SchemaOptions,
  invalidInput: InvalidInput<TInvalidResult>,
) =>
  defineZodToolCall({
    toolName: options.tmuxToolName,
    zodSchema: buildTmuxInputSchema(options),
    invalidInput,
  });

export const buildShellToolCallSchema = <TInvalidResult>(
  options: SchemaOptions,
  invalidInput: InvalidInput<TInvalidResult>,
) =>
  defineZodToolCall({
    toolName: options.shellToolName ?? "shell",
    zodSchema: buildShellInputSchema(options),
    invalidInput,
  });
