import type { ResolvedOptions } from "../config";
import { formatTmuxOutputForContext, type FormattedOutput } from "../render";
import { compressFileWithHypa, type HypaExecFn } from "./hypa-compress";

export type FormatOutputForModelArgs = {
  rawText: string;
  rawFilePath?: string;
  options: ResolvedOptions;
  contextLines: number;
  exec?: HypaExecFn;
  emptyText?: string;
  windowId?: string;
};

const byteLength = (text: string): number => Buffer.byteLength(text, "utf-8");

export const formatRawRecoveryHint = (
  rawFilePath: string | undefined,
  options: Pick<ResolvedOptions, "hypaCompressShowRawPath">,
  windowId?: string,
): string | undefined => {
  if (!options.hypaCompressShowRawPath || !rawFilePath) return undefined;

  const windowPart = windowId ? ` window=${windowId}` : "";
  return `[raw output: ${rawFilePath}${windowPart}]`;
};

const appendRawRecoveryHint = (
  text: string,
  rawFilePath: string | undefined,
  options: ResolvedOptions,
  windowId?: string,
): string => {
  const hint = formatRawRecoveryHint(rawFilePath, options, windowId);
  if (!hint) return text;
  if (rawFilePath && text.includes(`[raw output: ${rawFilePath}`)) return text;
  return `${text.trimEnd()}\n\n${hint}`;
};

export async function formatOutputForModel({
  rawText,
  rawFilePath,
  options,
  contextLines,
  exec,
  emptyText = "(no output)",
  windowId,
}: FormatOutputForModelArgs): Promise<FormattedOutput> {
  const baseFormat = (content: string, showFullOutputPath = options.alwaysShowOutputFilePath) =>
    formatTmuxOutputForContext(content, {
      fullOutputPath: rawFilePath,
      emptyText,
      showFullOutputPath,
      truncationOptions: {
        maxLines: contextLines,
        maxBytes: options.maxOutputBytes,
      },
    });

  if (options.modelOutputCompression !== "hypa") {
    return baseFormat(rawText);
  }

  if (byteLength(rawText) < options.hypaCompressMinBytes || !rawFilePath) {
    return baseFormat(rawText);
  }

  const compressResult = await compressFileWithHypa(rawFilePath, {
    binary: options.hypaBinary,
    kind: options.hypaCompressKind,
    maxTokens: options.hypaCompressMaxTokens > 0 ? options.hypaCompressMaxTokens : undefined,
    timeoutMs: options.hypaCompressTimeoutMs,
    exec,
  });

  if (!compressResult.ok) {
    const failed = baseFormat(rawText, options.alwaysShowOutputFilePath);
    const withHint = appendRawRecoveryHint(failed.text, rawFilePath, options, windowId);
    return withHint === failed.text ? failed : { ...failed, text: withHint };
  }

  const withHint = appendRawRecoveryHint(compressResult.text, rawFilePath, options, windowId);
  return baseFormat(withHint, options.alwaysShowOutputFilePath);
}
