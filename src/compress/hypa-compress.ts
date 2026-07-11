import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { platform } from "node:os";

const execFileAsync = promisify(execFile);

export type HypaExecResult = {
  stdout: string;
  stderr: string;
  code: number;
  killed?: boolean;
};

export type HypaExecFn = (
  command: string,
  args: string[],
  options?: { timeout?: number },
) => Promise<HypaExecResult>;

export type HypaCompressOptions = {
  binary: string;
  kind?: string;
  maxTokens?: number;
  timeoutMs: number;
  exec?: HypaExecFn;
};

export type HypaCompressResult =
  | { ok: true; text: string; durationMs: number }
  | { ok: false; error: string };

export const extractHypaCompressBody = (stdout: string): string => {
  const trimmed = stdout.replace(/\r\n/g, "\n").trim();
  if (!trimmed) return "";

  const detailsMarker = "\nDETAILS\n";
  const detailsIndex = trimmed.indexOf(detailsMarker);
  const detailsStart =
    detailsIndex >= 0
      ? detailsIndex + detailsMarker.length
      : trimmed.startsWith("DETAILS\n")
        ? "DETAILS\n".length
        : -1;

  if (detailsStart >= 0) {
    const rest = trimmed.slice(detailsStart);
    const statsIndex = rest.search(/\n\nSTATS\n/);
    const body = (statsIndex >= 0 ? rest.slice(0, statsIndex) : rest).trimEnd();
    if (body) return body;
  }

  return trimmed;
};

export const getHypaExecArgs = (
  binary: string,
  args: string[],
  platformName: NodeJS.Platform = platform(),
  jsRuntime: string = process.execPath,
): [string, string[]] => {
  const lower = binary.toLowerCase();
  if (lower.endsWith(".js")) return [jsRuntime, [binary, ...args]];
  if (platformName === "win32" && (lower.endsWith(".cmd") || lower.endsWith(".bat"))) {
    return ["cmd", ["/c", binary, ...args]];
  }
  return [binary, args];
};

const defaultExec: HypaExecFn = async (command, args, options) => {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      encoding: "utf-8",
      timeout: options?.timeout,
      maxBuffer: 20 * 1024 * 1024,
      windowsHide: true,
    });
    return { stdout: stdout ?? "", stderr: stderr ?? "", code: 0 };
  } catch (error) {
    const err = error as {
      code?: string | number;
      killed?: boolean;
      stdout?: string;
      stderr?: string;
      message?: string;
    };

    if (err.killed || err.code === "ETIMEDOUT") {
      return {
        stdout: err.stdout ?? "",
        stderr: err.stderr ?? err.message ?? "timed out",
        code: 1,
        killed: true,
      };
    }

    const exitCode = typeof err.code === "number" ? err.code : 1;
    return {
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? err.message ?? String(error),
      code: exitCode,
    };
  }
};

export async function compressFileWithHypa(
  filePath: string,
  options: HypaCompressOptions,
): Promise<HypaCompressResult> {
  const started = Date.now();
  const args = ["compress", "--file", filePath];
  if (options.kind) args.push("--kind", options.kind);
  if (options.maxTokens !== undefined && options.maxTokens > 0) {
    args.push("--max-tokens", String(options.maxTokens));
  }

  const [bin, execArgs] = getHypaExecArgs(options.binary, args);
  const exec = options.exec ?? defaultExec;

  try {
    const result = await exec(bin, execArgs, { timeout: options.timeoutMs });
    if (result.killed) {
      return { ok: false, error: `hypa compress timed out after ${options.timeoutMs}ms` };
    }
    if (result.code !== 0) {
      const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`;
      return { ok: false, error: `hypa compress failed: ${detail}` };
    }

    const body = extractHypaCompressBody(result.stdout);
    if (!body) {
      return { ok: false, error: "hypa compress produced empty output" };
    }

    return { ok: true, text: body, durationMs: Date.now() - started };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message };
  }
}
