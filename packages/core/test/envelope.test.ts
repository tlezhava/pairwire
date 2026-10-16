import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";
import {
  EnvelopeTooLargeError,
  MAX_BODY_BYTES,
  MAX_ENVELOPE_BYTES,
  makeAck,
  msgAad,
  openMsg,
  parseEnvelope,
  receiveDecision,
  sealMsg,
  serializeEnvelope,
  type Envelope,
} from "../src/envelope.js";
import { Handshake, type Session } from "../src/handshake.js";
import { deriveRoomKeys } from "../src/keys.js";
import { generateSecret } from "../src/share.js";

const ID1 = "01JABCDEFGHJKMNPQRSTVWXYZ0";
const ID2 = "01JABCDEFGHJKMNPQRSTVWXYZ1";
const TS = "2026-10-15T12:00:00.000Z";

const chat = (over: Partial<Envelope> = {}): Envelope => ({
  v: 1,
  id: ID1,
  seq: 1,
  ts: TS,
  author: "agent",
  kind: "chat",
  reply_to: null,
  body: "hello",
  acks: null,
  ...over,
});

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

describe("envelope schema (02 §6)", () => {
  it("accepts every kind in its valid shape", () => {
    const valid: Envelope[] = [
      chat(),
      chat({ kind: "question", body: "Does POST /orders accept an idempotency key?" }),
      chat({ kind: "answer", reply_to: ID2, body: "Yes." }),
      chat({ kind: "chat", reply_to: ID2 }),
      chat({ kind: "bye", body: null }),
      chat({ kind: "bye", body: "Thanks, ending the room." }),
      chat({ author: "human" }),
      makeAck(17, ID2, TS),
    ];
    for (const env of valid) expect(parseEnvelope(env), JSON.stringify(env)).toEqual({ ok: true, envelope: env });
  });

  it("builds acks with seq 0, the cumulative acks value and no body", () => {
    expect(makeAck(17, ID2, TS)).toEqual({
      v: 1,
      id: ID2,
      seq: 0,
      ts: TS,
      author: "agent",
      kind: "ack",
      reply_to: null,
      body: null,
      acks: 17,
    });
  });

  const invalid: [string, unknown][] = [
    ["v 2", chat({ v: 2 as 1 })],
    ["id not a ULID", chat({ id: "not-a-ulid" })],
    ["lowercase ULID", chat({ id: ID1.toLowerCase() })],
    ["seq 0 on chat", chat({ seq: 0 })],
    ["negative seq", chat({ seq: -1 })],
    ["fractional seq", chat({ seq: 1.5 })],
    ["ts not ISO", chat({ ts: "yesterday" })],
    ["ts with offset", chat({ ts: "2026-10-15T12:00:00+02:00" })],
    ["unknown author", chat({ author: "system" as "agent" })],
    ["answer without reply_to", chat({ kind: "answer", reply_to: null })],
    ["reply_to not a ULID", chat({ kind: "answer", reply_to: "x" })],
    ["chat without body", chat({ body: null })],
    ["question with empty body", chat({ kind: "question", body: "" })],
    ["acks on a chat", chat({ acks: 3 })],
    ["ack with seq 1", { ...makeAck(1, ID2, TS), seq: 1 }],
    ["ack without acks", { ...makeAck(1, ID2, TS), acks: null }],
    ["ack with a body", { ...makeAck(1, ID2, TS), body: "hi" }],
    ["ack with reply_to", { ...makeAck(1, ID2, TS), reply_to: ID1 }],
    ["missing field", (({ acks: _a, ...rest }) => rest)(chat())],
    ["not an object", "hello"],
  ];
  for (const [name, value] of invalid) {
    it(`rejects ${name}`, () => {
      expect(parseEnvelope(value)).toEqual({ ok: false, reason: "bad_envelope" });
    });
  }

  it("reports unknown and reserved kinds separately so they can be counted, not shown", () => {
    for (const kind of ["heads_up", "claim", "contract_propose", "teleport"]) {
      expect(parseEnvelope({ ...chat(), kind })).toEqual({ ok: false, reason: "unknown_kind" });
    }
  });

  it("INV-8 rejects envelopes carrying extra fields such as config, hop_budget or relay", () => {
    for (const extra of [{ config: { delivery: "pull" } }, { hop_budget: 999 }, { relay: "evil.example" }, { permissions: ["*"] }]) {
      expect(parseEnvelope({ ...chat(), ...extra })).toEqual({ ok: false, reason: "bad_envelope" });
    }
  });
});

