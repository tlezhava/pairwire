// Inbound sanitizer (04 §5, INV-3). Every delivery path renders peer text through this
// module via render.ts; nothing else may inject a peer-supplied string.

/** Steps 2: format characters except ZWJ, the tag block, and C0/C1 controls except \n and \t. */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const REMOVE = /(?!\u200D)\p{Cf}|[\u{E0000}-\u{E007F}]|[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/gu;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
/** Step 3: a `<` that could open or close our wrapper or a harness tag. The lookahead is
 * unambiguous (one way to split whitespace around `/`), so it stays linear. */
const TAG_LOOKALIKE = /<(?=\s*(?:\/\s*)?(?:pairwire_message|system-reminder|system|channel|function|antml|pairwire))/gi;

export const NAME_MAX_CHARS = 40;
export const ANONYMOUS = "anonymous";

/** Steps 1–3: for message bodies and as the first stage of every attribute value. */
export function sanitizeText(text: string): string {
  return text
    .replace(LONE_SURROGATE, "\uFFFD")
    .normalize("NFC")
    .replace(REMOVE, "")
    .normalize("NFC")
    .replace(TAG_LOOKALIKE, "\u2039");
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
