import { describe, expect, it } from "vitest";
import { resolveOptions } from "../src/config";
import { sanitizePlainText, sanitizeForRender, resolveSanitizeOptions } from "../src/sanitize";

const sanitize = resolveSanitizeOptions(resolveOptions());

const taggedPaintSafe = (text: string) => `<safe>${text}</safe>`;
const taggedPaintFallback = (text: string) => `<fb>${text}</fb>`;

describe("sanitize plain text", () => {
  it("leaves plain printable text untouched", () => {
    expect(sanitizePlainText("echo hello world", sanitize)).toBe("echo hello world");
  });

  it("preserves tabs, newlines, and carriage returns", () => {
    const text = "col1\tcol2\nrow2\r\nrow3";
    expect(sanitizePlainText(text, sanitize)).toBe(text);
  });

  it("strips complete CSI color sequences", () => {
    expect(sanitizePlainText("\x1b[31mred\x1b[0m text", sanitize)).toBe("red text");
  });

  it("strips complete OSC sequences terminated by BEL", () => {
    expect(sanitizePlainText("\x1b]0;title\x07rest", sanitize)).toBe("rest");
  });

  it("strips complete OSC sequences terminated by ST", () => {
    expect(sanitizePlainText("\x1b]0;title\x1b\\rest", sanitize)).toBe("rest");
  });

  it("replaces a lone ESC byte with the fallback character", () => {
    expect(sanitizePlainText("a\x1b", sanitize)).toBe("a.");
    expect(sanitizePlainText("\x1b", sanitize)).toBe(".");
  });

  it("replaces an incomplete CSI sequence with fallback", () => {
    expect(sanitizePlainText("a\x1b[", sanitize)).toBe("a.[");
  });

  it("replaces C0 control bytes (except tab/newline/CR) with fallback", () => {
    expect(sanitizePlainText("a\x07b", sanitize)).toBe("a.b");
    expect(sanitizePlainText("x\x00y", sanitize)).toBe("x.y");
    expect(sanitizePlainText("x\x7fy", sanitize)).toBe("x.y");
  });

  it("replaces C1 control bytes with fallback", () => {
    expect(sanitizePlainText("a\x84b", sanitize)).toBe("a.b");
    expect(sanitizePlainText("a\x9fb", sanitize)).toBe("a.b");
  });

  it("replaces invalid UTF-8 replacement characters with fallback", () => {
    expect(sanitizePlainText("a\uFFFDb", sanitize)).toBe("a.b");
  });

  it("replaces invisible Unicode (BOM, zero-width, bidi overrides) with fallback", () => {
    expect(sanitizePlainText("a\uFEFFb", sanitize)).toBe("a.b");
    expect(sanitizePlainText("a\u200Bb", sanitize)).toBe("a.b");
    expect(sanitizePlainText("a\u202Eb", sanitize)).toBe("a.b");
  });

  it("uses the configured fallback character", () => {
    const dot = resolveSanitizeOptions(resolveOptions({ controlCharFallback: "•" }));
    expect(sanitizePlainText("a\x07b", dot)).toBe("a•b");
  });
});

describe("sanitize for render", () => {
  it("wraps safe text with the safe painter and has no fallback when clean", () => {
    expect(sanitizeForRender("hello", sanitize, taggedPaintSafe, taggedPaintFallback)).toBe(
      "<safe>hello</safe>",
    );
  });

  it("wraps each unsafe char with the fallback painter", () => {
    expect(sanitizeForRender("a\x07b", sanitize, taggedPaintSafe, taggedPaintFallback)).toBe(
      "<safe>a</safe><fb>.</fb><safe>b</safe>",
    );
  });

  it("strips complete ANSI sequences before painting", () => {
    expect(
      sanitizeForRender("\x1b[31mred\x1b[0m text", sanitize, taggedPaintSafe, taggedPaintFallback),
    ).toBe("<safe>red text</safe>");
  });

  it("coalesces adjacent safe runs", () => {
    expect(sanitizeForRender("x\x07y\x07z", sanitize, taggedPaintSafe, taggedPaintFallback)).toBe(
      "<safe>x</safe><fb>.</fb><safe>y</safe><fb>.</fb><safe>z</safe>",
    );
  });
});
