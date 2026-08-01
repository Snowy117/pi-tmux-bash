import { Container, Text, truncateToWidth } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import {
  formatSize,
  keyHint,
  keyText,
  truncateToVisualLines,
  DEFAULT_MAX_BYTES,
} from "@earendil-works/pi-coding-agent";
import { BASH_DURATION_SEPARATOR, DEFAULT_OPTIONS, type ResolvedOptions } from "./config";
import type { BashInput } from "./tool-call-schemas";
import {
  type SanitizeOptions,
  type BashOutputRenderDetails,
  type BashOutputRenderLine,
  type BashResultFormatOptions,
  type TmuxBashToolDetails,
  outputRenderDetails,
} from "./format-output";
import { resolveSanitizeOptions, sanitizeForRender } from "./sanitize";
import { renderedBashResultLines } from "./format-output";
import { formatRenderedBashResult } from "./format-output";

export type RenderTheme = {
  fg: (name: "toolTitle" | "toolOutput" | "muted" | "dim" | "warning" | "error", text: string) => string;
  bold: (text: string) => string;
};

class BashResultRenderComponent extends Container {}

class BashOutputPreviewComponent implements Component {
  private cachedWidth: number | undefined;
  private cachedLines: string[] | undefined;
  private cachedSkipped: number | undefined;

  constructor(
    private readonly output: string,
    private readonly theme: RenderTheme,
  ) {}

  render(width: number): string[] {
    if (this.cachedLines === undefined || this.cachedWidth !== width) {
      const preview = truncateToVisualLines(this.output, 5, width);
      this.cachedLines = preview.visualLines;
      this.cachedSkipped = preview.skippedCount;
      this.cachedWidth = width;
    }

    if (this.cachedSkipped && this.cachedSkipped > 0) {
      const hint =
        this.theme.fg("muted", `... (${this.cachedSkipped} earlier lines,`) +
        ` ${keyHint("app.tools.expand", "to expand")})`;
      return ["", truncateToWidth(hint, width, "..."), ...(this.cachedLines ?? [])];
    }

    return ["", ...(this.cachedLines ?? [])];
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
    this.cachedSkipped = undefined;
  }
}

export { BashResultRenderComponent, BashOutputPreviewComponent };

const truncateText = (text: string, maxLength: number): string =>
  maxLength > 0 && text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;

const normalizeCommand = (args: Partial<BashInput>): string =>
  (args.command ?? "...").replace(/\r\n/g, "\n").trim();

export type BashCallRenderOptions = {
  commandDisplayLength?: number;
  collapsedDisplayLines?: number;
  expanded?: boolean;
};

const truncateCommandLine = (line: string, commandDisplayLength: number): string =>
  truncateText(line, commandDisplayLength);

const bashCallCommandLines = (
  args: Partial<BashInput>,
  { commandDisplayLength = DEFAULT_OPTIONS.bashCommandDisplayLength, expanded = false, collapsedDisplayLines = DEFAULT_OPTIONS.bashCommandCollapsedDisplayLines }: BashCallRenderOptions = {},
): string[] => {
  const normalized = normalizeCommand(args);
  const lines = normalized.split("\n");
  const truncatedLines = lines.map((line) => truncateCommandLine(line, commandDisplayLength));

  if (expanded || lines.length <= collapsedDisplayLines) return truncatedLines;

  return [...truncatedLines.slice(0, collapsedDisplayLines), "..."];
};

const bashBackgroundMetadata = (args: Partial<BashInput>): string => {
  const poll =
    args.pollInterval !== undefined && args.pollInterval > 0 ? `, poll ${args.pollInterval}s` : "";
  return `(background${poll})`;
};

const bashCallMetadata = (args: Partial<BashInput>): string[] => {
  if (args.background === true) return [bashBackgroundMetadata(args)];

  return [args.timeout !== undefined ? `(timeout ${args.timeout}s)` : undefined].filter(
    (item) => item !== undefined,
  );
};

