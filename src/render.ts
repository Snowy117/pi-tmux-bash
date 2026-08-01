// Re-export from sanitize
export { resolveSanitizeOptions, sanitizeForRender, sanitizePlainText, type SanitizeOptions } from "./sanitize";

// Re-export from format-output
export {
  formatTmuxOutputForContext,
  formatRenderedBashResult,
  formatCompletionSummary,
  limitOutputLines,
  hasOnlyEmptyBashOutput,
  displayCommandForCommand,
  outputRenderDetails,
  type BashOutputRenderLine,
  type BashOutputRenderDetails,
  type TmuxBashToolDetails,
  type FormattedOutput,
} from "./format-output";

// Re-export from format-messages
export {
  formatRenderedCompletionMessage,
  formatRenderedPollMessage,
  indentDisplayLine,
  indentDisplayLines,
  type CompletionMessageRenderDetails,
  type PollMessageRenderDetails,
} from "./format-messages";

// Re-export from render-core
export {
  renderBackgroundBashResultText,
  renderBashCallText,
  renderBashResultText,
  renderForegroundBashResultComponent,
  formatRenderedBashCall,
  formatDurationSeconds,
  type RenderTheme,
  type BashCallRenderOptions,
  BashResultRenderComponent,
  BashOutputPreviewComponent,
} from "./render-core";