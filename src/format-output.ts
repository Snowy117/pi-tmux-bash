import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateTail, keyText, type TruncationOptions, type TruncationResult } from "@earendil-works/pi-coding-agent";
import { DEFAULT_OPTIONS, type ResolvedOptions } from "./config";
import { resolveSanitizeOptions, sanitizePlainText, type SanitizeOptions } from "./sanitize";

export { resolveSanitizeOptions, sanitizePlainText, type SanitizeOptions };

export type BashOutputRenderLine =
  | { kind: "output"; text: string }
  | { kind: "fullOutputNotice"; text: string; displayText: string }
  | { kind: "truncationNotice"; text: string }
  | { kind: "collapsedElision"; text: string; prefix: string; key: string; suffix: string }
  | { kind: "expandedElision"; text: string };

export type BashOutputRenderDetails = {
  lines: BashOutputRenderLine[];
  empty: boolean;
};

export type TmuxBashToolDetails = {
  truncation?: TruncationResult;
  fullOutputPath?: string;
  outcome?: "timed-out-background";
  sourceBytes?: number;
  sourceTruncated?: boolean;
  render: BashOutputRenderDetails;
};

export type FormattedOutput = {
  text: string;
  details: TmuxBashToolDetails;
};

export type BashResultFormatOptions = {
  expanded: boolean;
  compactDisplayLines?: number;
  expandedDisplayLines?: number;
  truncatedCompactDisplayLines?: number;
};

export type FormatTmuxOutputOptions = {
  fullOutputPath?: string;
  emptyText?: string;
  showFullOutputPath?: boolean;
  sourceBytes?: number;
  sourceTruncated?: boolean;
  truncationOptions?: TruncationOptions;
  sanitizeOptions?: SanitizeOptions;
};

const lastLineBytes = (content: string): number =>
  Buffer.byteLength(content.split("\n").at(-1) ?? "", "utf-8");

const exceedsLineLimit = (content: string, maxLines: number | undefined): boolean =>
  maxLines !== undefined && content.split("\n").length > maxLines;

export const outputRenderDetails = (content: string, empty = false): BashOutputRenderDetails => ({
  lines: stripTrailingEmptyLines(content.split("\n")).map((text) => ({ kind: "output", text })),
  empty,
});

const fullOutputNoticeLine = (fullOutputPath: string): BashOutputRenderLine => ({
  kind: "fullOutputNotice",
  text: `[Full output: ${fullOutputPath}]`,
  displayText: `Full output: ${fullOutputPath}`,
});

const truncationNotice = (
  content: string,
  truncation: TruncationResult,
  fullOutputPath: string | undefined,
): string => {
  const startLine = truncation.totalLines - truncation.outputLines + 1;
  const endLine = truncation.totalLines;
  const suffix = fullOutputPath ? `. Full output: ${fullOutputPath}` : "";

  if (truncation.lastLinePartial) {
    const lineSize = formatSize(lastLineBytes(content));
    return `[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${lineSize})${suffix}]`;
  }

  if (truncation.truncatedBy === "lines") {
    return `[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}${suffix}]`;
  }

  return `[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)${suffix}]`;
};

const sourceTailNotice = (sourceBytes: number | undefined, fullOutputPath: string | undefined) => {
  const size = sourceBytes === undefined ? "" : ` of ${formatSize(sourceBytes)} output`;
  const suffix = fullOutputPath ? `. Full output: ${fullOutputPath}` : "";
  return `[Showing tail${size}${suffix}]`;
};

const stripTrailingEmptyLines = (lines: string[]): string[] => {
  const reversedLastContentIndex = [...lines].reverse().findIndex((line) => line.trim() !== "");
  if (reversedLastContentIndex === -1) return [];

  return lines.slice(0, lines.length - reversedLastContentIndex);
};

export const formatTmuxOutputForContext = (
  content: string,
  {
    fullOutputPath,
    emptyText = "(no output)",
    showFullOutputPath = false,
    sourceBytes,
    sourceTruncated = false,
    truncationOptions = {},
    sanitizeOptions = resolveSanitizeOptions(DEFAULT_OPTIONS),
  }: FormatTmuxOutputOptions = {},
): FormattedOutput => {
  const empty = !content.trim();
  const text = content.trim() || emptyText;
  const maxBytes = truncationOptions.maxBytes ?? DEFAULT_MAX_BYTES;
  const useRawSingleOversizedLine =
    content.endsWith("\n") && !text.includes("\n") && Buffer.byteLength(text, "utf-8") > maxBytes;
  const useRawLineTruncation = exceedsLineLimit(content, truncationOptions.maxLines);
  const truncationInput = useRawSingleOversizedLine || useRawLineTruncation ? content : text;
  const truncation = truncateTail(truncationInput, truncationOptions);
  const output = truncation.truncated ? truncation.content || emptyText : text;
  const notice: BashOutputRenderLine | undefined = sourceTruncated
    ? { kind: "truncationNotice", text: sourceTailNotice(sourceBytes, fullOutputPath) }
    : truncation.truncated
    ? {
        kind: "truncationNotice",
        text: truncationNotice(truncationInput, truncation, fullOutputPath),
      }
    : showFullOutputPath && fullOutputPath
      ? fullOutputNoticeLine(fullOutputPath)
      : undefined;
  const render = outputRenderDetails(output, empty);
  const modelText = sanitizePlainText(
    notice ? `${output}\n\n${notice.text}` : output,
    sanitizeOptions,
  );

  return {
    text: modelText,
    details: {
      ...(!sourceTruncated && truncation.truncated ? { truncation, fullOutputPath } : {}),
      ...(!truncation.truncated && notice ? { fullOutputPath } : {}),
      ...(sourceTruncated ? { fullOutputPath, sourceBytes, sourceTruncated } : {}),
      render: { lines: notice ? [...render.lines, notice] : render.lines, empty: render.empty },
    },
  };
};

