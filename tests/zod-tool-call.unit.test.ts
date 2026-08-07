import { describe, expect, it } from "vitest";
import { TMUX_ACTIONS } from "../src/config";
import { buildBashToolCallSchema, buildShellToolCallSchema } from "../src/tool-call-schemas";

type TestOptions = Parameters<typeof buildBashToolCallSchema>[0];

const options: TestOptions = {
  bashToolName: "bash",
  tmuxToolName: "tmux",
  defaultTimeoutSeconds: 30,
  defaultTimeoutAction: "background",
  maxTimeoutSeconds: 60,
  defaultPollInterval: 0,
  pollContextLines: 30,
  tmuxEnabledActions: TMUX_ACTIONS,
  bashPollIntervalEnabled: true,
};

const invalidInput = (message: string) => ({ error: message });
const bashToolCallSchema = (overrides: Partial<typeof options> = {}) =>
  buildBashToolCallSchema({ ...options, ...overrides }, invalidInput);

describe("zod tool call schema generation", () => {
  it("generates top-level object schemas without top-level unions", () => {
    const schema = bashToolCallSchema().typeBoxSchema;

    expect(schema.type).toBe("object");
    expect(schema.oneOf).toBeUndefined();
    expect(schema.anyOf).toBeUndefined();
    expect(schema.allOf).toBeUndefined();
  });

  it("keeps only fields required in every union variant", () => {
    const schema = bashToolCallSchema().typeBoxSchema;

    expect(schema.required).toEqual(["command"]);
  });

  it("loosens discriminators for provider compatibility", () => {
    const schema = bashToolCallSchema().typeBoxSchema;

    expect(schema.properties.background.type).toBe("boolean");
    expect(schema.properties.background.const).toBeUndefined();
    expect(schema.properties.timeoutAction.enum).toEqual(
      expect.arrayContaining(["background", "kill"]),
    );
  });

  it("preserves useful descriptions and defaults", () => {
    const schema = bashToolCallSchema().typeBoxSchema;

    expect(schema.properties.command.description).toContain("Bash command");
    expect(schema.properties.timeout.default).toBe(30);
    expect(schema.properties.timeoutAction.default).toBe("background");
    expect(schema.properties.pollLines.default).toBe(30);
  });

  it.each(["background", "kill"] as const)(
    "defaults omitted timeoutAction to %s",
    async (defaultTimeoutAction) => {
      const result = await bashToolCallSchema({ defaultTimeoutAction }).handleInput(
        { command: "sleep 10" },
        (input) => input,
      );

      expect(result).toMatchObject({ timeoutAction: defaultTimeoutAction });
    },
  );

  it.each([
    ["explicit kill timeout action", { command: "sleep 10", timeoutAction: "kill" }, "kill"],
    [
      "explicit background timeout action",
      { command: "sleep 10", timeoutAction: "background" },
      "background",
    ],
  ])("parses %s", async (_name, input, timeoutActionValue) => {
    const result = await bashToolCallSchema().handleInput(input, (parsed) => parsed);

    expect(result).toMatchObject({ timeoutAction: timeoutActionValue });
  });

  it("parses background true without defaulting timeoutAction", async () => {
    const result = await bashToolCallSchema().handleInput(
      { command: "sleep 10", background: true },
      (input) => input,
    );

    expect(result).toMatchObject({ background: true });
    expect(result).not.toHaveProperty("timeoutAction");
  });

  it("rejects invalid timeoutAction", async () => {
    const result = await bashToolCallSchema().handleInput(
      { command: "sleep 10", timeoutAction: "wait" },
      (input) => input,
    );

    expect(result).toEqual({ error: expect.stringContaining("Invalid bash input") });
  });

  it("handleInput returns invalidInput result on zod failure", async () => {
    const result = await bashToolCallSchema().handleInput({ command: "" }, () => ({ ok: true }));

    expect(result).toEqual({ error: expect.stringContaining("Invalid bash input") });
  });
});

