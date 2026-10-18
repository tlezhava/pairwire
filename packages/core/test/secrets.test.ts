import { describe, expect, it } from "vitest";
import { SECRET_RULES_VERSION, redact, scanSecrets, type SecretRuleId } from "../src/secrets.js";

// Samples are assembled at runtime so no token-shaped literal is committed to the repo.
let seed = 42;
const rnd = (alphabet: string, n: number) =>
  Array.from({ length: n }, () => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return alphabet[(seed >>> 16) % alphabet.length];
  }).join("");
const UP = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const LOW = "abcdefghijklmnopqrstuvwxyz";
const DIG = "0123456789";
const ALNUM = UP + LOW + DIG;
const B64URL = ALNUM + "-_";
const j = (...parts: string[]) => parts.join("");

const SHARE = j("pw", "1_", "aaaqeayeaudaocajbifqydiob4ibceqtcqkrmfyydenbwha5dypq");

const samples: Record<SecretRuleId, { positive: string[]; negative: string[] }> = {
  pairwire_share: {
    positive: [SHARE, `Join with ${SHARE.toUpperCase()} please`, `${SHARE}@relay.example.com:8443`],
    negative: [SHARE.slice(0, -1), j("pw", "2_", SHARE.slice(4)), j("pw", "1_", "1".repeat(52))],
  },
  pem_private_key: {
    positive: [
      j("-----BEGIN ", "RSA PRIVATE KEY-----\nMIIE..."),
      j("-----BEGIN ", "OPENSSH PRIVATE KEY-----"),
      j("key:\n-----BEGIN ", "PRIVATE KEY-----"),
      j("-----BEGIN ", "EC PRIVATE KEY-----"),
    ],
    negative: ["-----BEGIN PUBLIC KEY-----", "-----BEGIN CERTIFICATE-----", "rotate the private key every 90 days"],
  },
  aws_access_key_id: {
    positive: [j("AK", "IA", rnd(UP + DIG, 16)), j("id=AS", "IA", rnd(UP + DIG, 16), ";"), j("(AK", "IA", rnd(UP + DIG, 16), ")")],
    negative: [j("AK", "IA", rnd(UP + DIG, 15)), j("ak", "ia", rnd(LOW + DIG, 16)), j("XAK", "IA", rnd(UP + DIG, 16), "Z")],
  },
  github_token: {
    positive: [j("gh", "p_", rnd(ALNUM, 36)), j("gh", "o_", rnd(ALNUM, 36)), j("gh", "s_", rnd(ALNUM, 36)), j("github", "_pat_", rnd(ALNUM + "_", 82))],
    negative: [j("gh", "p_", rnd(ALNUM, 10)), j("gh", "x_", rnd(ALNUM, 36)), j("github", "pat", rnd(ALNUM, 40))],
  },
  slack_token: {
    positive: [j("xo", "xb-", rnd(DIG, 12), "-", rnd(ALNUM, 24)), j("xo", "xp-", rnd(DIG, 12), "-", rnd(ALNUM, 32)), j("xo", "xa-2-", rnd(ALNUM, 20))],
    negative: [j("xo", "xz-", rnd(ALNUM, 24)), j("xo", "xb", rnd(ALNUM, 24)), j("xo", "xb-", "short")],
  },
  anthropic_key: {
    positive: [j("sk", "-ant-api03-", rnd(B64URL, 93)), j("key=sk", "-ant-", rnd(B64URL, 40)), j('"sk', "-ant-admin01-", rnd(B64URL, 50), '"')],
    negative: [j("sk", "-ant-", "short"), j("desk", "-ant-", rnd(LOW, 30), "!"), "the sk-ant prefix identifies Anthropic keys"],
  },
  openai_key: {
    positive: [j("sk", "-proj-", rnd(B64URL, 64)), j("sk", "-", rnd(ALNUM, 48)), j("OPENAI=sk", "-svcacct-", rnd(B64URL, 40))],
    negative: [j("sk", "-", "short"), j("risk", "-assessment-document-version-two"), j("task", "-", rnd(LOW, 30))],
  },
  stripe_live_key: {
    positive: [j("sk", "_live_", rnd(ALNUM, 24)), j("rk", "_live_", rnd(ALNUM, 32)), j("STRIPE=sk", "_live_", rnd(ALNUM, 99))],
    negative: [j("sk", "_test_", rnd(ALNUM, 24)), j("pk", "_live_", rnd(ALNUM, 24)), j("sk", "_live_", "short")],
  },
  google_api_key: {
    positive: [j("AI", "za", rnd(B64URL, 35)), j("key=AI", "za", rnd(B64URL, 35), "&x=1"), j("'AI", "za", rnd(B64URL, 35), "'")],
    negative: [j("AI", "za", rnd(B64URL, 20)), j("ai", "za", rnd(B64URL, 35)), j("AI", "zb", rnd(B64URL, 35))],
  },
  jwt: {
    positive: [
      j("ey", "JhbGciOiJIUzI1NiJ9.", "ey", "JzdWIiOiIxMjM0NTY3ODkwIn0.", rnd(B64URL, 43)),
      j("Bearer ey", "J", rnd(B64URL, 20), ".ey", "J", rnd(B64URL, 40), ".", rnd(B64URL, 43)),
      j("token: ey", "J", rnd(B64URL, 30), ".ey", "J", rnd(B64URL, 30), ".", rnd(B64URL, 30)),
    ],
    negative: [j("ey", "J", rnd(B64URL, 20), ".ey", "J", rnd(B64URL, 20)), j("ey", "Jab.ey", "Jcd.ef"), j("ab", "J", rnd(B64URL, 20), ".ey", "J", rnd(B64URL, 20), ".", rnd(B64URL, 20))],
  },
  secret_assignment: {
    positive: [
      j("API_KEY=", '"', rnd(ALNUM, 32), '"'),
      j("password: '", "Xk29", rnd(ALNUM, 14), "'"),
      j("client_secret = ", rnd(LOW + DIG, 24)),
      j("db.token=", rnd(ALNUM + "+/", 40)),
    ],
    negative: [
      'password = "hunter2"',
      j("token = ", '"', "a".repeat(24), '"'),
      "key = someVariableNameHere",
      "if (token === expectedTokenValue) return;",
      "keyboard layout: QWERTY1234567890ABCDEF",
    ],
  },
};

