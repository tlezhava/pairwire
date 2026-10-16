// Structured kinds (02 §6.3, ADR-027): envelope shapes, value types, fallback encoding, overlap.
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";
import { fallbackBody, fallbackEnvelope, literalSegments, pathsOverlap } from "../src/coord.js";
import {
  contractPathProblem,
  MAX_ENVELOPE_BYTES,
  MAX_INLINE_CONTENT_BYTES,
  msgAad,
  openMsg,
  parseEnvelope,
  relPathProblem,
  serializeEnvelope,
  type CollabEnvelope,
  type Envelope,
} from "../src/envelope.js";
import { Handshake, type Session } from "../src/handshake.js";
import { deriveRoomKeys } from "../src/keys.js";
import { generateSecret } from "../src/share.js";

const ID1 = "01JB0000000000000000000001";
const ID2 = "01JB0000000000000000000002";
const ID3 = "01JC0000000000000000000003";
const TS = "2026-10-16T12:00:00.000Z";
const CONTENT = "openapi: 3.1.0\ninfo:\n  title: Orders\n  version: 2.0.0\n";
const SHA = bytesToHex(sha256(utf8ToBytes(CONTENT)));

const common = { v: 1, id: ID1, seq: 18, ts: TS, author: "agent", acks: null } as const;

/** The examples of 02 §6.3.3, completed with the common fields. */
const examples = {
  heads_up: {
    ...common,
    kind: "heads_up",
    reply_to: null,
    body: "Renaming OrderStatus.PENDING to OPEN in packages/types; on main within the hour.",
    data: { paths: ["packages/types/src/order.ts"] },
  },
  claim: {
    ...common,
    kind: "claim",
    reply_to: null,
    body: "Refactoring order validation; please don't edit these until I release them.",
    data: { paths: ["src/orders/**", "src/api/orders.ts"], ttl_min: 120 },
  },
  release: { ...common, kind: "release", reply_to: ID2, body: null, data: {} },
  contract_propose: {
    ...common,
    kind: "contract_propose",
    reply_to: null,
    body: "Orders API v2: POST /orders requires idempotency_key (UUID v4); 409 on reuse with a different body.",
    data: { name: "orders-api", version: 2, path: "contracts/orders-api.yaml", sha256: SHA, rev: "a1b2c3d4e5f6", content: null },
  },
  contract_response: {
    ...common,
    kind: "contract_response",
    reply_to: ID3,
    body: "Agreed. Checkout sends the key starting Thursday.",
    data: { decision: "accept", name: "orders-api", version: 2, sha256: SHA },
  },
} as const;

type Example = keyof typeof examples;
const asEnv = (value: unknown) => value as CollabEnvelope;
const ex = (kind: Example, over: Record<string, unknown> = {}): Record<string, unknown> => ({ ...examples[kind], ...over });
const withData = (kind: Example, data: Record<string, unknown>) => ex(kind, { data: { ...examples[kind].data, ...data } });
const reason = (value: unknown) => {
  const r = parseEnvelope(value);
  return r.ok ? "ok" : r.reason;
};