describe("interactive shell schema generation", () => {
  const shellToolCallSchema = (overrides: Partial<typeof options> = {}) =>
    buildShellToolCallSchema(
      {
        ...options,
        shellToolName: "shell",
        shellDefaultWaitMs: 1000,
        shellMaxWaitMs: 5000,
        ...overrides,
      },
      invalidInput,
    );

  it("advertises action-specific parameter variants", () => {
    const schema = shellToolCallSchema().typeBoxSchema;
    const variants = schema.oneOf as Record<string, any>[];
    const variant = (action: string) =>
      variants.find((candidate) => candidate.properties.action.enum.includes(action));

    expect(schema.type).toBe("object");
    expect(schema.properties).toBeUndefined();
    expect(variants).toHaveLength(3);

    expect(Object.keys(variant("start")?.properties ?? {})).toEqual([
      "action",
      "command",
      "name",
      "waitMs",
    ]);
    expect(variant("start")?.required).toEqual(["action", "command"]);
    expect(variant("start")?.properties.waitMs.default).toBe(1000);

    expect(Object.keys(variant("write")?.properties ?? {})).toEqual([
      "action",
      "sessionId",
      "input",
      "signal",
      "waitMs",
    ]);
    expect(variant("write")?.required).toEqual(["action", "sessionId"]);
    expect(variant("write")?.properties.input.default).toBe("");
    expect(variant("write")?.properties.waitMs.default).toBe(1000);

    expect(Object.keys(variant("kill")?.properties ?? {})).toEqual(["action", "sessionId"]);
    expect(variant("kill")?.required).toEqual(["action", "sessionId"]);
  });

  it("uses enum discriminators instead of const", () => {
    const variants = shellToolCallSchema().typeBoxSchema.oneOf as Record<string, any>[];

    expect(variants.map((variant) => variant.properties.action.enum)).toEqual([
      ["start"],
      ["write"],
      ["kill"],
    ]);
    expect(variants.every((variant) => variant.properties.action.const === undefined)).toBe(true);
    expect(variants.every((variant) => variant.additionalProperties === false)).toBe(true);
  });

  it("defaults write input to an empty poll", async () => {
    const result = await shellToolCallSchema().handleInput(
      { action: "write", sessionId: "sh_0123456789ab" },
      (input) => input,
    );

    expect(result).toMatchObject({
      action: "write",
      sessionId: "sh_0123456789ab",
      input: "",
      waitMs: 1000,
    });
  });

  it("keeps runtime parsing action-specific", async () => {
    const startResult = await shellToolCallSchema().handleInput(
      {
        action: "start",
        command: "printf hi",
        sessionId: "sh_0123456789ab",
        input: "unexpected",
        signal: "SIGINT",
      },
      (input) => input,
    );
    const killResult = await shellToolCallSchema().handleInput(
      { action: "kill", sessionId: "sh_0123456789ab" },
      (input) => input,
    );

    expect(startResult).toEqual({ action: "start", command: "printf hi", waitMs: 1000 });
    expect(killResult).toEqual({ action: "kill", sessionId: "sh_0123456789ab" });
  });

  it.each([
    ["start without a command", { action: "start" }],
    ["write without a session id", { action: "write", input: "echo hi\n" }],
    ["kill without a session id", { action: "kill" }],
  ])("rejects %s", async (_name, input) => {
    const result = await shellToolCallSchema().handleInput(input, (parsed) => parsed);

    expect(result).toEqual({ error: expect.stringContaining("Invalid shell input") });
  });

  it("rejects invalid signals and wait times", async () => {
    const invalidSignal = await shellToolCallSchema().handleInput(
      { action: "write", sessionId: "sh_0123456789ab", signal: "SIGHUP" },
      (input) => input,
    );
    const invalidWaitTime = await shellToolCallSchema().handleInput(
      { action: "start", command: "printf hi", waitMs: 5001 },
      (input) => input,
    );

    expect(invalidSignal).toEqual({ error: expect.stringContaining("Invalid shell input") });
    expect(invalidWaitTime).toEqual({ error: expect.stringContaining("Invalid shell input") });
  });

  it("rejects malformed session ids", async () => {
    const result = await shellToolCallSchema().handleInput(
      { action: "write", sessionId: "@123", input: "echo hi\n" },
      (input) => input,
    );

    expect(result).toEqual({ error: expect.stringContaining("Invalid shell input") });
  });
});
