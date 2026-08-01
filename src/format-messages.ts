import { DEFAULT_OPTIONS, type ResolvedOptions } from "./config";
import {
  formatRenderedBashResult,
  hasOnlyEmptyBashOutput,
  type BashOutputRenderDetails,
  type BashResultFormatOptions,
} from "./format-output";

export type CompletionMessageRenderDetails = {
  summary: string;
  output: BashOutputRenderDetails;
  exitCode: number;
  status: "success" | "failed";
};

export type PollMessageRenderDetails = {
  summary: string;
  command: string;
  output: BashOutputRenderDetails;
  attachLines: string[];
};

export const indentDisplayLine = (line: string): string => (line.trim() ? ` ${line}` : "");

export const indentDisplayLines = (lines: string[]): string[] => lines.map(indentDisplayLine);

const displayTextForLine = (
  line: { kind: string; text: string; displayText?: string },
): string => (line.kind === "fullOutputNotice" ? line.displayText ?? line.text : line.text);

const formatCompletionDetailLines = (lines: { kind: string; text: string }[]): string[] =>
  lines
    .filter(
      (line) =>
        line.kind !== "fullOutputNotice" &&
        line.text.trim() !== "" &&
        !line.text.trimStart().startsWith("tmux: "),
    )
    .map(displayTextForLine);

const completionResultFormatOptions = (
  expanded: boolean,
  options: ResolvedOptions,
): BashResultFormatOptions => ({
  expanded,
  compactDisplayLines: expanded
    ? options.completedExpandedDisplayLines
    : options.completedCompactDisplayLines,
  expandedDisplayLines: options.completedExpandedDisplayLines,
  truncatedCompactDisplayLines: options.completedTruncatedCompactDisplayLines,
});

export const formatRenderedCompletionMessage = ({
  details,
  expanded,
  options = DEFAULT_OPTIONS,
}: {
  details: CompletionMessageRenderDetails;
  expanded: boolean;
  options?: ResolvedOptions;
}): string => {
  if (hasOnlyEmptyBashOutput(details.output)) return details.summary;

  if (expanded) {
    const detailLines = displayTextForLine.bind(null) as unknown as (
      line: { kind: string; text: string; displayText?: string },
    ) => string;
    const lines = formatRenderedBashResult(
      details.output,
      completionResultFormatOptions(true, options),
    )
      .split("\n")
      .map((text) => ({ kind: "output" as const, text }))
      .slice(-options.completedExpandedDisplayLines)
      .map(displayTextForLine);
    return [details.summary, ...indentDisplayLines(lines)].join("\n");
  }

  const output = formatRenderedBashResult(
    details.output,
    completionResultFormatOptions(false, options),
  );
  const detailLines = formatCompletionDetailLines(
    output.split("\n").map((text) => ({ kind: "output" as const, text })),
  );
  if (detailLines.length === 0) return details.summary;

  return [details.summary, "", ...indentDisplayLines(detailLines)].join("\n");
};

const pollResultFormatOptions = (
  expanded: boolean,
  displayLines: number,
  options: ResolvedOptions,
): BashResultFormatOptions => ({
  expanded,
  compactDisplayLines: displayLines,
  expandedDisplayLines: displayLines,
  truncatedCompactDisplayLines: options.pollTruncatedCompactDisplayLines,
});

const formatRenderedPollOutput = (
  command: string,
  output: BashOutputRenderDetails,
  expanded: boolean,
  displayLines: number,
  options: ResolvedOptions,
): string => {
  const compacted = formatRenderedBashResult(
    output,
    pollResultFormatOptions(expanded, displayLines, options),
  );
  const lines = [...(command ? [command] : []), ...(compacted ? compacted.split("\n") : [])];
  return indentDisplayLines(lines).join("\n");
};

export const formatRenderedPollMessage = ({
  details,
  expanded,
  options = DEFAULT_OPTIONS,
}: {
  details: PollMessageRenderDetails;
  expanded: boolean;
  options?: ResolvedOptions;
}): string => {
  const displayLines = expanded
    ? options.pollExpandedDisplayLines
    : options.pollCompactDisplayLines;
  const output = formatRenderedPollOutput(
    details.command,
    details.output,
    expanded,
    displayLines,
    options,
  );
  const rendered = [details.summary, output].filter(Boolean).join("\n\n");
  return details.attachLines.length > 0
    ? `${rendered}\n\n${details.attachLines.join("\n")}`
    : rendered;
};