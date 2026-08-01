import type { ResolvedOptions } from "./config";

// CSI and related sequences (7-bit ESC introducer or 8-bit CSI 0x9b), optional intermediates,
// optional numeric params (supports ; and : separators), then a final byte in the ranges
// defined by ECMA-48 / DEC private sequences. Mirrors the well-tested ansi-regex pattern.
const CSI_PATTERN = "[\\u001B\\u009B][[\\]()#;?]*(?:\\d{1,4}(?:[;:]\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]";
// String terminator: BEL, ESC backslash, or 8-bit ST (0x9c).
const ST_PATTERN = "(?:\\u0007|\\u001B\\u005C|\\u009C)";
// OSC sequences: ESC ] ... ST (non-greedy until the first string terminator).
const OSC_PATTERN = `(?:\\u001B\\][\\s\\S]*?${ST_PATTERN})`;
const ANSI_SEQUENCE = new RegExp(`${OSC_PATTERN}|${CSI_PATTERN}`, "g");

// C0 control bytes that have no safe textual rendering. HT (tab), LF (newline) and CR
// (carriage return) are intentionally preserved so line structure and alignment survive.
const UNSAFE_C0 = new Set<number>([
  0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, // NUL..BEL
  0x08, // BS
  0x0b, 0x0c, // VT, FF
  0x0e, 0x0f, // SO, SI
  0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, // DC1..DC4, NAK, SYN, ETB
  0x18, 0x19, 0x1a, // CAN, EM, SUB
  0x1b, // ESC (lone, after complete sequences stripped)
  0x1c, 0x1d, 0x1e, 0x1f, // FS, GS, RS, US
  0x7f, // DEL
]);

// C1 control bytes (0x80-0x9f). 0x9b (CSI) and 0x9c (ST) are matched by the ANSI regex first;
// any that survive are unsafe on their own.
const UNSAFE_C1_START = 0x80;
const UNSAFE_C1_END = 0x9f;

// Invisible / format Unicode that terminals may render ambiguously or that enable spoofing
// attacks (zero-width, bidi overrides, BOM, joiners). Categorized so callers stay auditable.
const UNSAFE_UNICODE = new Set<number>([
  0xfeff, // BOM / ZERO WIDTH NO-BREAK SPACE
  0x200b, 0x200c, 0x200d, // ZERO WIDTH SPACE, ZWNJ, ZWJ
  0x200e, 0x200f, // LRM, RLM
  0x202a, 0x202b, 0x202c, 0x202d, 0x202e, // LRE, RLE, PDF, LRO, RLO
  0x2060, 0x2061, 0x2062, 0x2063, 0x2064, // WJ, invisible function application operators
  0x2066, 0x2067, 0x2068, 0x2069, // LRI, RLI, FSI, PDI
  0x206a, 0x206b, 0x206c, 0x206d, 0x206e, 0x206f, // deprecated bidi formatting
]);

const REPLACEMENT_CHAR = 0xfffd;

export type SanitizeOptions = {
  fallback: string;
};

export const resolveSanitizeOptions = (options: ResolvedOptions): SanitizeOptions => ({
  fallback: options.controlCharFallback,
});

const isUnsafeCodePoint = (code: number): boolean =>
  UNSAFE_C0.has(code) ||
  (code >= UNSAFE_C1_START && code <= UNSAFE_C1_END) ||
  UNSAFE_UNICODE.has(code) ||
  code === REPLACEMENT_CHAR;

const hasUnsafeContent = (text: string): boolean => {
  if (text.includes("\u001B") || text.includes("\uFFFD")) return true;
  for (const code of UNSAFE_UNICODE) {
    if (text.includes(String.fromCodePoint(code))) return true;
  }
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (UNSAFE_C0.has(code) || (code >= UNSAFE_C1_START && code <= UNSAFE_C1_END)) return true;
  }
  return false;
};

/**
 * Plain-text sanitization for model-facing output: strip complete ANSI sequences and replace
 * every remaining unsafe character with `fallback`. No coloring is applied.
 */
export const sanitizePlainText = (content: string, { fallback }: SanitizeOptions): string => {
  const stripped = content.replace(ANSI_SEQUENCE, "");
  if (!hasUnsafeContent(stripped)) return stripped;

  let result = "";
  for (const segment of Array.from(stripped)) {
    const code = segment.codePointAt(0);
    result += code !== undefined && isUnsafeCodePoint(code) ? fallback : segment;
  }
  return result;
};

export type Painter = (text: string) => string;

/**
 * Sanitize for TUI rendering. Complete ANSI sequences are removed; each remaining unsafe
 * character is rendered as `fallback` wrapped in `paintFallback`, while safe text is wrapped
 * in `paintSafe`. Returns the fully styled string ready for display.
 */
export const sanitizeForRender = (
  content: string,
  { fallback }: SanitizeOptions,
  paintSafe: Painter,
  paintFallback: Painter,
): string => {
  const stripped = content.replace(ANSI_SEQUENCE, "");
  if (!hasUnsafeContent(stripped)) return paintSafe(stripped);

  let safeRun = "";
  let result = "";
  const flushSafe = () => {
    if (safeRun) {
      result += paintSafe(safeRun);
      safeRun = "";
    }
  };

  for (const segment of Array.from(stripped)) {
    const code = segment.codePointAt(0);
    if (code !== undefined && isUnsafeCodePoint(code)) {
      flushSafe();
      result += paintFallback(fallback);
    } else {
      safeRun += segment;
    }
  }
  flushSafe();
  return result;
};
