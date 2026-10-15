// Symmetric PSK-authenticated ephemeral X25519 handshake (02 §4).
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { bytesToUtf8, equalBytes } from "@noble/ciphers/utils.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { concatBytes, randomBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { z } from "zod";
import type { RoomKeys } from "./keys.js";

export const HELLO_TYPE = 0x01;
const NONCE_BYTES = 24;
const KEY_BYTES = 32;
const TAG_BYTES = 16;
const HEADER_BYTES = 1 + 4 + KEY_BYTES + NONCE_BYTES;
/** Decrypt failures on one connection after which the client disconnects (02 §4.2). */
export const MAX_HELLO_FAILURES = 5;

export const HARNESSES = ["claude-code", "codex", "cursor", "gemini-cli", "opencode", "other"] as const;
export type Harness = (typeof HARNESSES)[number];

/**
 * HELLO payload (02 §4.2). `harness` is informational (REQ-X-1): an unknown value from a
 * newer client is read as "other" instead of failing the handshake. Unknown `caps` are
 * kept for the caller to ignore. `name` is sanitized and truncated when displayed (M1-7).
 */
export const helloPayloadSchema = z.object({
  v: z.literal(1),
  name: z.string(),
  harness: z.string().transform((h): Harness => ((HARNESSES as readonly string[]).includes(h) ? (h as Harness) : "other")),
  client: z.string(),
  instance: z.string().regex(/^[a-z2-7]{26}$/),
  caps: z.array(z.string()),
});
export type HelloPayload = z.output<typeof helloPayloadSchema>;

export interface Session {
  /** SHA-256(lo || hi)[0:8], carried in every MSG frame. */
  sid: Uint8Array;
  sendKey: Uint8Array;
  /** The peer's send key. */
  recvKey: Uint8Array;
}

export type HandshakeAbortReason = "reflected" | "zero_dh";

export class HandshakeAbort extends Error {
  override readonly name = "HandshakeAbort";
  constructor(readonly reason: HandshakeAbortReason) {
    super(`handshake aborted: ${reason}`);
  }
}

export function helloAad(roomIdBytes: Uint8Array, epoch: number, ePub: Uint8Array): Uint8Array {
  return concatBytes(utf8ToBytes("pairwire/v1/hello"), roomIdBytes, u32be(epoch), ePub);
}

export function sealHello(args: {
  keys: Pick<RoomKeys, "roomIdBytes" | "helloKey">;
  epoch: number;
  ePub: Uint8Array;
  payload: HelloPayload;
  nonce?: Uint8Array;
}): Uint8Array {
  const { keys, epoch, ePub, payload } = args;
  if (ePub.length !== KEY_BYTES) throw new Error("e_pub must be 32 bytes");
  const nonce = args.nonce ?? randomBytes(NONCE_BYTES);
  const plain = utf8ToBytes(JSON.stringify(payload));
  const ct = xchacha20poly1305(keys.helloKey, nonce, helloAad(keys.roomIdBytes, epoch, ePub)).encrypt(plain);
  return concatBytes(Uint8Array.of(HELLO_TYPE), u32be(epoch), ePub, nonce, ct);
}

export type OpenHelloResult =
  | { ok: true; epoch: number; pPub: Uint8Array; payload: HelloPayload }
  | { ok: false; reason: "malformed" | "decrypt_failed" | "bad_payload" };

export function openHello(frame: Uint8Array, keys: Pick<RoomKeys, "roomIdBytes" | "helloKey">): OpenHelloResult {
  if (frame.length < HEADER_BYTES + TAG_BYTES || frame[0] !== HELLO_TYPE) return { ok: false, reason: "malformed" };
  const epoch = new DataView(frame.buffer, frame.byteOffset + 1, 4).getUint32(0);
  const pPub = frame.slice(5, 5 + KEY_BYTES);
  const nonce = frame.subarray(5 + KEY_BYTES, HEADER_BYTES);
  let plain: Uint8Array;
  try {
    plain = xchacha20poly1305(keys.helloKey, nonce, helloAad(keys.roomIdBytes, epoch, pPub)).decrypt(
      frame.subarray(HEADER_BYTES),
    );
  } catch {
    return { ok: false, reason: "decrypt_failed" };
  }
  let json: unknown;
  try {
    json = JSON.parse(bytesToUtf8(plain));
  } catch {
    return { ok: false, reason: "bad_payload" };
  }
  const parsed = helloPayloadSchema.safeParse(json);
  if (!parsed.success) return { ok: false, reason: "bad_payload" };
  return { ok: true, epoch, pPub, payload: parsed.data };
}

