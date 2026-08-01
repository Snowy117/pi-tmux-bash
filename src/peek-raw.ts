import { existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import type { ResolvedOptions } from "./config";
import type { TmuxInput } from "./tool-call-schemas";
import type { ExtensionState } from "./state";
import type { TmuxWindow, TmuxWindowFilters } from "./tmux-utils";
import { getWindows, sessionExists, formatWindowLines } from "./tmux-utils";
import { readOutputFileTail } from "./output";
import { formatTmuxOutputForContext, formatRenderedBashResult } from "./format-output";
import { toolError, renderedToolText } from "./state";

const isTmuxWindowId = (window: string): boolean => /^@\d+$/.test(window);

const isBashCreatedWindow = (window: TmuxWindow): boolean =>
  Boolean(window.outputFile && window.displayCommand);

export const getBashCreatedWindows = (
  session: string,
  options: ResolvedOptions,
  filters: TmuxWindowFilters = {},
): TmuxWindow[] => getWindows(session, filters, options.tmuxBinary).filter(isBashCreatedWindow);

export const findBashWindowById = (
  session: string,
  filters: TmuxWindowFilters,
  options: ResolvedOptions,
  windowId: string,
): TmuxWindow | undefined =>
  getBashCreatedWindows(session, options, filters).find((item) => item.id === windowId);

export const requireBashWindowById = (
  action: string,
  session: string,
  filters: TmuxWindowFilters,
  options: ResolvedOptions,
  windowId: string,
) => {
  if (!isTmuxWindowId(windowId)) {
    return toolError(`Error: ${action} requires a background window id, e.g. @123.`);
  }

  const window = findBashWindowById(session, filters, options, windowId);
  if (!window) return toolError(`No bash-created background window ${windowId} in session ${session}.`);
  return window;
};

const bashWindowOutput = (window: TmuxWindow, options: ResolvedOptions) =>
  readOutputFileTail(window.outputFile, options.maxOutputBytes) ?? {
    text: "", sourceBytes: 0, sourceTruncated: false,
  };

export const formatBashWindowOutput = (
  window: TmuxWindow,
  options: ResolvedOptions,
  contextLines: number,
) => {
  const rawOutput = bashWindowOutput(window, options);
  return formatTmuxOutputForContext(rawOutput.text, {
    fullOutputPath: window.outputFile,
    sourceBytes: rawOutput.sourceBytes,
    sourceTruncated: rawOutput.sourceTruncated,
    truncationOptions: { maxLines: contextLines, maxBytes: options.maxOutputBytes },
  });
};

const bashWindowDisplayLines = (
  window: TmuxWindow,
  expanded: boolean,
  options: ResolvedOptions,
  contextLines: number,
  compactDisplayLines: number,
  expandedDisplayLines: number,
  truncatedCompactDisplayLines: number,
): string[] => {
  const output = formatBashWindowOutput(window, options, contextLines);
  return [
    `$ ${window.displayCommand ?? window.title}`,
    ...formatRenderedBashResult(output.details.render, {
      expanded, compactDisplayLines, expandedDisplayLines, truncatedCompactDisplayLines,
    }).split("\n"),
  ];
};

const peekWindowExpandedLines = (window: TmuxWindow, options: ResolvedOptions): string[] =>
  bashWindowDisplayLines(window, true, options,
    options.peekExpandedDisplayLines, options.peekCompactDisplayLines,
    options.peekExpandedDisplayLines, options.peekTruncatedCompactDisplayLines,
  ).map((l) => ` ${l}`);

const peekWindowCollapsedLines = (window: TmuxWindow, options: ResolvedOptions): string[] =>
  bashWindowDisplayLines(window, false, options,
    options.peekContextLines, options.peekCompactDisplayLines,
    options.peekExpandedDisplayLines, options.peekTruncatedCompactDisplayLines,
  ).map((l) => ` ${l}`);

const compactPeekContextLine = (line: string): string =>
  line.replace(/^\.\.\. \((\d+) earlier lines,.*to expand\)$/, "... ($1 earlier lines omitted)");

const peekWindowContextLines = (window: TmuxWindow, options: ResolvedOptions): string[] => [
  `background window: ${window.title} ${window.id}`,
  ...bashWindowDisplayLines(window, false, options,
    options.peekContextLines, options.peekCompactDisplayLines,
    options.peekExpandedDisplayLines, options.peekTruncatedCompactDisplayLines,
  ).map(compactPeekContextLine),
];

const renderPeekDetails = (window: TmuxWindow, options: ResolvedOptions) => ({
  summary: `background window: ${window.title} ${window.id}`,
  expandedLines: peekWindowExpandedLines(window, options),
  collapsedLines: peekWindowCollapsedLines(window, options),
});

export const peekAction = (
  params: Extract<TmuxInput, { action: "peek" }>,
  session: string,
  filters: TmuxWindowFilters,
  options: ResolvedOptions,
) => {
  if (!sessionExists(session, options.tmuxBinary))
    return toolError(`No background session '${session}'.`);

  const window = requireBashWindowById("peek", session, filters, options, params.window);
  if ("isError" in window) return window;

  const output = peekWindowContextLines(window, options).join("\n");
  const render = renderPeekDetails(window, options);
  return renderedToolText(output, render, { session });
};

const isPathUnderOutputDir = (filePath: string, outputDir: string): boolean => {
  const resolvedFile = resolvePath(filePath);
  const resolvedDir = resolvePath(outputDir);
  return resolvedFile === resolvedDir || resolvedFile.startsWith(`${resolvedDir}/`);
};

const resolveRawOutputPath = (
  params: Extract<TmuxInput, { action: "raw" }>,
  session: string,
  filters: TmuxWindowFilters,
  state: ExtensionState,
  options: ResolvedOptions,
): string | ReturnType<typeof toolError> => {
  if (params.path) {
    if (!isPathUnderOutputDir(params.path, options.outputDir)) {
      return toolError(`Error: path must be under outputDir (${options.outputDir}); got ${params.path}`);
    }
    if (!params.path.endsWith(".out")) {
      return toolError(`Error: path must be a .out tee file; got ${params.path}`);
    }
    if (!existsSync(params.path)) {
      return toolError(`Error: raw output file not found: ${params.path}`);
    }
    return params.path;
  }

  if (!params.window) return toolError("Error: raw requires window and/or path.");

  const fromIndex = state.rawOutputByWindowId.get(params.window);
  if (fromIndex && existsSync(fromIndex)) return fromIndex;

  if (sessionExists(session, options.tmuxBinary)) {
    const window = findBashWindowById(session, filters, options, params.window);
    if (window?.outputFile && existsSync(window.outputFile)) return window.outputFile;
  }

  if (fromIndex) {
    return toolError(`Error: raw output file for ${params.window} is missing (${fromIndex}). It may have been deleted; set preserveOutputFiles: true.`);
  }

  return toolError(`Error: no raw output indexed for ${params.window}. Use path= to an absolute .out file under ${options.outputDir}.`);
};

export const rawAction = (
  params: Extract<TmuxInput, { action: "raw" }>,
  session: string,
  filters: TmuxWindowFilters,
  state: ExtensionState,
  options: ResolvedOptions,
) => {
  const resolved = resolveRawOutputPath(params, session, filters, state, options);
  if (typeof resolved !== "string") return resolved;

  if (params.window) state.rawOutputByWindowId.set(params.window, resolved);

  const rawOutput = readOutputFileTail(resolved, options.maxOutputBytes) ?? {
    text: "", sourceBytes: 0, sourceTruncated: false,
  };
  const output = formatTmuxOutputForContext(rawOutput.text, {
    fullOutputPath: resolved, showFullOutputPath: true,
    sourceBytes: rawOutput.sourceBytes, sourceTruncated: rawOutput.sourceTruncated,
    truncationOptions: { maxLines: options.peekContextLines, maxBytes: options.maxOutputBytes },
  });

  const summary = `Raw output ${params.window ? `${params.window} ` : ""}${resolved}`;
  const bodyLines = formatRenderedBashResult(output.details.render, {
    expanded: true, compactDisplayLines: options.peekExpandedDisplayLines,
    expandedDisplayLines: options.peekExpandedDisplayLines,
    truncatedCompactDisplayLines: options.peekTruncatedCompactDisplayLines,
  }).split("\n");

  return renderedToolText(`${summary}\n\n${output.text}`, {
    summary,
    expandedLines: ["", ...bodyLines],
    collapsedLines: ["", ...bodyLines.slice(-options.peekCompactDisplayLines)],
  }, { session, path: resolved, window: params.window });
};

export const listAction = (session: string, filters: TmuxWindowFilters, options: ResolvedOptions) => {
  if (!sessionExists(session, options.tmuxBinary))
    return toolError(`No background session '${session}'.`);

  const windows = getBashCreatedWindows(session, options, filters);
  const lines = formatWindowLines(windows);
  const summary = `Background session ${session} — ${windows.length} window(s)`;
  return renderedToolText(`${summary}\n\n${lines.join("\n")}`,
    { summary, expandedLines: ["", ...lines], collapsedLines: ["", ...lines] },
    { session, windows },
  );
};