describe("envelope size limits (02 §6)", () => {
  it("accepts a body of exactly 24 KiB of UTF-8", () => {
    const body = "a".repeat(MAX_BODY_BYTES);
    expect(serializeEnvelope(chat({ body })).length).toBeLessThanOrEqual(MAX_ENVELOPE_BYTES);
  });

  it("measures the body in UTF-8 bytes, not characters", () => {
    const body = "ж".repeat(MAX_BODY_BYTES / 2 + 1); // 2 bytes each
    expect(() => serializeEnvelope(chat({ body }))).toThrow(EnvelopeTooLargeError);
  });

  it("rejects a body under 24 KiB whose serialized envelope exceeds 28 KiB", () => {
    for (const body of ['"'.repeat(20_000), "\u0001".repeat(5_000), "\n".repeat(15_000)]) {
      expect(utf8ToBytes(body).length).toBeLessThan(MAX_BODY_BYTES);
      let err: unknown;
      try {
        serializeEnvelope(chat({ body }));
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(EnvelopeTooLargeError);
      const tooLarge = err as EnvelopeTooLargeError;
      expect(tooLarge.code).toBe("too_large");
      expect(tooLarge.envelopeBytes).toBeGreaterThan(MAX_ENVELOPE_BYTES);
      expect(tooLarge.bodyBytes).toBe(utf8ToBytes(body).length);
      expect(tooLarge.message).toContain(String(tooLarge.envelopeBytes));
    }
  });

  it("refuses to serialize an envelope that fails the schema", () => {
    expect(() => serializeEnvelope(chat({ kind: "answer", reply_to: null }))).toThrow();
  });
});

describe("MSG frames (02 §3, §6)", () => {
  it("has the layout 0x02 || sid || nonce || ciphertext, sealed with the sender's key", () => {
    const { roomIdBytes, a } = pairSessions();
    const nonce = new Uint8Array(24).fill(7);
    const frame = sealMsg({ roomIdBytes, session: a, envelope: chat(), nonce });
    expect(frame[0]).toBe(0x02);
    expect(frame.subarray(1, 9)).toEqual(a.sid);
    expect(frame.subarray(9, 33)).toEqual(nonce);
    const aad = msgAad(roomIdBytes, a.sid);
    expect(bytesToHex(aad.subarray(0, 15))).toBe(bytesToHex(utf8ToBytes("pairwire/v1/msg")));
    const plain = xchacha20poly1305(a.sendKey, nonce, aad).decrypt(frame.subarray(33));
    expect(JSON.parse(new TextDecoder().decode(plain))).toEqual(chat());
  });

  it("round-trips between the two sides of a session, in both directions", () => {
    const { roomIdBytes, a, b } = pairSessions();
    const ab = openMsg(sealMsg({ roomIdBytes, session: a, envelope: chat() }), { roomIdBytes, sessions: [b] });
    expect(ab).toEqual({ ok: true, envelope: chat(), sid: a.sid });
    const ba = openMsg(sealMsg({ roomIdBytes, session: b, envelope: makeAck(1, ID2, TS) }), { roomIdBytes, sessions: [a] });
    expect(ba.ok && ba.envelope.kind).toBe("ack");
  });

  it("cannot be opened with the sender's own session (keys are per direction)", () => {
    const { roomIdBytes, a } = pairSessions();
    const frame = sealMsg({ roomIdBytes, session: a, envelope: chat() });
    expect(openMsg(frame, { roomIdBytes, sessions: [a] })).toEqual({ ok: false, reason: "decrypt_failed" });
  });

  it("fails when any bit of the sid, nonce or ciphertext is flipped", () => {
    const { roomIdBytes, a, b } = pairSessions();
    const frame = sealMsg({ roomIdBytes, session: a, envelope: chat() });
    for (let i = 1; i < frame.length; i++) {
      const tampered = frame.slice();
      tampered[i]! ^= 0x80;
      const r = openMsg(tampered, { roomIdBytes, sessions: [b] });
      // A flipped sid byte selects no session; anything else fails authentication.
      expect(r, `byte ${i}`).toEqual({ ok: false, reason: i < 9 ? "unknown_sid" : "decrypt_failed" });
    }
  });

  it("fails under a different room id (AAD binding)", () => {
    const { roomIdBytes, a, b } = pairSessions();
    const frame = sealMsg({ roomIdBytes, session: a, envelope: chat() });
    expect(openMsg(frame, { roomIdBytes: new Uint8Array(16), sessions: [b] })).toEqual({ ok: false, reason: "decrypt_failed" });
  });

  it("drops a frame whose sid matches no stored session", () => {
    const { roomIdBytes, a } = pairSessions();
    const other = pairSessions();
    const frame = sealMsg({ roomIdBytes, session: a, envelope: chat() });
    expect(openMsg(frame, { roomIdBytes, sessions: [other.b] })).toEqual({ ok: false, reason: "unknown_sid" });
  });

  it("decrypts frames buffered under the previous session after a new handshake", () => {
    const old = pairSessions();
    const buffered = sealMsg({ roomIdBytes: old.roomIdBytes, session: old.a, envelope: chat() });
    const fresh: Session = { sid: new Uint8Array(8).fill(1), sendKey: new Uint8Array(32), recvKey: new Uint8Array(32) };
    const r = openMsg(buffered, { roomIdBytes: old.roomIdBytes, sessions: [fresh, old.b] });
    expect(r.ok && r.envelope).toEqual(chat());
  });

  it("rejects non-MSG and truncated frames, and envelopes that fail validation after decryption", () => {
    const { roomIdBytes, a, b } = pairSessions();
    const frame = sealMsg({ roomIdBytes, session: a, envelope: chat() });
    const hello = frame.slice();
    hello[0] = 0x01;
    expect(openMsg(hello, { roomIdBytes, sessions: [b] })).toEqual({ ok: false, reason: "malformed" });
    expect(openMsg(frame.subarray(0, 40), { roomIdBytes, sessions: [b] })).toEqual({ ok: false, reason: "malformed" });

    const sealRaw = (plain: string) => {
      const nonce = new Uint8Array(24);
      const ct = xchacha20poly1305(a.sendKey, nonce, msgAad(roomIdBytes, a.sid)).encrypt(utf8ToBytes(plain));
      return Uint8Array.from([2, ...a.sid, ...nonce, ...ct]);
    };
    expect(openMsg(sealRaw("{nope"), { roomIdBytes, sessions: [b] })).toEqual({ ok: false, reason: "bad_envelope" });
    expect(openMsg(sealRaw(JSON.stringify({ ...chat(), hop_budget: 99 })), { roomIdBytes, sessions: [b] })).toEqual({
      ok: false,
      reason: "bad_envelope",
      skipSeq: chat().seq,
    });
    expect(openMsg(sealRaw(JSON.stringify({ ...chat(), kind: "heads_up" })), { roomIdBytes, sessions: [b] })).toEqual({
      ok: false,
      reason: "unknown_kind",
      skipSeq: chat().seq,
    });
    expect(openMsg(sealRaw(JSON.stringify(chat({ body: "x".repeat(MAX_ENVELOPE_BYTES) }))), { roomIdBytes, sessions: [b] })).toEqual({
      ok: false,
      reason: "too_large",
      skipSeq: chat().seq,
    });
  });

  it("names the seq to skip only for a usable non-ack seq (02 §6.1, ADR-025)", () => {
    const { roomIdBytes, a, b } = pairSessions();
    const sealRaw = (value: unknown) => {
      const nonce = new Uint8Array(24);
      const ct = xchacha20poly1305(a.sendKey, nonce, msgAad(roomIdBytes, a.sid)).encrypt(utf8ToBytes(JSON.stringify(value)));
      return Uint8Array.from([2, ...a.sid, ...nonce, ...ct]);
    };
    const skip = (value: unknown) => {
      const r = openMsg(sealRaw(value), { roomIdBytes, sessions: [b] });
      return r.ok ? "ok" : r.skipSeq;
    };
    expect(skip({ ...chat({ seq: 7 }), kind: "claim", data: { paths: ["a"] } })).toBe(7);
    expect(skip({ ...chat({ seq: 7 }), v: 2 })).toBe(7);
    expect(skip({ ...chat({ seq: 7 }), data: null })).toBe(7);
    expect(skip({ ...chat(), kind: "ack", seq: 0, acks: "x" })).toBeUndefined();
    expect(skip({ ...chat(), kind: "mystery", seq: 0 })).toBeUndefined();
    expect(skip({ ...chat(), kind: "mystery", seq: 1.5 })).toBeUndefined();
    expect(skip({ ...chat(), kind: "mystery", seq: "3" })).toBeUndefined();
    expect(skip([1, 2, 3])).toBeUndefined();
  });
});

describe("receiver rules (02 §6.1)", () => {
  it("accepts exactly the next seq", () => {
    expect(receiveDecision(chat({ seq: 5 }), 4)).toBe("accept");
    expect(receiveDecision(chat({ seq: 1 }), 0)).toBe("accept");
  });

  it("treats seq <= peer_max_seq as a duplicate to re-ack but not deliver", () => {
    expect(receiveDecision(chat({ seq: 4 }), 4)).toBe("duplicate");
    expect(receiveDecision(chat({ seq: 1 }), 4)).toBe("duplicate");
  });

  it("drops a gap without acking, so the sender's resend fills it", () => {
    expect(receiveDecision(chat({ seq: 6 }), 4)).toBe("out_of_order");
  });

  it("handles acks outside the ordering, whatever peer_max_seq is", () => {
    expect(receiveDecision(makeAck(3, ID2, TS), 0)).toBe("ack");
    expect(receiveDecision(makeAck(3, ID2, TS), 100)).toBe("ack");
  });
});
