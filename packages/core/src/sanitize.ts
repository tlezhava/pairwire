// Inbound sanitizer (04 §5, INV-3). Every delivery path renders peer text through this
// module via render.ts; nothing else may inject a peer-supplied string.

/**
 * Step 2: format characters except ZWJ, the tag block, C0/C1 controls except \n and \t, and
 * the invisible characters outside Cf (ADR-030): the Variation Selectors Supplement, CGJ, the
 * Hangul fillers and the Mongolian free variation selectors.
 */
const REMOVE =
  // eslint-disable-next-line no-control-regex -- matching control characters is the point
  /(?!\u200D)\p{Cf}|[\u{E0000}-\u{E007F}]|[\u0000-\u0008\u000B-\u001F\u007F-\u009F]|[\u{E0100}-\u{E01EF}]|[\u115F\u1160\u3164\uFFA0]|\u034F|[\u180B-\u180D]|\u180F/gu;
/** Step 2: U+FE00–U+FE0F survive only directly after a base character, one per base (a VS is a mark, not a base). */
const STRAY_VARIATION_SELECTOR = /(?<![\p{L}\p{N}\p{P}\p{S}])[\uFE00-\uFE0F]/gu;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Step 3: `<`, its compatibility forms, and U+226E, which NFC makes of `<` + U+0338. */
const TAG_OPENER = /[<\uFE64\uFF1C\u226E]/g;
/** Step 3: skipped anywhere in a tag-name skeleton (whitespace, marks, invisible characters). */
const TAG_SKIP = /^[\s\p{M}\p{Default_Ignorable_Code_Point}]$/u;
/** Step 3: `/`, `\` and their look-alikes; up to two before the keyword (JSON writes `<\/`). */
const TAG_SLASHES = new Set(["/", "\\", "\u2044", "\u2215", "\u2216", "\u29F8", "\u29F9", "\uFE68", "\uFF0F", "\uFF3C"]);
const TAG_MAX_SLASHES = 2;
/** Step 3: `pairwire` covers every element we emit; `system` covers `system-reminder`. */
const TAG_KEYWORDS = ["pairwire", "system", "channel", "function", "antml"] as const;
const MARKS = /\p{M}/gu;

export const NAME_MAX_CHARS = 40;
export const ANONYMOUS = "anonymous";

/** Steps 1–3: for message bodies and as the first stage of every attribute value. */
export function sanitizeText(text: string): string {
  const cleaned = text
    .replace(LONE_SURROGATE, "\uFFFD")
    .normalize("NFC")
    .replace(REMOVE, "")
    .replace(STRAY_VARIATION_SELECTOR, "")
    .normalize("NFC");
  return neutralizeTags(cleaned);
}

/** Step 3: replaces each opener whose skeleton spells a keyword with `‹` (U+2039). */
function neutralizeTags(text: string): string {
  let out = "";
  let last = 0;
  for (const m of text.matchAll(TAG_OPENER)) {
    if (!opensTag(text, m.index + 1)) continue;
    out += text.slice(last, m.index) + "‹";
    last = m.index + 1;
  }
  return last === 0 ? text : out + text.slice(last);
}

/**
 * Whether the characters from `from` spell a keyword once skippable characters are ignored
 * and the rest folded. Stops at the first character that is neither skippable, an allowed
 * slash nor the next keyword letter; an opener is never one of those, so no character is
 * examined for two openers and the whole step is linear.
 */
function opensTag(text: string, from: number): boolean {
  let letters = "";
  let slashes = 0;
  let i = from;
  while (i < text.length) {
    const ch = String.fromCodePoint(text.codePointAt(i)!);
    i += ch.length;
    if (TAG_SKIP.test(ch)) continue;
    if (letters === "" && slashes < TAG_MAX_SLASHES && TAG_SLASHES.has(ch)) {
      slashes++;
      continue;
    }
    const folded = ch.toLowerCase().normalize("NFKD").replace(MARKS, "");
    if (folded === "") continue;
    letters += folded;
    if (TAG_KEYWORDS.some((k) => letters.startsWith(k))) return true;
    if (!TAG_KEYWORDS.some((k) => k.startsWith(letters))) return false;
  }
  return false;
}

/** Step 4: a value safe to place inside a double-quoted attribute. */
export function sanitizeAttr(value: string): string {
  return escapeAttr(collapse(sanitizeText(value)));
}

/** Display name: sanitized, single-line, at most 40 code points, "anonymous" if empty. Not escaped. */
export function displayName(name: string): string {
  const short = [...collapse(sanitizeText(name))].slice(0, NAME_MAX_CHARS).join("").trimEnd();
  return short === "" ? ANONYMOUS : short;
}

export function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function collapse(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
