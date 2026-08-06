import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, onTestFinished } from "vitest";
import { resolveOptions } from "../src/config";
import { executeInteractiveShell } from "../src/interactive-shell";
import { cleanupState, createState, resetRunDir } from "../src/state";
import type { ShellInput } from "../src/tool-call-schemas";
import { calcTmuxSessionName } from "../src/tmux-utils";
import { createPiTestWorkspace } from "./testing/pi-test-workspace";

type ShellResult = {
  content: { type: string; text?: string }[];
  details: {
    sessionId: string;
    status: "running" | "exited" | "killed";
    exitCode?: number;
  };
};

const resultText = (result: ShellResult): string => result.content[0]?.text ?? "";

const createHarness = () => {
  const workspace = createPiTestWorkspace();
  const options = resolveOptions(workspace.tmuxBashConfig);
  const state = createState();
  const sessionId = "interactive-shell-test";
  resetRunDir(state, options, sessionId);
  workspace.trackTmuxSession(calcTmuxSessionName(workspace.projectDir, options));
  const ctx = {
    cwd: workspace.projectDir,
    sessionManager: { getSessionId: () => sessionId },
  } as unknown as ExtensionContext;

  onTestFinished(() => {
    cleanupState(state, options);
    workspace.cleanup();
  });

  return { options, state, ctx };
};

const runShell = async (
  input: ShellInput,
  harness: ReturnType<typeof createHarness>,
): Promise<ShellResult> =>
  (await executeInteractiveShell(input, harness.ctx, harness.state, harness.options)) as ShellResult;

describe("interactive shell sessions", () => {
  it("keeps a bash PTY alive across writes and reports its exit code", async () => {
    const harness = createHarness();
    const started = await runShell(
      { action: "start", command: "bash --noprofile --norc -i", waitMs: 500 },
      harness,
    );
    expect(started.details.status).toBe("running");

    const sessionId = started.details.sessionId;
    const changedDirectory = await runShell(
      { action: "write", sessionId, input: "cd /tmp\n", waitMs: 500 },
      harness,
    );
    expect(changedDirectory.details.status).toBe("running");

    const printedDirectory = await runShell(
      { action: "write", sessionId, input: "pwd\n", waitMs: 500 },
      harness,
    );
    expect(resultText(printedDirectory)).toContain("/tmp");

    const exited = await runShell(
      { action: "write", sessionId, input: "exit 7\n", waitMs: 1000 },
      harness,
    );
    expect(exited.details).toMatchObject({ status: "exited", exitCode: 7 });
  }, 15_000);

  it("passes stdin to a command that waits for input", async () => {
    const harness = createHarness();
    const started = await runShell(
      {
        action: "start",
        command: "read value; printf 'received:%s\\n' \"$value\"",
        waitMs: 200,
      },
      harness,
    );
    const result = await runShell(
      {
        action: "write",
        sessionId: started.details.sessionId,
        input: "answer\n",
        waitMs: 1000,
      },
      harness,
    );

    expect(result.details).toMatchObject({ status: "exited", exitCode: 0 });
    expect(resultText(result)).toContain("received:answer");
  }, 15_000);

  it("kills a running session", async () => {
    const harness = createHarness();
    const started = await runShell(
      { action: "start", command: "sleep 30", waitMs: 200 },
      harness,
    );
    const killed = await runShell(
      { action: "kill", sessionId: started.details.sessionId },
      harness,
    );

    expect(killed.details.status).toBe("killed");
  }, 15_000);

  it("delivers SIGINT to the foreground process group", async () => {
    const harness = createHarness();
    const started = await runShell(
      { action: "start", command: "sleep 30", waitMs: 200 },
      harness,
    );
    const interrupted = await runShell(
      {
        action: "write",
        sessionId: started.details.sessionId,
        input: "",
        signal: "SIGINT",
        waitMs: 1000,
      },
      harness,
    );

    expect(interrupted.details).toMatchObject({ status: "exited", exitCode: 130 });
  }, 15_000);
});
