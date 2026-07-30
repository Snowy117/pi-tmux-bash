import { spawnSync } from "node:child_process";
import {
  closeSync,
  ftruncateSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { readOutputFileTail } from "../src/runtime";

const tempDirs: string[] = [];

const createTempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "tmux-bash-runtime-"));
  tempDirs.push(dir);
  return dir;
};

afterEach(() => {
  tempDirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

describe("output file tail reading", () => {
  it("reads a bounded tail from files larger than the V8 string limit", () => {
    const path = join(createTempDir(), "huge.out");
    const size = 0x20000020;
    const marker = Buffer.from("last output line\n");
    const file = openSync(path, "w");
    ftruncateSync(file, size);
    writeSync(file, marker, 0, marker.length, size - marker.length);
    closeSync(file);

    const output = readOutputFileTail(path, 64);

    expect(output?.sourceBytes).toBe(size);
    expect(output?.sourceTruncated).toBe(true);
    expect(output?.text.endsWith(marker.toString("utf8"))).toBe(true);
    expect(Buffer.byteLength(output?.text ?? "", "utf8")).toBeLessThanOrEqual(67);
  });

  it("starts decoding after a partial UTF-8 character", () => {
    const path = join(createTempDir(), "utf8.out");
    const size = 2 * 1024 * 1024;
    const marker = Buffer.from("😀tail", "utf8");
    const file = openSync(path, "w");
    ftruncateSync(file, size);
    writeSync(file, marker, 0, marker.length, size - marker.length);
    closeSync(file);

    const output = readOutputFileTail(path, 4);

    expect(output?.text).toBe("tail");
    expect(output?.text).not.toContain("�");
    expect(output?.sourceTruncated).toBe(true);
  });

  it("does not decode an incomplete UTF-8 character still being written", () => {
    const path = join(createTempDir(), "growing-utf8.out");
    writeFileSync(path, Buffer.from([0x61, 0xf0, 0x9f]));

    const output = readOutputFileTail(path, 64);

    expect(output?.text).toBe("a");
    expect(output?.text).not.toContain("�");
  });
});

describe("git root detection", () => {
  it("does not leak git's non-repository diagnostic to stderr", () => {
    const cwd = createTempDir();
    const moduleUrl = pathToFileURL(resolve("src/tmux-utils.ts")).href;
    const script = `import { getGitRoot } from ${JSON.stringify(moduleUrl)}; console.log(JSON.stringify(getGitRoot(process.cwd())));`;

    const tsx = resolve("node_modules/.bin/tsx");
    const result = spawnSync(tsx, ["--eval", script], {
      cwd,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("null");
    expect(result.stderr).toBe("");
  });
});