/** Session keys from our ephemeral key pair and the peer's ephemeral public key (02 §4.3). */
export function deriveSession(ePriv: Uint8Array, ePub: Uint8Array, pPub: Uint8Array, psk: Uint8Array): Session {
  if (equalBytes(pPub, ePub)) throw new HandshakeAbort("reflected");
  let dh: Uint8Array;
  try {
    dh = x25519.getSharedSecret(ePriv, pPub);
  } catch {
    // noble rejects low-order points, whose shared secret would be all zeros.
    throw new HandshakeAbort("zero_dh");
  }
  if (dh.every((b) => b === 0)) throw new HandshakeAbort("zero_dh");
  const weAreLo = compareBytes(ePub, pPub) < 0;
  const [lo, hi] = weAreLo ? [ePub, pPub] : [pPub, ePub];
  const okm = hkdf(sha256, dh, psk, concatBytes(utf8ToBytes("session"), lo, hi), 2 * KEY_BYTES);
  dh.fill(0);
  const keyLo = okm.slice(0, KEY_BYTES);
  const keyHi = okm.slice(KEY_BYTES);
  return {
    sid: sha256(concatBytes(lo, hi)).slice(0, 8),
    sendKey: weAreLo ? keyLo : keyHi,
    recvKey: weAreLo ? keyHi : keyLo,
  };
}

export type HelloEvent =
  | { type: "session"; epoch: number; session: Session; peer: HelloPayload }
  | {
      type: "dropped";
      reason:
        | "malformed"
        | "decrypt_failed"
        | "bad_payload"
        | "stale_epoch"
        | "unseen_epoch"
        | "duplicate"
        | HandshakeAbortReason;
      /** True when this failure reached MAX_HELLO_FAILURES: disconnect and warn the human. */
      wrongKey: boolean;
    };

/**
 * Handshake state for one connection (02 §4.1). The client creates one per socket.
 * Only the latest epoch seen is kept; at most one HELLO is sent and one accepted per epoch.
 */
export class Handshake {
  #latest = -1;
  #ephemeral: { epoch: number; priv: Uint8Array; pub: Uint8Array } | null = null;
  #acceptedEpoch = -1;
  #failures = 0;

  constructor(
    private readonly opts: {
      keys: Pick<RoomKeys, "roomIdBytes" | "helloKey" | "psk">;
      payload: HelloPayload;
    },
  ) {}

  get decryptFailures(): number {
    return this.#failures;
  }

  /** `joined` with `peer_present: false`: remember the epoch without sending a HELLO. */
  noteEpoch(epoch: number): void {
    if (epoch > this.#latest) {
      this.#latest = epoch;
      this.#wipeEphemeral();
    }
  }

  /**
   * `joined` with `peer_present: true`, or `peer_joined`: returns the HELLO frame to send,
   * or `null` if this epoch is not newer than one already handled.
   */
  startEpoch(epoch: number): Uint8Array | null {
    if (epoch < this.#latest || (epoch === this.#latest && this.#ephemeral?.epoch === epoch)) return null;
    if (epoch === this.#latest && this.#acceptedEpoch === epoch) return null;
    this.#latest = epoch;
    this.#wipeEphemeral();
    const priv = x25519.utils.randomSecretKey();
    const pub = x25519.getPublicKey(priv);
    this.#ephemeral = { epoch, priv, pub };
    return sealHello({ keys: this.opts.keys, epoch, ePub: pub, payload: this.opts.payload });
  }

  receive(frame: Uint8Array): HelloEvent {
    const opened = openHello(frame, this.opts.keys);
    if (!opened.ok) {
      if (opened.reason === "decrypt_failed") this.#failures++;
      const wrongKey = opened.reason === "decrypt_failed" && this.#failures === MAX_HELLO_FAILURES;
      return { type: "dropped", reason: opened.reason, wrongKey };
    }
    const drop = (reason: Extract<HelloEvent, { type: "dropped" }>["reason"]): HelloEvent => ({
      type: "dropped",
      reason,
      wrongKey: false,
    });
    if (opened.epoch < this.#latest) return drop("stale_epoch");
    if (opened.epoch > this.#latest) return drop("unseen_epoch");
    if (this.#acceptedEpoch === opened.epoch) return drop("duplicate");
    const eph = this.#ephemeral;
    if (!eph || eph.epoch !== opened.epoch) return drop("unseen_epoch");
    let session: Session;
    try {
      session = deriveSession(eph.priv, eph.pub, opened.pPub, this.opts.keys.psk);
    } catch (e) {
      if (e instanceof HandshakeAbort) return drop(e.reason);
      throw e;
    }
    this.#acceptedEpoch = opened.epoch;
    this.#wipeEphemeral();
    return { type: "session", epoch: opened.epoch, session, peer: opened.payload };
  }

  #wipeEphemeral(): void {
    this.#ephemeral?.priv.fill(0);
    this.#ephemeral = null;
  }
}

function u32be(n: number): Uint8Array {
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) throw new Error("epoch must be a u32");
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n);
  return out;
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return a[i]! - b[i]!;
  }
  return a.length - b.length;
}