export const formatRenderedBashCall = (
  args: Partial<BashInput>,
  { commandDisplayLength, collapsedDisplayLines, expanded }: BashCallRenderOptions = {},
): string => {
  const lines = bashCallCommandLines(args, { commandDisplayLength, collapsedDisplayLines, expanded });
  const metadata = bashCallMetadata(args);
  const tail = metadata.length > 0 ? ` ${metadata.join(" ")}` : "";
  const lastIndex = lines.length - 1;

  return lines
    .map((line, index) => {
      if (index === 0 && index === lastIndex) return `$ ${line}${tail}`.trimEnd();
      if (index === 0) return `$ ${line}`;
      if (index === lastIndex) return `${line}${tail}`.trimEnd();
      return line;
    })
    .filter((line) => line.length > 0)
    .join("\n");
};

export const renderBashCallText = (
  args: Partial<BashInput>,
  theme: RenderTheme,
  { commandDisplayLength, collapsedDisplayLines, expanded }: BashCallRenderOptions = {},
): string => {
  const lines = bashCallCommandLines(args, { commandDisplayLength, collapsedDisplayLines, expanded });
  const metadata = bashCallMetadata(args);
  const metadataText = metadata.length > 0
    ? metadata.map((item) => theme.fg("muted", ` ${item}`)).join("")
    : "";

  return lines
    .map((line, index) => {
      const prefix = index === 0 ? "$ " : "";
      return theme.fg("toolTitle", theme.bold(`${prefix}${line}`));
    })
    .join("\n")
    .replace(/\n$/, "") + metadataText;
};

const bashResultFormatOptions = (
  expanded: boolean,
  options: ResolvedOptions,
): BashResultFormatOptions => ({
  expanded,
  compactDisplayLines: options.bashCompactDisplayLines,
  expandedDisplayLines: options.bashExpandedDisplayLines,
  truncatedCompactDisplayLines: options.bashTruncatedCompactDisplayLines,
});

const bashResultOutputLines = (
  raw: string,
  details: BashOutputRenderDetails | undefined,
  expanded: boolean,
  options: ResolvedOptions,
): BashOutputRenderLine[] =>
  renderedBashResultLines(
    details ?? outputRenderDetails(raw),
    bashResultFormatOptions(expanded, options),
  );

const renderBashOutputLine = (
  line: BashOutputRenderLine,
  theme: RenderTheme,
  sanitize: SanitizeOptions,
): string => {
  if (line.kind === "collapsedElision") {
    const { prefix, key, suffix } = line;
    return (
      theme.fg("muted", prefix) +
      ` ${theme.fg("dim", key)}${theme.fg("muted", suffix)})`
    );
  }
  if (line.kind === "expandedElision") return theme.fg("muted", line.text);
  if (line.kind === "fullOutputNotice") return theme.fg("warning", line.text);

  return sanitizeForRender(
    line.text,
    sanitize,
    (text) => theme.fg("toolOutput", text),
    (text) => theme.fg("error", text),
  );
};

const renderBashOutputLines = (
  lines: BashOutputRenderLine[],
  theme: RenderTheme,
  sanitize: SanitizeOptions,
): string => lines.map((line) => renderBashOutputLine(line, theme, sanitize)).join("\n");

export const renderBackgroundBashResultText = ({
  raw,
  details,
  expanded,
  theme,
  options = DEFAULT_OPTIONS,
}: {
  raw: string;
  details?: BashOutputRenderDetails;
  expanded: boolean;
  theme: RenderTheme;
  options?: ResolvedOptions;
}): string => {
  const output = bashResultOutputLines(raw, details, expanded, options);
  const renderedOutput =
    output.length > 0 ? renderBashOutputLines(output, theme, resolveSanitizeOptions(options)) : "";
  return renderedOutput ? `\n${renderedOutput}` : "";
};

export const formatDurationSeconds = (ms: number): string => `${Math.floor(ms / 1000)}s`;

const durationSeconds = (ms: number): number => Math.max(0, ms / 1000);

const formatElapsedDurationSeconds = (ms: number): string => `${durationSeconds(ms).toFixed(1)}s`;

