// MSG framing and the envelope schema (02 §3, §6), plus the receiver ordering rules (02 §6.1).
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { bytesToUtf8, equalBytes } from "@noble/ciphers/utils.js";
import { concatBytes, randomBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { z } from "zod";
import type { Session } from "./handshake.js";

export const MSG_TYPE = 0x02;
const SID_BYTES = 8;
const NONCE_BYTES = 24;
const TAG_BYTES = 16;
const HEADER_BYTES = 1 + SID_BYTES + NONCE_BYTES;

/** `body` limit in UTF-8 bytes. */
export const MAX_BODY_BYTES = 24 * 1024;
/** Serialized envelope limit in UTF-8 bytes; the binding limit (02 §6). */
export const MAX_ENVELOPE_BYTES = 28 * 1024;

export const KINDS = ["chat", "question", "answer", "ack", "bye"] as const;
export type Kind = (typeof KINDS)[number];

const ulid = z.string().regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
const counter = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

/**
 * Strict: unknown fields are rejected, so nothing in an envelope can carry config,
 * membership or permission changes (INV-8). Every field is present; unused ones are null.
 */
export const envelopeSchema = z
  .strictObject({
    v: z.literal(1),
    id: ulid,
    seq: counter,
    ts: z.iso.datetime(),
    author: z.enum(["agent", "human"]),
    kind: z.enum(KINDS),
    reply_to: ulid.nullable(),
    body: z.string().nullable(),
    acks: counter.nullable(),
  })
  .superRefine((env, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: "custom", message });
    if (env.kind === "ack") {
      if (env.seq !== 0) issue("ack must have seq 0");
      if (env.acks === null) issue("ack requires acks");
      if (env.body !== null) issue("ack has no body");
      if (env.reply_to !== null) issue("ack has no reply_to");
      return;
    }
    if (env.seq < 1) issue("seq starts at 1");
    if (env.acks !== null) issue("acks is only for ack");
    if (env.kind !== "bye" && (env.body === null || env.body === "")) issue(`${env.kind} requires a body`);
    if (env.kind === "answer" && env.reply_to === null) issue("answer requires reply_to");
  });
export type Envelope = z.output<typeof envelopeSchema>;

export type EnvelopeRejection = "bad_envelope" | "unknown_kind" | "too_large";

export class EnvelopeTooLargeError extends Error {
  override readonly name = "EnvelopeTooLargeError";
  readonly code = "too_large";
  constructor(
    readonly bodyBytes: number,
    readonly envelopeBytes: number,
  ) {
    super(
      `Message too large: the body is ${bodyBytes} bytes (limit ${MAX_BODY_BYTES}) and the encoded message is ` +
        `${envelopeBytes} bytes (limit ${MAX_ENVELOPE_BYTES}). Shorten it or split it into several messages.`,
    );
  }
}

export function parseEnvelope(value: unknown): { ok: true; envelope: Envelope } | { ok: false; reason: EnvelopeRejection } {
  if (typeof value === "object" && value !== null && "kind" in value) {
    const kind = (value as { kind: unknown }).kind;
    if (typeof kind === "string" && !(KINDS as readonly string[]).includes(kind)) return { ok: false, reason: "unknown_kind" };
  }
  const parsed = envelopeSchema.safeParse(value);
  if (!parsed.success) return { ok: false, reason: "bad_envelope" };
  if (parsed.data.body !== null && utf8ToBytes(parsed.data.body).length > MAX_BODY_BYTES) {
    return { ok: false, reason: "too_large" };
  }
  return { ok: true, envelope: parsed.data };
}

/** Validates and encodes an envelope; throws EnvelopeTooLargeError if either size limit is broken. */
export function serializeEnvelope(envelope: Envelope): Uint8Array {
  const env = envelopeSchema.parse(envelope);
  const bytes = utf8ToBytes(JSON.stringify(env));
  const bodyBytes = env.body === null ? 0 : utf8ToBytes(env.body).length;
  if (bodyBytes > MAX_BODY_BYTES || bytes.length > MAX_ENVELOPE_BYTES) {
    throw new EnvelopeTooLargeError(bodyBytes, bytes.length);
  }
  return bytes;
}

