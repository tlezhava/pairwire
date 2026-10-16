// MSG framing and the envelope schema (02 §3, §6), plus the receiver ordering rules (02 §6.1).
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { bytesToUtf8, equalBytes } from "@noble/ciphers/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes, randomBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { z } from "zod";
import type { Session } from "./handshake.js";
import { sanitizeText } from "./sanitize.js";

export const MSG_TYPE = 0x02;
const SID_BYTES = 8;
const NONCE_BYTES = 24;
const TAG_BYTES = 16;
const HEADER_BYTES = 1 + SID_BYTES + NONCE_BYTES;

/** `body` limit in UTF-8 bytes. */
export const MAX_BODY_BYTES = 24 * 1024;
/** Serialized envelope limit in UTF-8 bytes; the binding limit (02 §6). */
export const MAX_ENVELOPE_BYTES = 28 * 1024;

/** The kinds of 0.1.0 (02 §6). */
export const BASIC_KINDS = ["chat", "question", "answer", "ack", "bye"] as const;
/** Structured kinds (M5, 02 §6.3); sent as such only to peers that advertise `collab1`. */
export const COLLAB_KINDS = ["heads_up", "claim", "release", "contract_propose", "contract_response"] as const;
export const KINDS = [...BASIC_KINDS, ...COLLAB_KINDS] as const;
export type BasicKind = (typeof BASIC_KINDS)[number];
export type CollabKind = (typeof COLLAB_KINDS)[number];
export type Kind = BasicKind | CollabKind;
/** The HELLO capability that says a client understands COLLAB_KINDS (02 §6.3.2). */
export const COLLAB_CAP = "collab1";

export const isCollabKind = (kind: string): kind is CollabKind => (COLLAB_KINDS as readonly string[]).includes(kind);

// --- value types of structured kinds (02 §6.3.3) ----------------------------------------

export const MAX_PATHS = 20;
export const MAX_PATH_CHARS = 200;
export const CLAIM_TTL_MIN = { min: 5, max: 1440, default: 120 } as const;
export const MAX_CONTRACT_VERSION = 1_000_000;
/** Inline contract content limit in UTF-8 bytes. */
export const MAX_INLINE_CONTENT_BYTES = 16 * 1024;

// eslint-disable-next-line no-control-regex -- matching control characters is the point
const PATH_FORBIDDEN = /[\\,\u0000-\u001F\u007F-\u009F\p{Cf}\u{E0000}-\u{E007F}]/u;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * Why `path` is not a RelPath, or null if it is one: project-relative, `/`-separated, glob
 * tokens `*`, `**` (a whole segment) and `?` only after a literal first segment.
 */
export function relPathProblem(path: string): string | null {
  const chars = [...path].length;
  if (chars === 0 || chars > MAX_PATH_CHARS) return `must be 1 to ${MAX_PATH_CHARS} characters`;
  if (path.trim() !== path) return "must not start or end with whitespace";
  if (path.startsWith("/") || path.startsWith("~") || /^[A-Za-z]:/.test(path)) return "must be relative to the project";
  if (PATH_FORBIDDEN.test(path) || LONE_SURROGATE.test(path)) return "must not contain backslashes, commas, control or invisible characters";
  const segments = path.split("/");
  if (segments.some((s) => s === "")) return "must not have an empty segment or a trailing /";
  if (segments.some((s) => s === "." || s === "..")) return "must not have . or .. segments";
  if (/[*?]/.test(segments[0]!)) return "must start with a literal name (no * or ? in the first segment)";
  if (segments.some((s) => s.includes("**") && s !== "**")) return "may use ** only as a whole segment";
  return null;
}

/** Why `path` is not a ContractPath (a RelPath without globs or dot-segments), or null. */
export function contractPathProblem(path: string): string | null {
  const rel = relPathProblem(path);
  if (rel) return rel;
  if (/[*?]/.test(path)) return "must name one file (no * or ?)";
  if (path.split("/").some((s) => s.startsWith("."))) return "must not be or be under a dot-file or dot-directory";
  return null;
}

const checked = (problem: (p: string) => string | null) =>
  z.string().superRefine((p, ctx) => {
    const why = problem(p);
    if (why) ctx.addIssue({ code: "custom", message: `path ${why}` });
  });
export const relPathSchema = checked(relPathProblem);
export const contractPathSchema = checked(contractPathProblem);
export const pathsSchema = z
  .array(relPathSchema)
  .max(MAX_PATHS)
  .refine((paths) => new Set(paths).size === paths.length, "paths must be distinct");