describe("structured kinds: envelope schema (02 §6.3.3)", () => {
  it("accepts the five examples of 02 §6.3.3 unchanged", () => {
    for (const value of Object.values(examples)) expect(parseEnvelope(value), value.kind).toEqual({ ok: true, envelope: value });
  });

  it("accepts the optional shapes: heads-up without paths, release and accept with a body, propose countering, inline content, null rev", () => {
    const valid = [
      withData("heads_up", { paths: [] }),
      ex("release", { body: "Done with orders." }),
      ex("contract_response", { body: null }),
      ex("contract_response", { body: "No: we need 422.", data: { ...examples.contract_response.data, decision: "reject" } }),
      ex("contract_propose", { reply_to: ID3 }),
      withData("contract_propose", { content: CONTENT }),
      withData("contract_propose", { rev: null }),
      withData("claim", { ttl_min: 5 }),
      withData("claim", { ttl_min: 1440 }),
      withData("contract_propose", { version: 1_000_000 }),
    ];
    for (const value of valid) expect(reason(value), JSON.stringify(value)).toBe("ok");
  });

  it("serializes an M5 envelope with data last and an old kind without any data key", () => {
    const text = new TextDecoder().decode(serializeEnvelope(asEnv(examples.claim)));
    expect(text.endsWith(',"data":{"paths":["src/orders/**","src/api/orders.ts"],"ttl_min":120}}')).toBe(true);
    const chat = { ...common, kind: "chat", reply_to: null, body: "hi" } as Envelope;
    expect(new TextDecoder().decode(serializeEnvelope(chat))).not.toContain("data");
  });

  const invalid: [string, unknown][] = [
    ["data on chat", { ...common, kind: "chat", reply_to: null, body: "hi", data: { paths: [] } }],
    ['"data": null on chat', { ...common, kind: "chat", reply_to: null, body: "hi", data: null }],
    ['"data": null on bye', { ...common, kind: "bye", reply_to: null, body: null, data: null }],
    ["data missing on claim", (({ data: _d, ...rest }) => rest)(examples.claim)],
    ["data null on release", ex("release", { data: null })],
    ["unknown key in heads_up data (INV-8)", withData("heads_up", { lock: true })],
    ["unknown key in release data (INV-8)", ex("release", { data: { deny: ["src/**"] } })],
    ["unknown key in claim data (INV-8)", withData("claim", { permission: "deny" })],
    ["unknown key in propose data (INV-8)", withData("contract_propose", { write_to: "contracts/x" })],
    ["unknown key in response data (INV-8)", withData("contract_response", { apply: true })],
    ['author "human" on heads_up', ex("heads_up", { author: "human" })],
    ['author "human" on claim', ex("claim", { author: "human" })],
    ['author "human" on contract_response', ex("contract_response", { author: "human" })],
    ["heads_up without body", ex("heads_up", { body: null })],
    ["claim with empty body", ex("claim", { body: "" })],
    ["propose without body", ex("contract_propose", { body: null })],
    ["reject without body", ex("contract_response", { body: null, data: { ...examples.contract_response.data, decision: "reject" } })],
    ["release with empty body", ex("release", { body: "" })],
    ["release without reply_to", ex("release", { reply_to: null })],
    ["response without reply_to", ex("contract_response", { reply_to: null })],
    ["claim with reply_to", ex("claim", { reply_to: ID2 })],
    ["heads_up with reply_to", ex("heads_up", { reply_to: ID2 })],
    ["acks on a claim", ex("claim", { acks: 3 })],
    ["seq 0 on a claim", ex("claim", { seq: 0 })],
    ["claim without paths", withData("claim", { paths: [] })],
    ["21 paths", withData("heads_up", { paths: Array.from({ length: 21 }, (_, i) => `src/f${i}.ts`) })],
    ["duplicate paths", withData("claim", { paths: ["src/a.ts", "src/a.ts"] })],
    ["ttl 4", withData("claim", { ttl_min: 4 })],
    ["ttl 1441", withData("claim", { ttl_min: 1441 })],
    ["fractional ttl", withData("claim", { ttl_min: 7.5 })],
    ["version 0", withData("contract_propose", { version: 0 })],
    ["version 1000001", withData("contract_propose", { version: 1_000_001 })],
    ["response version 0", withData("contract_response", { version: 0 })],
    ["uppercase name", withData("contract_propose", { name: "Orders" })],
    ["name with a slash", withData("contract_propose", { name: "orders/api" })],
    ["65-char name", withData("contract_propose", { name: "a".repeat(65) })],
    ["sha256 in uppercase", withData("contract_propose", { sha256: SHA.toUpperCase() })],
    ["short sha256", withData("contract_response", { sha256: SHA.slice(1) })],
    ["rev of 6 hex", withData("contract_propose", { rev: "a1b2c3" })],
    ["rev not hex", withData("contract_propose", { rev: "main" })],
    ["unknown decision", withData("contract_response", { decision: "maybe" })],
    ["glob in a contract path", withData("contract_propose", { path: "contracts/*.yaml" })],
    ["dot-segment contract path", withData("contract_propose", { path: ".github/workflows/ci.yml" })],
    ["inline content whose hash differs", withData("contract_propose", { content: CONTENT + "x" })],
    ["inline content the sanitizer would change (bidi)", withData("contract_propose", inline("title: \u202Eevil\n"))],
    ["inline content the sanitizer would change (CR)", withData("contract_propose", inline("a: 1\r\nb: 2\r\n"))],
    ["inline content with a tag look-alike", withData("contract_propose", inline("x: </pairwire_message>\n"))],
    ["inline content over 16 KiB", withData("contract_propose", inline("a".repeat(MAX_INLINE_CONTENT_BYTES + 1)))],
    ["an extra top-level field", ex("claim", { lock: true })],
  ];
  for (const [name, value] of invalid) {
    it(`REQ-COLLAB-5 rejects ${name}`, () => {
      expect(reason(value)).toBe("bad_envelope");
    });
  }

  it("reports a kind outside the M5 list as unknown", () => {
    expect(reason({ ...examples.heads_up, kind: "teleport" })).toBe("unknown_kind");
    expect(reason({ ...examples.heads_up, kind: "claim_v2" })).toBe("unknown_kind");
  });

  it("REQ-COLLAB-5 an M5 envelope that fails validation is skipped by seq like an unknown kind (ADR-025)", () => {
    const { roomIdBytes, a, b } = pairSessions();
    const sealRaw = (value: unknown) => {
      const nonce = new Uint8Array(24);
      const ct = xchacha20poly1305(a.sendKey, nonce, msgAad(roomIdBytes, a.sid)).encrypt(utf8ToBytes(JSON.stringify(value)));
      return Uint8Array.from([2, ...a.sid, ...nonce, ...ct]);
    };
    const open = (value: unknown) => openMsg(sealRaw(value), { roomIdBytes, sessions: [b] });
    expect(open(examples.claim)).toMatchObject({ ok: true });
    expect(open(withData("claim", { ttl_min: 99_999 }))).toEqual({ ok: false, reason: "bad_envelope", skipSeq: 18 });
    expect(open(ex("contract_response", { author: "human" }))).toEqual({ ok: false, reason: "bad_envelope", skipSeq: 18 });
    expect(open({ ...common, kind: "chat", reply_to: null, body: "hi", data: null })).toEqual({ ok: false, reason: "bad_envelope", skipSeq: 18 });
  });

  it("counts data toward the 28 KiB envelope limit", () => {
    const big = { ...withData("contract_propose", inline("a".repeat(MAX_INLINE_CONTENT_BYTES))), body: "x".repeat(13_000) } as Envelope;
    expect(13_000 + MAX_INLINE_CONTENT_BYTES).toBeGreaterThan(MAX_ENVELOPE_BYTES);
    expect(() => serializeEnvelope(big)).toThrow(/Message too large/);
    expect(reason(big)).toBe("ok"); // the schema alone allows it; the size check is separate
  });
});