describe("INV-5 secret scanner rules (04 §7.3)", () => {
  it("is versioned", () => {
    expect(SECRET_RULES_VERSION).toBe(1);
  });

  for (const [rule, { positive, negative }] of Object.entries(samples) as [SecretRuleId, (typeof samples)[SecretRuleId]][]) {
    it(`INV-5 ${rule}: blocks each positive sample`, () => {
      for (const text of positive) expect(scanSecrets(text).map((f) => f.rule), text).toContain(rule);
    });

    it(`INV-5 ${rule}: allows each negative sample`, () => {
      for (const text of negative) expect(scanSecrets(text).map((f) => f.rule), text).not.toContain(rule);
    });
  }

  it("INV-5 never returns the matched text, only rule ids and offsets", () => {
    const secret = j("gh", "p_", rnd(ALNUM, 36));
    const text = `here: ${secret} and ${SHARE}`;
    const findings = scanSecrets(text);
    expect(findings).toEqual([
      { rule: "github_token", offset: 6, length: secret.length },
      { rule: "pairwire_share", offset: 6 + secret.length + 5, length: SHARE.length },
    ]);
    const serialized = JSON.stringify(findings);
    expect(serialized).not.toContain(secret.slice(4, 14));
    expect(serialized).not.toContain(SHARE.slice(4, 14));
  });

  it("INV-5 sees through zero-width characters inserted into a secret", () => {
    const split = [...SHARE].join("\u200B");
    const findings = scanSecrets(`x ${split}`);
    expect(findings).toEqual([{ rule: "pairwire_share", offset: 2, length: split.length }]);
  });

  it("INV-5 sees through every character the receiving sanitizer removes (ADR-030)", () => {
    const gh = j("gh", "p_", rnd(ALNUM, 36));
    const splitters = ["\u0001", "\u007F", "\u0085", "\u009B", "\u001B", "\u{E0100}", "\uFE0F", "\u034F", "\u3164", "\u115F", "\u180B", "\u0301", "\u200D"];
    for (const s of splitters) {
      const split = gh.slice(0, 8) + s + gh.slice(8);
      expect(scanSecrets(`x ${split} y`), JSON.stringify(s)).toEqual([{ rule: "github_token", offset: 2, length: split.length }]);
      const share = SHARE.slice(0, 10) + s + SHARE.slice(10, 30) + s + SHARE.slice(30);
      expect(scanSecrets(share), JSON.stringify(s)).toEqual([{ rule: "pairwire_share", offset: 0, length: share.length }]);
    }
  });

  it("INV-5 sees through compatibility look-alikes such as U+212A KELVIN SIGN and fullwidth letters (ADR-030)", () => {
    const kelvin = j("gh", "p_", "K".repeat(4), rnd(ALNUM, 32)).replace(/K/g, "\u212A");
    expect(scanSecrets(kelvin)).toEqual([{ rule: "github_token", offset: 0, length: kelvin.length }]);
    const shareKelvin = SHARE.replace(/[kq]/g, (c) => (c === "q" ? "\uFF51" : "\u212A"));
    expect(shareKelvin).not.toBe(SHARE);
    expect(scanSecrets(`join ${shareKelvin}`)).toEqual([{ rule: "pairwire_share", offset: 5, length: shareKelvin.length }]);
    const fullwidth = [...SHARE].map((c) => String.fromCodePoint(c.codePointAt(0)! + 0xfee0)).join("");
    expect(scanSecrets(fullwidth).map((f) => f.rule)).toEqual(["pairwire_share"]);
  });

  it("INV-5 maps offsets back past astral splitters", () => {
    const split = [...SHARE].join("\u{E0100}");
    expect(scanSecrets(`ab ${split} cd`)).toEqual([{ rule: "pairwire_share", offset: 3, length: split.length }]);
  });

  it("finds nothing in prose that only uses ordinary non-ASCII text", () => {
    expect(scanSecrets("Caf\u00E9 na\u00EFve \u2764\uFE0F \u65E5\u672C\u8A9E r\u00E9sum\u00E9 \u{1F44D}\u{1F3FD} \u212B")).toEqual([]);
  });

  it("reports an Anthropic key once, not also as an OpenAI key", () => {
    const key = j("sk", "-ant-api03-", rnd(B64URL, 93));
    expect(scanSecrets(key).map((f) => f.rule)).toEqual(["anthropic_key"]);
  });

  it("finds nothing in ordinary engineering prose and code", () => {
    const prose = [
      "POST /orders accepts a client-generated Idempotency-Key header (UUID v4).",
      "const key = map.get(id); if (!key) throw new Error('missing');",
      "Bump eslint to 10.12.0 and run npm ci; the sha is 3f2a9c1.",
      "export const SECRET_RULES_VERSION = 1;",
    ].join("\n");
    expect(scanSecrets(prose)).toEqual([]);
  });
});