export const contractNameSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/);
export const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
export const revSchema = z
  .string()
  .regex(/^[0-9a-f]{7,40}$/)
  .nullable();
const versionSchema = z.number().int().min(1).max(MAX_CONTRACT_VERSION);

/** `data` per structured kind: strict, so nothing else can ride along (INV-8). */
export const collabDataSchemas = {
  heads_up: z.strictObject({ paths: pathsSchema }),
  claim: z.strictObject({
    paths: pathsSchema.refine((p) => p.length > 0, "a claim needs a path"),
    ttl_min: z.number().int().min(CLAIM_TTL_MIN.min).max(CLAIM_TTL_MIN.max),
  }),
  release: z.strictObject({}),
  contract_propose: z.strictObject({
    name: contractNameSchema,
    version: versionSchema,
    path: contractPathSchema,
    sha256: sha256Schema,
    rev: revSchema,
    content: z.string().nullable(),
  }),
  contract_response: z.strictObject({
    decision: z.enum(["accept", "reject"]),
    name: contractNameSchema,
    version: versionSchema,
    sha256: sha256Schema,
  }),
} as const;
export type CollabData = { [K in CollabKind]: z.output<(typeof collabDataSchemas)[K]> };

// --- the envelope (02 §6, §6.3.3) -------------------------------------------------------

const ulid = z.string().regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
const counter = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

const fields = {
  v: z.literal(1),
  id: ulid,
  seq: counter,
  ts: z.iso.datetime(),
  author: z.enum(["agent", "human"]),
  reply_to: ulid.nullable(),
  body: z.string().nullable(),
  acks: counter.nullable(),
};
const collab = <K extends CollabKind>(kind: K) => z.strictObject({ ...fields, kind: z.literal(kind), data: collabDataSchemas[kind] });

/**
 * Strict: unknown fields are rejected, so nothing in an envelope can carry config,
 * membership or permission changes (INV-8). Every field is present; unused ones are null.
 * `data` is required on structured kinds and absent on the others (02 §6.3.3).
 */
export const envelopeSchema = z
  .discriminatedUnion("kind", [
    z.strictObject({ ...fields, kind: z.enum(BASIC_KINDS) }),
    collab("heads_up"),
    collab("claim"),
    collab("release"),
    collab("contract_propose"),
    collab("contract_response"),
  ])
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
    if (env.kind === "answer" && env.reply_to === null) issue("answer requires reply_to");
    if (!isCollabKind(env.kind)) {
      if (env.kind !== "bye" && (env.body === null || env.body === "")) issue(`${env.kind} requires a body`);
      return;
    }
    if (env.author !== "agent") issue("structured kinds are sent by the agent");
    if (env.body === "") issue(`${env.kind} has an empty body`);
    const bodyOptional = env.kind === "release" || (env.kind === "contract_response" && env.data.decision === "accept");
    if (!bodyOptional && env.body === null) issue(`${env.kind} requires a body`);
    if ((env.kind === "heads_up" || env.kind === "claim") && env.reply_to !== null) issue(`${env.kind} has no reply_to`);
    if ((env.kind === "release" || env.kind === "contract_response") && env.reply_to === null) issue(`${env.kind} requires reply_to`);
    if (env.kind === "contract_propose" && env.data.content !== null) {
      const why = inlineContentProblem(env.data.content, env.data.sha256);
      if (why) issue(why);
    }
  });
export type Envelope = z.output<typeof envelopeSchema>;
export type BasicEnvelope = Extract<Envelope, { kind: BasicKind }>;
export type CollabEnvelope = Extract<Envelope, { kind: CollabKind }>;

/** Whether `content` can go inline with hash `sha` (02 §6.3.3): size, hash, sanitizer-invariance. */
export function inlineContentProblem(content: string, sha: string): string | null {
  const bytes = utf8ToBytes(content);
  if (bytes.length > MAX_INLINE_CONTENT_BYTES) return `inline content is over ${MAX_INLINE_CONTENT_BYTES} bytes`;
  if (bytesToHex(sha256(bytes)) !== sha) return "inline content doesn't match sha256";
  if (sanitizeText(content) !== content) return "inline content has characters the sanitizer would change";
  return null;
}

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

export function makeAck(peerMaxSeq: number, id: string, ts: string): BasicEnvelope {
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