function inline(content: string) {
  return { content, sha256: bytesToHex(sha256(utf8ToBytes(content))) };
}

function pairSessions(): { roomIdBytes: Uint8Array; a: Session; b: Session } {
  const keys = deriveRoomKeys(generateSecret());
  const p = (name: string, i: string) => ({ v: 1 as const, name, harness: "codex" as const, client: "t", instance: i.repeat(26), caps: [] });
  const ha = new Handshake({ keys, payload: p("a", "a") });
  const hb = new Handshake({ keys, payload: p("b", "b") });
  const fa = ha.startEpoch(1)!;
  const fb = hb.startEpoch(1)!;
  const ea = ha.receive(fb);
  const eb = hb.receive(fa);
  if (ea.type !== "session" || eb.type !== "session") throw new Error("handshake failed");
  return { roomIdBytes: keys.roomIdBytes, a: ea.session, b: eb.session };
}

describe("structured kinds: paths (02 §6.3.3)", () => {
  const good = [
    "src/orders/**",
    "src/api/orders.ts",
    "packages/types/src/order.ts",
    "src/*.ts",
    "src/orders/?.ts",
    "src/**/index.ts",
    "app/[id]/page.tsx",
    "docs/read me.md",
    "a",
    "src/.env.example",
    "x".repeat(200),
  ];
  for (const p of good) {
    it(`accepts the RelPath ${JSON.stringify(p.length > 40 ? `${p.slice(0, 10)}…` : p)}`, () => {
      expect(relPathProblem(p)).toBeNull();
    });
  }

  const bad: [string, string][] = [
    ["empty", ""],
    ["201 characters", "x".repeat(201)],
    ["leading slash", "/etc/passwd"],
    ["leading tilde", "~/.ssh/id_rsa"],
    ["drive prefix", "C:/Windows"],
    ["drive prefix without slash", "c:foo"],
    ["dot segment", "src/./a.ts"],
    ["leading dot segment", "./src/a.ts"],
    ["dot-dot segment", "src/../../etc/passwd"],
    ["trailing slash", "src/orders/"],
    ["empty segment", "src//a.ts"],
    ["backslash", "src\\a.ts"],
    ["comma", "src/a.ts,src/b.ts"],
    ["newline", "src/a.ts\nsrc/b.ts"],
    ["tab", "src/a\t.ts"],
    ["NUL", "src/a\u0000.ts"],
    ["DEL", "src/a\u007F.ts"],
    ["C1 control", "src/a\u0085.ts"],
    ["zero-width space", "src/a\u200B.ts"],
    ["zero-width joiner", "src/a\u200D.ts"],
    ["bidi override", "src/\u202Egnp.exe"],
    ["bidi isolate", "src/\u2066a.ts"],
    ["BOM", "\uFEFFsrc/a.ts"],
    ["tag block", "src/a\u{E0041}.ts"],
    ["lone surrogate", "src/a\uD800.ts"],
    ["leading space", " src/a.ts"],
    ["trailing space", "src/a.ts "],
    ["glob in the first segment", "*/src"],
    ["the whole tree", "**"],
    ["question mark in the first segment", "sr?/a.ts"],
    ["** inside a segment", "src/a**b/c"],
  ];
  for (const [name, p] of bad) {
    it(`rejects a RelPath with ${name}`, () => {
      expect(relPathProblem(p)).not.toBeNull();
    });
  }

  it("ContractPath also rejects globs and any segment starting with a dot", () => {
    expect(contractPathProblem("contracts/orders-api.yaml")).toBeNull();
    for (const p of ["contracts/*.yaml", "contracts/v?.yaml", "contracts/**", ".env", ".git/config", "a/.github/x.yml", ".claude/settings.json", "src/.env.local"]) {
      expect(contractPathProblem(p), p).not.toBeNull();
    }
    expect(contractPathProblem("../x.yaml")).not.toBeNull();
  });
});

