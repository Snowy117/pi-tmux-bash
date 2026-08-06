import { describe, expect, it, onTestFinished } from "vitest";
import { createPiE2eWorkspace } from "./testing/pi-test-utils";
import {
  recordLatestToolResult,
  scriptedToolCall,
  scriptedToolCallWithLatestShellSessionId,
} from "./testing/scripted-provider";

describe("interactive shell Pi integration", () => {
  it("continues a shell session through two model tool calls", async () => {
    const workspace = createPiE2eWorkspace();
    onTestFinished(() => workspace.cleanup());

    const outputPath = workspace.contextOutputPath("interactive-shell");
    const result = await workspace.run({
      prompt: "run interactive shell",
      timeoutMs: 20_000,
      script: [
        scriptedToolCall("shell", {
          action: "start",
          command: "bash --noprofile --norc -i",
          waitMs: 300,
        }),
        scriptedToolCallWithLatestShellSessionId("shell", {
          action: "write",
          input: "echo integrated-shell; exit\n",
          waitMs: 1000,
        }),
        recordLatestToolResult(outputPath, { toolName: "shell", text: "done" }),
      ],
    });

    expect(result.code).toBe(0);
    expect(workspace.readContextOutput("interactive-shell")).toContain("integrated-shell");
    expect(workspace.readContextOutput("interactive-shell")).toContain("exited with code 0");
  }, 30_000);
});
