// A bare protocol peer for e2e tests (07-testing.md, Structured kinds): it joins a room with a
// share string, completes the HELLO handshake with the caps it is given, acks what it
// accepts, and sends whatever envelopes the test hands it, without any of `send`'s checks.
// With `old: true` it validates like 0.1.0 (its kinds only, no `data`) and, like 0.1.0, drops
// what fails without acking: anything recorded in `wedged` would have stalled a real one.
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { randomBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import {
  base32Encode,
  deriveRoomKeys,
  Handshake,
  HELLO_TYPE,
  makeAck,
  msgAad,
  MSG_TYPE,
  openMsg,
  parseShareString,
  relayUrl,
  sealMsg,
  type Session,
} from "@pairwire/core";
import { monotonicFactory } from "ulid";
import { WebSocket } from "ws";
import { z } from "zod";
import { until } from "./harness.js";

const ulidRe = z.string().regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
const counter = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

/** The envelope schema of 0.1.0 (02 §6 before M5): five kinds, strict, no `data`. */
export const envelopeSchemaV010 = z
  .strictObject({
    v: z.literal(1),
    id: ulidRe,
    seq: counter,
    ts: z.iso.datetime(),
    author: z.enum(["agent", "human"]),
    kind: z.enum(["chat", "question", "answer", "ack", "bye"]),
    reply_to: ulidRe.nullable(),
    body: z.string().nullable(),
    acks: counter.nullable(),
  })
  .superRefine((env, ctx) => {
    const bad = (message: string) => ctx.addIssue({ code: "custom", message });
    if (env.kind === "ack") {
      if (env.seq !== 0 || env.acks === null) bad("bad ack");
      return;
    }
    if (env.seq < 1 || env.acks !== null) bad("bad seq or acks");
    if (env.kind !== "bye" && !env.body) bad("needs a body");
    if (env.kind === "answer" && env.reply_to === null) bad("answer needs reply_to");
  });

export interface RawPeer {
  /** Non-ack envelopes accepted in order, as received. */
  received: Record<string, unknown>[];
  /** Envelopes a 0.1.0 client would have dropped without an ack (old mode only). */
  wedged: unknown[];
  /** The highest seq the other side has acked. */
  acked(): number;
  /** Seals `fields` (plus the common fields and the next seq) as given, valid or not; returns the id. */
  send(fields: Record<string, unknown>): string;
  close(): void;
}

export async function rawPeer(share: string, o: { name?: string; caps: string[]; old?: boolean }): Promise<RawPeer> {
  const parsed = parseShareString(share);
  const keys = deriveRoomKeys(parsed.secret);
  const ulid = monotonicFactory();
  const hs = new Handshake({
    keys,
    payload: { v: 1, name: o.name ?? "Raw", harness: "other", client: o.old ? "pairwire/0.1.0" : "pairwire/test", instance: base32Encode(randomBytes(16)), caps: o.caps },
  });
  const ws = new WebSocket(`${relayUrl(parsed.relay ?? null)}/v1/rooms/${keys.roomId}`);
  let session: Session | null = null;
  let peerMaxSeq = 0;
  let mySeq = 0;
  let acked = 0;
  const received: Record<string, unknown>[] = [];
  const wedged: unknown[] = [];

  const sendBinary = (d: Uint8Array) => ws.send(d, { binary: true });
  const hello = (epoch: number) => {
    const frame = hs.startEpoch(epoch);
    if (frame) sendBinary(frame);
  };
  const seal = (env: unknown) => {
    const nonce = randomBytes(24);
    const ct = xchacha20poly1305(session!.sendKey, nonce, msgAad(keys.roomIdBytes, session!.sid)).encrypt(utf8ToBytes(JSON.stringify(env)));
    return Uint8Array.from([MSG_TYPE, ...session!.sid, ...nonce, ...ct]);
  };

  ws.on("open", () => ws.send(JSON.stringify({ t: "join", v: 1, token: null })));
  ws.on("message", (data, isBinary) => {
    const buf = new Uint8Array(Buffer.from(data as Buffer));
    if (!isBinary) {
      const f = JSON.parse(Buffer.from(buf).toString("utf8")) as { t: string; epoch?: number; peer_present?: boolean };
      if (f.t === "joined" && f.peer_present) hello(Number(f.epoch));
      else if (f.t === "joined") hs.noteEpoch(Number(f.epoch));
      if (f.t === "peer_joined") hello(Number(f.epoch));
      return;
    }
    if (buf[0] === HELLO_TYPE) {
      const ev = hs.receive(buf);
      if (ev.type === "session") session = ev.session;
      return;
    }
    if (buf[0] !== MSG_TYPE || !session) return;
    const opened = openMsg(buf, { roomIdBytes: keys.roomIdBytes, sessions: [session] });
    if (!opened.ok) return;
    const env = opened.envelope;
    if (env.kind === "ack") {
      acked = Math.max(acked, env.acks ?? 0);
      return;
    }
    if (o.old && !envelopeSchemaV010.safeParse(env).success) {
      wedged.push(env); // 0.1.0: dropped without an ack, peer_max_seq stuck
      return;
    }
    if (env.seq === peerMaxSeq + 1) {
      peerMaxSeq = env.seq;
      received.push(env as unknown as Record<string, unknown>);
    }
    if (env.seq <= peerMaxSeq) {
      sendBinary(sealMsg({ roomIdBytes: keys.roomIdBytes, session, envelope: makeAck(peerMaxSeq, ulid(), new Date().toISOString()) }));
    }
  });
  await until(() => session !== null, 10_000, "raw peer handshake");

  return {
    received,
    wedged,
    acked: () => acked,
    send(fields) {
      const id = ulid();
      sendBinary(seal({ v: 1, id, seq: ++mySeq, ts: new Date().toISOString(), author: "agent", reply_to: null, acks: null, ...fields }));
      return id;
    },
    close: () => ws.close(),
  };
}