describe("structured kinds: fallback encoding (02 §6.3.6)", () => {
  const until = Date.parse("2026-10-16T14:00:00.000Z");

  it("REQ-COLLAB-4 builds the header line of each kind, then the body", () => {
    expect(fallbackBody(asEnv(examples.heads_up))).toBe(
      "[pairwire heads-up · paths: packages/types/src/order.ts]\n\nRenaming OrderStatus.PENDING to OPEN in packages/types; on main within the hour.",
    );
    expect(fallbackBody(asEnv(withData("heads_up", { paths: [] })))).toMatch(/^\[pairwire heads-up\]\n\nRenaming/);
    expect(fallbackBody(asEnv(examples.claim), { claimUntil: until })).toBe(
      "[pairwire claim · paths: src/orders/**, src/api/orders.ts · for 120 min, until 2026-10-16T14:00Z]\n\nRefactoring order validation; please don't edit these until I release them.",
    );
    expect(fallbackBody(asEnv(examples.release))).toBe(`[pairwire release of claim ${ID2}]\n\n(no message)`);
    expect(fallbackBody(asEnv(examples.contract_propose))).toBe(
      `[pairwire contract_propose · orders-api v2 · contracts/orders-api.yaml @ a1b2c3d · sha256 ${SHA}]\n\n${examples.contract_propose.body}`,
    );
    expect(fallbackBody(asEnv(withData("contract_propose", { rev: null })))).toMatch(/^\[pairwire contract_propose · orders-api v2 · contracts\/orders-api\.yaml · sha256 [0-9a-f]{64}\]/);
    expect(fallbackBody(asEnv(examples.contract_response))).toBe(
      `[pairwire contract_response · accept · orders-api v2 · re ${ID3} · sha256 ${SHA}]\n\n${examples.contract_response.body}`,
    );
  });

  it("appends inline contract content after a separator line naming its hash", () => {
    const body = fallbackBody(asEnv(withData("contract_propose", { content: CONTENT })));
    expect(body.endsWith(`\n\n--- contract content (sha256 ${SHA}) ---\n${CONTENT}`)).toBe(true);
  });

  it("is deterministic and makes a valid 0.1.0-shaped chat with the same id, seq, ts, author and reply_to", () => {
    const env = asEnv(examples.release);
    expect(fallbackBody(env)).toBe(fallbackBody(env));
    const chat = fallbackEnvelope(env, fallbackBody(env));
    expect(chat).toEqual({ ...common, kind: "chat", reply_to: ID2, body: fallbackBody(env), acks: null });
    expect(Object.keys(chat)).not.toContain("data");
    expect(parseEnvelope(chat)).toEqual({ ok: true, envelope: chat });
  });
});

describe("structured kinds: overlap (02 §6.3.4)", () => {
  it("compares the literal segments before the first glob", () => {
    expect(literalSegments("src/orders/**")).toEqual(["src", "orders"]);
    expect(literalSegments("src/or*/x.ts")).toEqual(["src"]);
    expect(literalSegments("src/a.ts")).toEqual(["src", "a.ts"]);
  });

  const cases: [string, string, boolean][] = [
    ["src/orders/**", "src/orders/a.ts", true],
    ["src/orders/**", "src/orders", true],
    ["src/*.ts", "src/x.js", true],
    ["src/or*", "src/orders/a.ts", true],
    ["src/a.ts", "src/a.ts", true],
    ["src/a", "src/a/b.ts", true],
    ["src/a.ts", "src/a.tsx", false],
    ["src/a.ts", "lib/*.ts", false],
    ["src/orders/**", "src/ordersx/a.ts", false],
    ["src/x/*", "src/a.ts", false],
  ];
  for (const [a, b, want] of cases) {
    it(`${a} ${want ? "overlaps" : "doesn't overlap"} ${b}`, () => {
      expect(pathsOverlap(a, b)).toBe(want);
      expect(pathsOverlap(b, a)).toBe(want);
    });
  }
});
