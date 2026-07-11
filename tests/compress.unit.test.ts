import { describe, expect, it } from "vitest";
import { extractHypaCompressBody, compressFileWithHypa } from "../src/compress/hypa-compress";
import { formatOutputForModel } from "../src/compress/model-output";
import { unwrapHypaCommandWrapper, resolveExecutableCommand } from "../src/compress/unwrap-command";
import { resolveOptions } from "../src/config";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("unwrapHypaCommandWrapper", () => {
  it("leaves ordinary commands unchanged", () => {
    expect(unwrapHypaCommandWrapper("pnpm test").command).toBe("pnpm test");
    expect(unwrapHypaCommandWrapper("pnpm test").unwrapped).toBe(false);
  });

  it("unwraps hypa -c double-quoted payload", () => {
    const result = unwrapHypaCommandWrapper('hypa -c "pnpm test"');
    expect(result.unwrapped).toBe(true);
    expect(result.command).toBe("pnpm test");
  });

  it("unwraps hypa -c single-quoted payload", () => {
    const result = unwrapHypaCommandWrapper("hypa -c 'echo hi'");
    expect(result.unwrapped).toBe(true);
    expect(result.command).toBe("echo hi");
  });

  it("unwraps hypa --timeout-ms N -c payload", () => {
    const result = unwrapHypaCommandWrapper('hypa --timeout-ms 5000 -c "git status"');
    expect(result.unwrapped).toBe(true);
    expect(result.command).toBe("git status");
  });

  it("does not unwrap intentional hypa subcommands", () => {
    expect(unwrapHypaCommandWrapper("hypa compress --file x").unwrapped).toBe(false);
    expect(unwrapHypaCommandWrapper("hypa git status").unwrapped).toBe(false);
    expect(unwrapHypaCommandWrapper("hypa raw ls").unwrapped).toBe(false);
  });

  it("respects resolveExecutableCommand flag", () => {
    expect(resolveExecutableCommand('hypa -c "x"', false).command).toBe('hypa -c "x"');
    expect(resolveExecutableCommand('hypa -c "x"', true).command).toBe("x");
  });
});

describe("extractHypaCompressBody", () => {
  it("extracts DETAILS section", () => {
    const stdout = [
      "SUMMARY",
      "Compressed 100 → 20 tokens (-80%).",
      "",
      "DETAILS",
      "line one",
      "line two",
      "",
      "STATS",
      "original=100 compressed=20",
    ].join("\n");
    expect(extractHypaCompressBody(stdout)).toBe("line one\nline two");
  });

  it("falls back to full stdout without DETAILS", () => {
    expect(extractHypaCompressBody("plain compressed text")).toBe("plain compressed text");
  });
});

describe("compressFileWithHypa", () => {
  it("builds compress args and returns body", async () => {
    const result = await compressFileWithHypa("/tmp/raw.out", {
      binary: "hypa",
      kind: "shell-output",
      maxTokens: 100,
      timeoutMs: 1000,
      exec: async (bin, args) => {
        expect(bin).toBe("hypa");
        expect(args).toEqual([
          "compress",
          "--file",
          "/tmp/raw.out",
          "--kind",
          "shell-output",
          "--max-tokens",
          "100",
        ]);
        return {
          stdout: "SUMMARY\nok\n\nDETAILS\ncompressed-body\n\nSTATS\nx=1",
          stderr: "",
          code: 0,
        };
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.text).toBe("compressed-body");
  });

  it("fails on non-zero exit", async () => {
    const result = await compressFileWithHypa("/tmp/raw.out", {
      binary: "hypa",
      timeoutMs: 1000,
      exec: async () => ({ stdout: "", stderr: "boom", code: 2 }),
    });
    expect(result.ok).toBe(false);
  });
});

describe("formatOutputForModel", () => {
  const writeRaw = (content: string): string => {
    const dir = mkdtempSync(join(tmpdir(), "tmux-bash-compress-"));
    const path = join(dir, "raw.out");
    writeFileSync(path, content, "utf8");
    return path;
  };

  it("skips hypa when compression is off", async () => {
    let called = false;
    const raw = "x".repeat(5000);
    const path = writeRaw(raw);
    const output = await formatOutputForModel({
      rawText: raw,
      rawFilePath: path,
      options: resolveOptions({ modelOutputCompression: "off" }),
      contextLines: 2000,
      exec: async () => {
        called = true;
        return { stdout: "", stderr: "", code: 0 };
      },
    });
    expect(called).toBe(false);
    expect(output.text).toContain("x");
  });

  it("skips hypa when under min bytes", async () => {
    let called = false;
    const raw = "small";
    const path = writeRaw(raw);
    const output = await formatOutputForModel({
      rawText: raw,
      rawFilePath: path,
      options: resolveOptions({
        modelOutputCompression: "hypa",
        hypaCompressMinBytes: 2048,
      }),
      contextLines: 2000,
      exec: async () => {
        called = true;
        return { stdout: "", stderr: "", code: 0 };
      },
    });
    expect(called).toBe(false);
    expect(output.text).toBe("small");
  });

  it("compresses large raw output for the model", async () => {
    const raw = "y".repeat(3000);
    const path = writeRaw(raw);
    const output = await formatOutputForModel({
      rawText: raw,
      rawFilePath: path,
      options: resolveOptions({
        modelOutputCompression: "hypa",
        hypaCompressMinBytes: 100,
        hypaCompressShowRawPath: true,
        tmuxToolName: "bg_jobs",
      }),
      contextLines: 2000,
      windowId: "@9",
      exec: async () => ({
        stdout: "SUMMARY\n\nDETAILS\nCOMPRESSED\n\nSTATS\n",
        stderr: "",
        code: 0,
      }),
    });
    expect(output.text).toContain("COMPRESSED");
    expect(output.text).toContain(`[raw output: ${path} window=@9]`);
    expect(output.text).not.toContain("[Full output:");
  });

  it("falls back to raw when hypa fails", async () => {
    const raw = "z".repeat(3000);
    const path = writeRaw(raw);
    const output = await formatOutputForModel({
      rawText: raw,
      rawFilePath: path,
      options: resolveOptions({
        modelOutputCompression: "hypa",
        hypaCompressMinBytes: 100,
      }),
      contextLines: 2000,
      exec: async () => ({ stdout: "", stderr: "fail", code: 1 }),
    });
    expect(output.text).toContain("z");
  });
});