type BashResultTimingState = {
  startedAt?: number;
  endedAt?: number;
};

const bashDurationText = (state: BashResultTimingState, isPartial: boolean): string | undefined => {
  if (state.startedAt === undefined) return undefined;

  const label = isPartial ? "Elapsed" : "Took";
  const endTime = state.endedAt ?? Date.now();
  const duration = formatElapsedDurationSeconds(endTime - state.startedAt);
  return `${label} ${duration}`;
};

export const renderBashResultText = ({
  raw,
  details,
  expanded,
  isPartial,
  state,
  theme,
  options = DEFAULT_OPTIONS,
}: {
  raw: string;
  details?: BashOutputRenderDetails;
  expanded: boolean;
  isPartial: boolean;
  state: BashResultTimingState;
  theme: RenderTheme;
  options?: ResolvedOptions;
}): string => {
  const output = bashResultOutputLines(raw, details, expanded, options);
  const duration = bashDurationText(state, isPartial);
  const renderedOutput =
    output.length > 0 ? renderBashOutputLines(output, theme, resolveSanitizeOptions(options)) : "";
  const renderedDuration = duration ? theme.fg("muted", duration) : "";

  if (!renderedOutput) return isPartial ? `\n${renderedDuration}` : renderedDuration;
  return [renderedOutput, renderedDuration].filter(Boolean).join(BASH_DURATION_SEPARATOR);
};

const stripFinalTruncationFooter = (
  output: string,
  details: TmuxBashToolDetails | undefined,
  isPartial: boolean,
): string => {
  if (
    (isPartial && !details?.sourceTruncated) ||
    (!details?.truncation?.truncated && !details?.sourceTruncated) ||
    !details.fullOutputPath ||
    !output.endsWith("]")
  ) {
    return output;
  }

  const footerStart = output.lastIndexOf("\n\n[");
  if (footerStart === -1 || !output.slice(footerStart).includes(details.fullOutputPath)) {
    return output;
  }

  return output.slice(0, footerStart).trimEnd();
};

const foregroundWarningText = (details: TmuxBashToolDetails | undefined): string | undefined => {
  const warnings: string[] = [];
  const truncation = details?.truncation;

  if (details?.fullOutputPath) warnings.push(`Full output: ${details.fullOutputPath}`);
  if (truncation?.truncated && truncation.truncatedBy === "lines") {
    warnings.push(`Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`);
  }
  if (truncation?.truncated && truncation.truncatedBy !== "lines") {
    warnings.push(
      `Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)`,
    );
  }

  return warnings.length > 0 ? `[${warnings.join(". ")}]` : undefined;
};

export const renderForegroundBashResultComponent = ({
  raw,
  details,
  expanded,
  isPartial,
  state,
  theme,
  options = DEFAULT_OPTIONS,
}: {
  raw: string;
  details?: TmuxBashToolDetails;
  expanded: boolean;
  isPartial: boolean;
  state: BashResultTimingState;
  theme: RenderTheme;
  options?: ResolvedOptions;
}): Component => {
  const component = new BashResultRenderComponent();
  const output = stripFinalTruncationFooter(raw.trim(), details, isPartial);
  const duration = bashDurationText(state, isPartial);
  const warning = foregroundWarningText(details);
  const sanitize = resolveSanitizeOptions(options);

  if (output) {
    const styledOutput = output
      .split("\n")
      .map((line) =>
        sanitizeForRender(
          line,
          sanitize,
          (text) => theme.fg("toolOutput", text),
          (text) => theme.fg("error", text),
        ),
      )
      .join("\n");
    component.addChild(
      expanded
        ? new Text(`\n${styledOutput}`, 0, 0)
        : new BashOutputPreviewComponent(styledOutput, theme),
    );
  }

  if (warning) component.addChild(new Text(`\n${theme.fg("warning", warning)}`, 0, 0));
  if (duration) component.addChild(new Text(`\n${theme.fg("muted", duration)}`, 0, 0));

  return component;
};