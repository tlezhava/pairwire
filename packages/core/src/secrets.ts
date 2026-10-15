// Outbound secret scanner and log redaction (04 §7.3, INV-5, INV-7). Findings carry rule
// ids and offsets only, never the matched text.

export const SECRET_RULES_VERSION = 1;

export type SecretRuleId =
  | "pairwire_share"
  | "pem_private_key"
  | "aws_access_key_id"
  | "github_token"
  | "slack_token"
  | "anthropic_key"
  | "openai_key"
  | "stripe_live_key"
  | "google_api_key"
  | "jwt"
  | "secret_assignment";

export interface SecretFinding {
  rule: SecretRuleId;
  /** UTF-16 offset into the scanned text. */
  offset: number;
  length: number;
}

interface Rule {
  id: SecretRuleId;
  /** Global; every quantifier is bounded or unambiguous, so matching stays linear. */
  pattern: RegExp;
}

/** Order matters: on identical ranges the earlier rule is reported. */
const RULES: readonly Rule[] = [
  { id: "pairwire_share", pattern: /pw1_[a-z2-7]{52}(?:@(?:[a-z0-9.-]{1,253}|\[::1\])(?::[0-9]{1,5})?)?/gi },
  { id: "pem_private_key", pattern: /-----BEGIN (?:[A-Z0-9]{1,16} ){0,4}PRIVATE KEY(?: BLOCK)?-----/g },
  { id: "aws_access_key_id", pattern: /(?<![A-Z0-9])(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}(?![A-Z0-9])/g },
  {
    id: "github_token",
    pattern: /(?<![A-Za-z0-9_])(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})(?![A-Za-z0-9_])/g,
  },
  { id: "slack_token", pattern: /(?<![A-Za-z0-9])xox[abprs]-[A-Za-z0-9-]{10,}/g },
  { id: "anthropic_key", pattern: /(?<![A-Za-z0-9_-])sk-ant-[A-Za-z0-9_-]{20,}/g },
  { id: "openai_key", pattern: /(?<![A-Za-z0-9_-])sk-(?!ant-)[A-Za-z0-9_-]{20,}/g },
  { id: "stripe_live_key", pattern: /(?<![A-Za-z0-9])[sr]k_live_[A-Za-z0-9]{20,}/g },
  { id: "google_api_key", pattern: /(?<![A-Za-z0-9_-])AIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/g },
  { id: "jwt", pattern: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
];