describe("INV-7 redact()", () => {
  it("INV-7 redacts share strings with their relay suffix and every scanner match", () => {
    const gh = j("gh", "p_", rnd(ALNUM, 36));
    const out = redact(`join ${SHARE}@relay.example.com:8443 then use ${gh}.`);
    expect(out).toBe("join [redacted:pairwire_share] then use [redacted:github_token].");
  });

  it("INV-7 redacts uppercase share strings and leaves clean text unchanged", () => {
    expect(redact(SHARE.toUpperCase())).toBe("[redacted:pairwire_share]");
    expect(redact("nothing to see")).toBe("nothing to see");
  });

  it("INV-7 redacts share strings and tokens hidden by controls or look-alikes (ADR-030)", () => {
    const gh = j("gh", "p_", rnd(ALNUM, 36));
    const ctl = SHARE.slice(0, 12) + "\u0001" + SHARE.slice(12);
    const kelvin = SHARE.replace(/k/g, "\u212A");
    expect(redact(`a ${ctl} b ${gh.slice(0, 6)}\u007F${gh.slice(6)} c ${kelvin}@relay.example.com d`)).toBe(
      "a [redacted:pairwire_share] b [redacted:github_token] c [redacted:pairwire_share] d",
    );
  });
});

describe("INV-5 scanner cost on hostile input", () => {
  // The scanner runs on 24 KiB bodies the agent writes and inside redact() on log lines,
  // so no input may trigger super-linear backtracking.
  const N = 24 * 1024;
  const cases: Record<string, string> = {
    "key repeated": "key".repeat(N / 3),
    "token-x repeated": "token-x".repeat(N / 7),
    "assignments without values": "token=".repeat(N / 6),
    "a=a= chains": "secret=a".repeat(N / 8),
    "underscore runs": "a_".repeat(N / 2),
    "PEM words": "-----BEGIN " + "AB ".repeat(N / 3),
    "share prefix spam": "pw1_".repeat(N / 4),
    "jwt fragments": "eyJaaaaaaaaaaa.".repeat(N / 15),
    "slack fragments": "xoxb-".repeat(N / 5),
    "zero-width spam": "k\u200Be\u200By=".repeat(N / 7),
    "control spam": "k\u0001e\u007Fy=".repeat(N / 7),
    "Kelvin share prefix spam": "pw1_\u212A".repeat(N / 5),
    "variation selector spam": "a\u{E0100}".repeat(N / 3),
  };
  for (const [name, text] of Object.entries(cases)) {
    it(`INV-5 scans 24 KiB of ${name} in under 250 ms`, () => {
      const start = performance.now();
      scanSecrets(text);
      redact(text);
      expect(performance.now() - start).toBeLessThan(250);
    });
  }
});
