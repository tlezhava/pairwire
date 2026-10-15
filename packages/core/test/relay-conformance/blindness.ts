// INV-1 relay blindness (05-security.md; 07-testing.md, relay): run a full session through a
// relay while recording every byte the relay receives, then search the recording for secrets.
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { base32Encode } from "../../src/base32.js";
import { makeAck, openMsg, sealMsg, type Envelope } from "../../src/envelope.js";
import { Handshake, type HelloPayload, type Session } from "../../src/handshake.js";
import { deriveRoomKeys } from "../../src/keys.js";
import { encodeShareString, generateSecret } from "../../src/share.js";
import type { Received, RelayUnderTest, TestSocket } from "./suite.js";

interface Recording {
  paths: string[];
  frames: Uint8Array[];
}

/** Wraps a relay so everything sent to it (URL path, text and binary frames) is recorded. */
function recorded(relay: RelayUnderTest, rec: Recording): RelayUnderTest {
  return {
    ...relay,
    async connect(roomId) {
      rec.paths.push(`/v1/rooms/${roomId}`);
      const socket = await relay.connect(roomId);
      return {
        ...socket,
        sendText: (data) => {
          rec.frames.push(utf8ToBytes(data));
          socket.sendText(data);
        },
        sendBinary: (data) => {
          rec.frames.push(data.slice());
          socket.sendBinary(data);
        },
      };
    },
  };
}

let ulidSeq = 0;
const ulid = () => `01JPW${String(ulidSeq++).padStart(21, "0")}`;