export function makeAck(peerMaxSeq: number, id: string, ts: string): Envelope {
  return { v: 1, id, seq: 0, ts, author: "agent", kind: "ack", reply_to: null, body: null, acks: peerMaxSeq };
}

export function msgAad(roomIdBytes: Uint8Array, sid: Uint8Array): Uint8Array {
  return concatBytes(utf8ToBytes("pairwire/v1/msg"), roomIdBytes, sid);
}

export function sealMsg(args: { roomIdBytes: Uint8Array; session: Session; envelope: Envelope; nonce?: Uint8Array }): Uint8Array {
  const { roomIdBytes, session } = args;
  const nonce = args.nonce ?? randomBytes(NONCE_BYTES);
  const ct = xchacha20poly1305(session.sendKey, nonce, msgAad(roomIdBytes, session.sid)).encrypt(serializeEnvelope(args.envelope));
  return concatBytes(Uint8Array.of(MSG_TYPE), session.sid, nonce, ct);
}

export type OpenMsgResult =
  | { ok: true; envelope: Envelope; sid: Uint8Array }
  | {
      ok: false;
      reason: "malformed" | "unknown_sid" | "decrypt_failed" | EnvelopeRejection;
      /**
       * Set when the frame decrypted but the envelope can't be used and still names a usable
       * non-ack seq: the receiver skips it but counts it for ordering (02 §6.1, ADR-025).
       */
      skipSeq?: number;
    };

/** The seq of an unusable envelope, if it names one the receiver can count (02 §6.1). */
function skipSeqOf(json: unknown): number | undefined {
  if (typeof json !== "object" || json === null || Array.isArray(json)) return undefined;
  const { kind, seq } = json as { kind?: unknown; seq?: unknown };
  return kind !== "ack" && typeof seq === "number" && Number.isSafeInteger(seq) && seq >= 1 ? seq : undefined;
}

/** Decrypts with the receive key of the stored session (current or previous) matching the frame's sid (02 §4.4). */
export function openMsg(frame: Uint8Array, ctx: { roomIdBytes: Uint8Array; sessions: readonly Session[] }): OpenMsgResult {
  if (frame.length < HEADER_BYTES + TAG_BYTES || frame[0] !== MSG_TYPE) return { ok: false, reason: "malformed" };
  const sid = frame.slice(1, 1 + SID_BYTES);
  const session = ctx.sessions.find((s) => equalBytes(s.sid, sid));
  if (!session) return { ok: false, reason: "unknown_sid" };
  let plain: Uint8Array;
  try {
    plain = xchacha20poly1305(session.recvKey, frame.subarray(1 + SID_BYTES, HEADER_BYTES), msgAad(ctx.roomIdBytes, sid)).decrypt(
      frame.subarray(HEADER_BYTES),
    );
  } catch {
    return { ok: false, reason: "decrypt_failed" };
  }
  let json: unknown;
  try {
    json = JSON.parse(bytesToUtf8(plain));
  } catch {
    return { ok: false, reason: "bad_envelope" };
  }
  const skipSeq = skipSeqOf(json);
  const skip = skipSeq === undefined ? {} : { skipSeq };
  if (plain.length > MAX_ENVELOPE_BYTES) return { ok: false, reason: "too_large", ...skip };
  const parsed = parseEnvelope(json);
  return parsed.ok ? { ok: true, envelope: parsed.envelope, sid } : { ...parsed, ...skip };
}

/**
 * What the receiver does with a valid envelope, given `peer_max_seq` (02 §6.1):
 * accept (deliver, advance, schedule an ack), duplicate (re-ack only), out_of_order (drop
 * without acking), or ack (process outside the ordering).
 */
export function receiveDecision(envelope: Envelope, peerMaxSeq: number): "accept" | "duplicate" | "out_of_order" | "ack" {
  if (envelope.kind === "ack") return "ack";
  if (envelope.seq === peerMaxSeq + 1) return "accept";
  return envelope.seq <= peerMaxSeq ? "duplicate" : "out_of_order";
}
