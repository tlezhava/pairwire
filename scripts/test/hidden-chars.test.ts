import { describe, expect, it } from "vitest";
import { findHidden } from "../hidden-chars.js";

describe("hidden character check", () => {
  it("finds literal bidi, zero-width and tag characters with their line numbers", () => {
    const src = ["ok", `const a = "x${String.fromCodePoint(0x202e)}y";`, `// ${String.fromCodePoint(0x200b)}${String.fromCodePoint(0xe0041)}`].join("\n");
    expect(findHidden(src)).toEqual([
      { line: 2, codePoint: "U+202E" },
      { line: 3, codePoint: "U+200B" },
      { line: 3, codePoint: "U+E0041" },
    ]);
  });

  it("allows escapes, ZWJ-free text, emoji and other non-ASCII text", () => {
    expect(findHidden('const a = "\\u202E"; // ‹ é 😀 ж')).toEqual([]);
  });
});
