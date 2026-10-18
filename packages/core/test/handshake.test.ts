import { x25519 } from "@noble/curves/ed25519.js";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { describe, expect, it } from "vitest";
import { deriveRoomKeys } from "../src/keys.js";
import { generateSecret } from "../src/share.js";
import {
  Handshake,
  HandshakeAbort,
  deriveSession,
  helloAad,
  openHello,
  sealHello,
  type HelloPayload,
} from "../src/handshake.js";

const VECTOR_SECRET = hexToBytes("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f");
const ALICE_PRIV = hexToBytes("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a");
const ALICE_PUB = hexToBytes("8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a");
const BOB_PRIV = hexToBytes("5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb");
const BOB_PUB = hexToBytes("de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f");
const KEY_LO = "91115beced30ca2e0ff425a86c21287c171b9de0aecd47c650d4061d0e970cc3";
const KEY_HI = "83c6077d4ec87bd263e510887a070b95a8611a563ac62b0ba0e40ffe56ca5ad3";

const payload = (name: string, instance = "a".repeat(26)): HelloPayload => ({
  v: 1,
  name,
  harness: "claude-code",
  client: "pairwire/0.1.0",
  instance,
  caps: ["ack", "say"],
});

describe("session keys (02 §4.3)", () => {
  const { psk } = deriveRoomKeys(VECTOR_SECRET);

  it("reproduces the 02 §7 dh vector with the RFC 7748 key pairs", () => {
    expect(bytesToHex(x25519.getSharedSecret(ALICE_PRIV, BOB_PUB))).toBe(
      "4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742",
    );
  });

  it("reproduces key_lo, key_hi and sid from both sides", () => {
    const alice = deriveSession(ALICE_PRIV, ALICE_PUB, BOB_PUB, psk);
    const bob = deriveSession(BOB_PRIV, BOB_PUB, ALICE_PUB, psk);
    // Alice's e_pub sorts low, so she sends with key_lo and Bob sends with key_hi.
    expect(bytesToHex(alice.sendKey)).toBe(KEY_LO);
    expect(bytesToHex(alice.recvKey)).toBe(KEY_HI);
    expect(bytesToHex(bob.sendKey)).toBe(KEY_HI);
    expect(bytesToHex(bob.recvKey)).toBe(KEY_LO);
    expect(bytesToHex(alice.sid)).toBe("99625b51d4fd490e");
    expect(bob.sid).toEqual(alice.sid);
  });

  it("aborts when the peer's e_pub equals ours (reflection)", () => {
    expect(() => deriveSession(ALICE_PRIV, ALICE_PUB, ALICE_PUB, psk)).toThrow(HandshakeAbort);
  });

  it("aborts on a low-order peer key that would give an all-zero DH", () => {
    const err = (() => {
      try {
        deriveSession(ALICE_PRIV, ALICE_PUB, new Uint8Array(32), psk);
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(HandshakeAbort);
    expect((err as HandshakeAbort).reason).toBe("zero_dh");
  });
});

describe("HELLO frames (02 §3, §4.2)", () => {
  const keys = deriveRoomKeys(generateSecret());
  const ePub = x25519.getPublicKey(x25519.utils.randomSecretKey());

  it("has the layout 0x01 || epoch u32be || e_pub || nonce || ciphertext", () => {
    const nonce = new Uint8Array(24).fill(9);
    const frame = sealHello({ keys, epoch: 0x01020304, ePub, payload: payload("Tazo"), nonce });
    expect(frame[0]).toBe(0x01);
    expect([...frame.subarray(1, 5)]).toEqual([1, 2, 3, 4]);
    expect(frame.subarray(5, 37)).toEqual(ePub);
    expect(frame.subarray(37, 61)).toEqual(nonce);
    // ciphertext is the AEAD seal of the JSON payload under hello_key with the 02 §4.2 AAD
    const aad = helloAad(keys.roomIdBytes, 0x01020304, ePub);
    expect(bytesToHex(aad.subarray(0, 17))).toBe(bytesToHex(utf8ToBytes("pairwire/v1/hello")));
    const plain = xchacha20poly1305(keys.helloKey, nonce, aad).decrypt(frame.subarray(61));
    expect(JSON.parse(new TextDecoder().decode(plain))).toEqual(payload("Tazo"));
  });

  it("opens a valid HELLO", () => {
    const frame = sealHello({ keys, epoch: 7, ePub, payload: payload("Nika") });
    const opened = openHello(frame, keys);
    expect(opened).toEqual({ ok: true, epoch: 7, pPub: ePub, payload: payload("Nika") });
  });

  it("fails to open a HELLO sealed for a different secret", () => {
    const other = deriveRoomKeys(generateSecret());
    const frame = sealHello({ keys: other, epoch: 7, ePub, payload: payload("Mallory") });
    expect(openHello(frame, keys)).toEqual({ ok: false, reason: "decrypt_failed" });
  });

  it("fails when any bit of the epoch, e_pub, nonce or ciphertext is flipped", () => {
    const frame = sealHello({ keys, epoch: 7, ePub, payload: payload("Nika") });
    for (let i = 1; i < frame.length; i++) {
      const tampered = frame.slice();
      tampered[i]! ^= 0x01;
      expect(openHello(tampered, keys), `byte ${i}`).toEqual({ ok: false, reason: "decrypt_failed" });
    }
  });

  it("rejects frames that are not HELLOs or are too short", () => {
    const frame = sealHello({ keys, epoch: 7, ePub, payload: payload("Nika") });
    const wrongType = frame.slice();
    wrongType[0] = 0x02;
    expect(openHello(wrongType, keys)).toEqual({ ok: false, reason: "malformed" });
    expect(openHello(frame.subarray(0, 60), keys)).toEqual({ ok: false, reason: "malformed" });
  });

  it("rejects payloads with the wrong version, missing fields or invalid JSON", () => {
    const seal = (plain: string) => {
      const nonce = new Uint8Array(24);
      const aad = helloAad(keys.roomIdBytes, 7, ePub);
      const ct = xchacha20poly1305(keys.helloKey, nonce, aad).encrypt(utf8ToBytes(plain));
      return Uint8Array.from([1, 0, 0, 0, 7, ...ePub, ...nonce, ...ct]);
    };
    const { v: _v, ...noVersion } = payload("x");
    for (const plain of [
      JSON.stringify({ ...payload("x"), v: 2 }),
      JSON.stringify(noVersion),
      JSON.stringify({ ...payload("x"), instance: "short" }),
      JSON.stringify({ ...payload("x"), caps: "ack" }),
      "{not json",
    ]) {
      expect(openHello(seal(plain), keys), plain).toEqual({ ok: false, reason: "bad_payload" });
    }
  });

  it("maps an unknown harness to 'other' and keeps unknown caps for the caller to ignore", () => {
    const frame = sealHello({
      keys,
      epoch: 7,
      ePub,
      payload: { ...payload("x"), harness: "future-cli" as HelloPayload["harness"], caps: ["ack", "teleport"] },
    });
    const opened = openHello(frame, keys);
    expect(opened.ok && opened.payload.harness).toBe("other");
    expect(opened.ok && opened.payload.caps).toEqual(["ack", "teleport"]);
  });

  it("refuses to seal an epoch outside u32", () => {
    expect(() => sealHello({ keys, epoch: -1, ePub, payload: payload("x") })).toThrow();
    expect(() => sealHello({ keys, epoch: 2 ** 32, ePub, payload: payload("x") })).toThrow();
  });
});

describe("Handshake state machine (02 §4.1)", () => {
  const keys = deriveRoomKeys(generateSecret());
  const pair = () => ({
    a: new Handshake({ keys, payload: payload("Tazo", "a".repeat(26)) }),
    b: new Handshake({ keys, payload: payload("Nika", "b".repeat(26)) }),
  });

  it("gives both sides the same sid and mirrored keys", () => {
    const { a, b } = pair();
    const helloA = a.startEpoch(7)!;
    const helloB = b.startEpoch(7)!;
    const atA = a.receive(helloB);
    const atB = b.receive(helloA);
    if (atA.type !== "session" || atB.type !== "session") throw new Error("expected sessions");
    expect(atA.session.sid).toEqual(atB.session.sid);
    expect(atA.session.sendKey).toEqual(atB.session.recvKey);
    expect(atA.session.recvKey).toEqual(atB.session.sendKey);
    expect(atA.peer.name).toBe("Nika");
    expect(atB.peer.name).toBe("Tazo");
    expect(atA.epoch).toBe(7);
  });

  it("sends at most one HELLO per epoch, with a fresh ephemeral key each epoch", () => {
    const { a } = pair();
    const first = a.startEpoch(7)!;
    expect(a.startEpoch(7)).toBeNull();
    expect(a.startEpoch(6)).toBeNull();
    const next = a.startEpoch(8)!;
    expect(next.subarray(5, 37)).not.toEqual(first.subarray(5, 37));
  });

  it("accepts only one HELLO per epoch and drops later ones as duplicates", () => {
    const { a, b } = pair();
    a.startEpoch(7);
    const helloB = b.startEpoch(7)!;
    expect(a.receive(helloB).type).toBe("session");
    expect(a.receive(helloB)).toEqual({ type: "dropped", reason: "duplicate", wrongKey: false });
  });

  it("drops HELLOs for an older epoch and for an epoch it has not seen", () => {
    const { a, b } = pair();
    const helloB7 = b.startEpoch(7)!;
    const helloB9 = b.startEpoch(9)!;
    a.startEpoch(8);
    expect(a.receive(helloB7)).toEqual({ type: "dropped", reason: "stale_epoch", wrongKey: false });
    expect(a.receive(helloB9)).toEqual({ type: "dropped", reason: "unseen_epoch", wrongKey: false });
  });

  it("drops a HELLO for an epoch it noted without sending (peer was absent)", () => {
    const { a, b } = pair();
    a.noteEpoch(7);
    expect(a.receive(b.startEpoch(7)!)).toEqual({ type: "dropped", reason: "unseen_epoch", wrongKey: false });
  });

  it("drops its own HELLO reflected back by the relay", () => {
    const { a } = pair();
    const own = a.startEpoch(7)!;
    expect(a.receive(own)).toEqual({ type: "dropped", reason: "reflected", wrongKey: false });
  });

  it("drops a HELLO carrying a low-order key", () => {
    const { a } = pair();
    a.startEpoch(7);
    const evil = sealHello({ keys, epoch: 7, ePub: new Uint8Array(32), payload: payload("Mallory") });
    expect(a.receive(evil)).toEqual({ type: "dropped", reason: "zero_dh", wrongKey: false });
  });

  it("ADR-031: a HELLO replayed from an earlier connection's epoch is dropped below the floor", () => {
    const { a, b } = pair();
    // Connection 1: both sides handshake at epoch 5; the relay records b's HELLO.
    const helloA5 = a.startEpoch(5)!;
    const recorded = b.startEpoch(5)!;
    expect(a.receive(recorded).type).toBe("session");
    expect(b.receive(helloA5).type).toBe("session");

    // Without a floor, a new connection accepts the replay (the review's finding).
    const unseeded = new Handshake({ keys, payload: payload("Tazo", "a".repeat(26)) });
    expect(unseeded.startEpoch(5)).not.toBeNull();
    expect(unseeded.receive(recorded).type).toBe("session");

    // Connection 2, seeded with the highest epoch seen: no HELLO, no session at or below it.
    const next = new Handshake({ keys, payload: payload("Tazo", "a".repeat(26)), floor: 5 });
    expect(next.startEpoch(5)).toBeNull();
    expect(next.startEpoch(4)).toBeNull();
    expect(next.receive(recorded)).toEqual({ type: "dropped", reason: "stale_epoch", wrongKey: false });
    next.noteEpoch(3);
    expect(next.receive(recorded)).toEqual({ type: "dropped", reason: "stale_epoch", wrongKey: false });
  });

  it("ADR-031: a floored handshake still pairs at a newer epoch", () => {
    const a = new Handshake({ keys, payload: payload("Tazo", "a".repeat(26)), floor: 5 });
    const b = new Handshake({ keys, payload: payload("Nika", "b".repeat(26)), floor: 6 });
    expect(b.startEpoch(6)).toBeNull();
    const helloA = a.startEpoch(7)!;
    const helloB = b.startEpoch(7)!;
    expect(a.receive(helloB).type).toBe("session");
    expect(b.receive(helloA).type).toBe("session");
  });

  it("signals wrongKey on the fifth HELLO that fails to decrypt on this connection", () => {
    const { a } = pair();
    a.startEpoch(7);
    const stranger = new Handshake({ keys: deriveRoomKeys(generateSecret()), payload: payload("Mallory") });
    const bad = stranger.startEpoch(7)!;
    const results = Array.from({ length: 5 }, () => a.receive(bad));
    expect(results.map((r) => r.type === "dropped" && r.wrongKey)).toEqual([false, false, false, false, true]);
    expect(a.decryptFailures).toBe(5);
  });
});