export const limitOutputLines = (content: string, lines: number): string => {
  const trimmed = content.trimEnd();
  if (!trimmed) return "";

  return trimmed.split("\n").slice(-lines).join("\n");
};

export const formatCompletionSummary = (exitCode: number): string =>
  exitCode === 0 ? "Background bash finished" : "Background bash failed";

export const hasOnlyEmptyBashOutput = (details: BashOutputRenderDetails): boolean =>
  details.empty && details.lines.every((line) => line.kind === "output");

const outputLines = (details: BashOutputRenderDetails): BashOutputRenderLine[] =>
  stripTrailingEmptyLines(
    details.lines.filter((line) => line.kind === "output").map((line) => line.text),
  ).map((text) => ({ kind: "output", text }));

const noticeLines = (details: BashOutputRenderDetails, expanded: boolean): BashOutputRenderLine[] =>
  details.lines.filter(
    (line) => line.kind === "truncationNotice" || (expanded && line.kind === "fullOutputNotice"),
  );

const collapsedElisionLine = (earlierLines: number): BashOutputRenderLine => ({
  kind: "collapsedElision" as const,
  text: `... (${earlierLines} earlier lines, ${keyText("app.tools.expand")} to expand)`,
  prefix: `... (${earlierLines} earlier lines,`,
  key: keyText("app.tools.expand"),
  suffix: " to expand",
});

const expandedElisionLine = (earlierLines: number): BashOutputRenderLine => ({
  kind: "expandedElision" as const,
  text: `... (${earlierLines} earlier lines omitted)`,
});

const noticeResultLines = (notices: BashOutputRenderLine[]): BashOutputRenderLine[] =>
  notices.length > 0 ? [{ kind: "output", text: "" }, ...notices] : [];

const bashResultVisibleLineCount = (
  details: BashOutputRenderDetails,
  {
    expanded,
    compactDisplayLines = DEFAULT_OPTIONS.bashCompactDisplayLines,
    expandedDisplayLines = DEFAULT_OPTIONS.bashExpandedDisplayLines,
    truncatedCompactDisplayLines = compactDisplayLines,
  }: BashResultFormatOptions,
): number => {
  const collapsedDisplayLines = details.lines.some((line) => line.kind === "truncationNotice")
    ? truncatedCompactDisplayLines
    : compactDisplayLines;
  return expanded ? expandedDisplayLines : collapsedDisplayLines;
};

export const formatRenderedBashResult = (
  details: BashOutputRenderDetails,
  options: BashResultFormatOptions,
): string =>
  renderedBashResultLines(details, options)
    .map((line) => line.text)
    .join("\n")
    .trimEnd();

export const renderedBashResultLines = (
  details: BashOutputRenderDetails,
  options: BashResultFormatOptions,
): BashOutputRenderLine[] => {
  const lines = outputLines(details);
  const visibleOutputLineCount = bashResultVisibleLineCount(details, options);
  const notices = noticeLines(details, options.expanded);
  if (lines.length <= visibleOutputLineCount) {
    return [...lines, ...noticeResultLines(notices)];
  }

  const displayedOutputLines = lines.slice(-visibleOutputLineCount);
  const earlierLines = Math.max(0, lines.length - displayedOutputLines.length);
  return [
    options.expanded ? expandedElisionLine(earlierLines) : collapsedElisionLine(earlierLines),
    ...displayedOutputLines,
    ...noticeResultLines(notices),
  ];
};

export const displayCommandForCommand = (
  cmd: string,
  marker = DEFAULT_OPTIONS.displayCommandStartMarker,
): string => {
  if (!marker) return cmd;

  const lines = cmd.split("\n");
  const reversedMarkerIndex = [...lines].reverse().findIndex((line) => line.trim() === marker);
  if (reversedMarkerIndex === -1) return cmd;

  const markerLineIndex = lines.length - reversedMarkerIndex - 1;
  return (
    lines
      .slice(markerLineIndex + 1)
      .join("\n")
      .trimStart() || cmd
  );
};