const ASSIGNMENT_NAME = /^[A-Za-z0-9_.-]*(?:key|secret|token|password|passwd|pwd)[A-Za-z0-9_.-]*$/i;
const NAME_CHAR = /[A-Za-z0-9_.-]/;
const VALUE_STOP = /[\s"'`,;]/;
/** Bounds that keep the assignment scan linear in the input (no regex backtracking). */
const MAX_NAME = 64;
const MAX_VALUE = 256;

/** Format characters (and the tag block) a sender might use to split a secret. */
const SPLITTERS = /[\p{Cf}\u{E0000}-\u{E007F}]/u;

export function scanSecrets(text: string): SecretFinding[] {
  const found = scanPlain(text);
  if (SPLITTERS.test(text)) {
    const { stripped, map } = stripSplitters(text);
    for (const f of scanPlain(stripped)) {
      const start = map[f.offset]!;
      const lastUnit = f.offset + f.length - 1;
      found.push({ rule: f.rule, offset: start, length: map[lastUnit]! + 1 - start });
    }
  }
  return dedupe(found);
}

/** Replaces share strings (with any @host suffix) and every scanner match with [redacted:<rule>]. */
export function redact(text: string): string {
  let out = text;
  for (const f of [...scanSecrets(text)].sort((a, b) => b.offset - a.offset)) {
    out = out.slice(0, f.offset) + `[redacted:${f.rule}]` + out.slice(f.offset + f.length);
  }
  return out;
}

function scanPlain(text: string): SecretFinding[] {
  const out: SecretFinding[] = [];
  for (const rule of RULES) {
    for (const m of text.matchAll(rule.pattern)) out.push({ rule: rule.id, offset: m.index, length: m[0].length });
  }
  return out.concat(scanAssignments(text));
}

/**
 * `<name containing key|secret|token|password|passwd|pwd> [:=] ["'`]?<value>` with a
 * high-entropy value. Hand-written so its cost is linear: each `:` or `=` looks back at most
 * MAX_NAME characters and forward at most MAX_VALUE.
 */
function scanAssignments(text: string): SecretFinding[] {
  const out: SecretFinding[] = [];
  for (let op = 0; op < text.length; op++) {
    const c = text[op];
    if (c !== ":" && c !== "=") continue;
    let nameEnd = op;
    while (nameEnd > 0 && op - nameEnd < MAX_NAME && /[ \t]/.test(text[nameEnd - 1]!)) nameEnd--;
    let nameStart = nameEnd;
    while (nameStart > 0 && nameEnd - nameStart < MAX_NAME && NAME_CHAR.test(text[nameStart - 1]!)) nameStart--;
    if (nameStart > 0 && /[A-Za-z0-9]/.test(text[nameStart - 1]!)) continue;
    if (!ASSIGNMENT_NAME.test(text.slice(nameStart, nameEnd))) continue;
    let v = op + 1;
    while (v < text.length && v - op <= MAX_NAME && /\s/.test(text[v]!)) v++;
    if (v < text.length && /["'`]/.test(text[v]!)) v++;
    let vEnd = v;
    while (vEnd < text.length && vEnd - v < MAX_VALUE && !VALUE_STOP.test(text[vEnd]!)) vEnd++;
    if (isHighEntropy(text.slice(v, vEnd))) out.push({ rule: "secret_assignment", offset: v, length: vEnd - v });
  }
  return out;
}

/**
 * Specific rules first: a finding contained in an earlier, wider one is dropped (rule order
 * breaks ties). The generic `secret_assignment` is kept only where no specific rule matched.
 */
function dedupe(findings: SecretFinding[]): SecretFinding[] {
  const order = new Map(RULES.map((r, i) => [r.id, i]));
  const sorted = [...findings].sort(
    (a, b) => a.offset - b.offset || b.length - a.length || order.get(a.rule)! - order.get(b.rule)!,
  );
  const end = (f: SecretFinding) => f.offset + f.length;
  const kept: SecretFinding[] = [];
  for (const f of sorted.filter((f) => f.rule !== "secret_assignment")) {
    if (!kept.some((k) => f.offset >= k.offset && end(f) <= end(k))) kept.push(f);
  }
  const specific = [...kept];
  for (const f of sorted.filter((f) => f.rule === "secret_assignment")) {
    if (!specific.some((k) => f.offset < end(k) && k.offset < end(f))) kept.push(f);
  }
  return kept.sort((a, b) => a.offset - b.offset);
}

/** The text without splitter characters, and for each kept UTF-16 unit its original offset. */
function stripSplitters(text: string): { stripped: string; map: number[] } {
  let stripped = "";
  const map: number[] = [];
  let offset = 0;
  for (const ch of text) {
    if (!SPLITTERS.test(ch)) {
      stripped += ch;
      for (let i = 0; i < ch.length; i++) map.push(offset + i);
    }
    offset += ch.length;
  }
  return { stripped, map };
}

/** At least 16 characters, a letter and a digit, and >= 3.0 bits of Shannon entropy per character. */
function isHighEntropy(value: string): boolean {
  if (value.length < 16 || !/[A-Za-z]/.test(value) || !/[0-9]/.test(value)) return false;
  const counts = new Map<string, number>();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  const n = [...value].length;
  let bits = 0;
  for (const c of counts.values()) bits -= (c / n) * Math.log2(c / n);
  return bits >= 3.0;
}
