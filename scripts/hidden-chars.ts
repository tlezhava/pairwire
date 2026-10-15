// Invisible and bidirectional-control characters that must never appear literally in
// source files (they can hide or reorder code: "trojan source"). Write them as \u escapes.
export const HIDDEN = /[\u00AD\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF\uFFF9-\uFFFB]|[\u{E0000}-\u{E007F}]/u;

export function findHidden(source: string): { line: number; codePoint: string }[] {
  const hits: { line: number; codePoint: string }[] = [];
  source.split("\n").forEach((text, i) => {
    for (const ch of text) {
      if (HIDDEN.test(ch)) hits.push({ line: i + 1, codePoint: `U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}` });
    }
  });
  return hits;
}