function contains(haystack: Uint8Array, needle: Uint8Array): boolean {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

/** The forms in which a secret could leak: raw bytes and common text encodings. */
export function forms(label: string, value: Uint8Array | string): [string, Uint8Array][] {
  if (typeof value === "string") return [[label, utf8ToBytes(value)]];
  return [
    [`${label} (raw)`, value],
    [`${label} (hex)`, utf8ToBytes(bytesToHex(value))],
    [`${label} (base32)`, utf8ToBytes(base32Encode(value))],
    [`${label} (base64)`, utf8ToBytes(base64(value).replace(/=+$/, ""))],
  ];
}

/** Labels of every forbidden value found anywhere in the recorded paths and frames. */
export function findLeaks(rec: { paths: string[]; frames: Uint8Array[] }, forbidden: [string, Uint8Array][]): string[] {
  const everything = [...rec.paths.map((p) => utf8ToBytes(p)), ...rec.frames];
  return forbidden.filter(([, needle]) => everything.some((chunk) => contains(chunk, needle))).map(([label]) => label);
}

export function relayBlindness(name: string, factory: () => Promise<RelayUnderTest>): void {
  describe(`relay blindness: ${name}`, () => {
    let relay: RelayUnderTest;
    beforeAll(async () => {
      relay = await factory();
    });
    afterAll(async () => {
      await relay?.close();
    });

    it("INV-1 the relay never receives the share secret, psk, session keys, display names or plaintext", async () => {
      const rec: Recording = { paths: [], frames: [] };
      const r = recorded(relay, rec);

      const secret = generateSecret();
      const share = encodeShareString(secret);
      const keys = deriveRoomKeys(secret);
      const nameA = "Tazo-Display-Name-7f3a";
      const nameB = "Nika-Display-Name-91c2";
      const question = "PLAINTEXT-QUESTION: does POST /orders accept an idempotency key?";
      const answer = "PLAINTEXT-ANSWER: yes, a client-generated UUID v4 in Idempotency-Key.";
      const payload = (n: string, i: string): HelloPayload => ({ v: 1, name: n, harness: "claude-code", client: "pairwire/test", instance: i.repeat(26), caps: ["ack"] });
      const hsA = new Handshake({ keys, payload: payload(nameA, "a") });
      const hsB = new Handshake({ keys, payload: payload(nameB, "b") });

      const next = async (s: TestSocket, kind: Received["kind"]) => {
        const ev = await s.next();
        if (ev.kind !== kind) throw new Error(`expected ${kind}, got ${JSON.stringify(ev)}`);
        return ev;
      };
      const json = async (s: TestSocket) => JSON.parse((await next(s, "text") as { data: string }).data) as Record<string, unknown>;
      const bin = async (s: TestSocket) => (await next(s, "binary") as { data: Uint8Array }).data;

      // A joins alone, then B joins; both send a HELLO for B's epoch.
      const a = await r.connect(keys.roomId);
      a.sendText(JSON.stringify({ t: "join", v: 1, token: null }));
      const joinedA = await json(a);
      hsA.noteEpoch(joinedA.epoch as number);
      const b = await r.connect(keys.roomId);
      b.sendText(JSON.stringify({ t: "join", v: 1, token: null }));
      const joinedB = await json(b);
      expect(joinedB.peer_present).toBe(true);
      b.sendBinary(hsB.startEpoch(joinedB.epoch as number)!);
      const peerJoined = await json(a);
      a.sendBinary(hsA.startEpoch(peerJoined.epoch as number)!);

      const atA = hsA.receive(await bin(a));
      const atB = hsB.receive(await bin(b));
      if (atA.type !== "session" || atB.type !== "session") throw new Error("handshake failed");
      expect(atA.peer.name).toBe(nameB);
      expect(atB.peer.name).toBe(nameA);
      const sA: Session = atA.session;
      const sB: Session = atB.session;

      // A asks, B acks and answers, A acks.
      const env = (seq: number, kind: Envelope["kind"], body: string, reply_to: string | null = null): Envelope => ({
        v: 1, id: ulid(), seq, ts: new Date().toISOString(), author: "agent", kind, reply_to, body, acks: null,
      });
      const q = env(1, "question", question);
      a.sendBinary(sealMsg({ roomIdBytes: keys.roomIdBytes, session: sA, envelope: q }));
      const gotQ = openMsg(await bin(b), { roomIdBytes: keys.roomIdBytes, sessions: [sB] });
      expect(gotQ.ok && gotQ.envelope.body).toBe(question);
      b.sendBinary(sealMsg({ roomIdBytes: keys.roomIdBytes, session: sB, envelope: makeAck(1, ulid(), new Date().toISOString()) }));
      b.sendBinary(sealMsg({ roomIdBytes: keys.roomIdBytes, session: sB, envelope: env(1, "answer", answer, q.id) }));
      const ack = openMsg(await bin(a), { roomIdBytes: keys.roomIdBytes, sessions: [sA] });
      expect(ack.ok && ack.envelope.acks).toBe(1);
      const gotA = openMsg(await bin(a), { roomIdBytes: keys.roomIdBytes, sessions: [sA] });
      expect(gotA.ok && gotA.envelope.body).toBe(answer);
      a.sendBinary(sealMsg({ roomIdBytes: keys.roomIdBytes, session: sA, envelope: makeAck(1, ulid(), new Date().toISOString()) }));
      await bin(b);
      a.sendText('{"t":"leave"}');
      await next(a, "close");

      // The recording really holds the session: the room id and the encrypted frames.
      expect(rec.paths).toEqual([`/v1/rooms/${keys.roomId}`, `/v1/rooms/${keys.roomId}`]);
      expect(rec.frames.filter((f) => f[0] === 0x01)).toHaveLength(2);
      expect(rec.frames.filter((f) => f[0] === 0x02)).toHaveLength(4);

      const forbidden = [
        ...forms("share string", share),
        ...forms("share string secret part", share.slice(4)),
        ...forms("secret", secret),
        ...forms("psk", keys.psk),
        ...forms("hello_key", keys.helloKey),
        ...forms("A send key", sA.sendKey),
        ...forms("A receive key", sA.recvKey),
        ...forms("display name A", nameA),
        ...forms("display name B", nameB),
        ...forms("question body", question),
        ...forms("answer body", answer),
        ...forms("plaintext marker", "PLAINTEXT-"),
      ];
      expect(findLeaks(rec, forbidden)).toEqual([]);
    });
  });
}
