// Relay conformance suite (07-testing.md, "Relay conformance"). One file, run against every
// relay implementation through the RelayUnderTest interface. Behavior is 02 §5 and 03.
import { randomBytes } from "@noble/hashes/utils.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { base32Encode } from "../../src/base32.js";
import { RELAY_LIMITS, SUPPORTED_PROTOCOLS } from "../../src/limits.js";

export type Received =
  | { kind: "text"; data: string }
  | { kind: "binary"; data: Uint8Array }
  | { kind: "close"; code: number };

export interface TestSocket {
  sendText(data: string): void;
  sendBinary(data: Uint8Array): void;
  /** The next frame or the close; rejects after `timeoutMs`. */
  next(timeoutMs?: number): Promise<Received>;
  /** Resolves if nothing arrives within `ms`; rejects otherwise. */
  quiet(ms?: number): Promise<void>;
  /** Client-initiated close (code 1000); resolves once the socket is closed. */
  close(): Promise<void>;
}

export interface HttpResponse {
  status: number;
  body: string;
  headers: Record<string, string>;
}

/** Thrown by `connect` when the relay refuses the upgrade with an HTTP status. */
export class UpgradeRefused extends Error {
  constructor(readonly status: number) {
    super(`upgrade refused with HTTP ${status}`);
  }
}

export interface RelayUnderTest {
  /** Opens a WebSocket to /v1/rooms/<roomId>. Rejects with UpgradeRefused on an HTTP error. */
  connect(roomId: string): Promise<TestSocket>;
  get(path: string): Promise<HttpResponse>;
  /** Moves the relay's clock forward and runs whatever became due. Only with `fakeClock`. */
  advance?(ms: number): Promise<void>;
  close(): Promise<void>;
}

export interface ConformanceOptions {
  /** The relay's clock can be advanced: run the time-based cases (REQ-ROOM-7 and others). */
  fakeClock: boolean;
}

const S = 1000;
const H = 3600 * S;
const D = 24 * H;

export function relayConformance(name: string, factory: () => Promise<RelayUnderTest>, options: ConformanceOptions): void {
  describe(`relay conformance: ${name}`, () => {
    let relay: RelayUnderTest;
    beforeAll(async () => {
      relay = await factory();
    });
    afterAll(async () => {
      await relay?.close();
    });

    const room = () => base32Encode(randomBytes(16));
    const msg = (n: number, size = 48) => Uint8Array.from({ length: size }, (_, i) => (i === 0 ? 0x02 : (n * 7 + i) & 0xff));
    const hello = () => Uint8Array.from({ length: 120 }, (_, i) => (i === 0 ? 0x01 : i & 0xff));

    async function text(socket: TestSocket): Promise<Record<string, unknown>> {
      const ev = await socket.next();
      if (ev.kind !== "text") throw new Error(`expected a text frame, got ${JSON.stringify(ev)}`);
      return JSON.parse(ev.data) as Record<string, unknown>;
    }
    async function binary(socket: TestSocket): Promise<Uint8Array> {
      const ev = await socket.next();
      if (ev.kind !== "binary") throw new Error(`expected a binary frame, got ${JSON.stringify(ev)}`);
      return ev.data;
    }
    async function closed(socket: TestSocket): Promise<number> {
      const ev = await socket.next();
      if (ev.kind !== "close") throw new Error(`expected a close, got ${JSON.stringify(ev)}`);
      return ev.code;
    }
    /** Barrier: a pong proves the relay has processed everything sent before the ping. */
    async function sync(socket: TestSocket): Promise<void> {
      socket.sendText('{"t":"ping"}');
      expect(await socket.next()).toEqual({ kind: "text", data: '{"t":"pong"}' });
    }
    async function join(roomId: string, token: string | null = null) {
      const socket = await relay.connect(roomId);
      socket.sendText(JSON.stringify({ t: "join", v: 1, token }));
      return { socket, first: await socket.next() };
    }
    async function member(roomId: string, token: string | null = null) {
      const { socket, first } = await join(roomId, token);
      if (first.kind !== "text") throw new Error(`join failed: ${JSON.stringify(first)}`);
      const joined = JSON.parse(first.data) as { t: string; member: string; token: string; epoch: number };
      expect(joined.t).toBe("joined");
      return { socket, joined };
    }
    /** a and b both joined; a has seen peer_joined. */
    async function pair(roomId = room()) {
      const a = await member(roomId);
      const b = await member(roomId);
      expect(await text(a.socket)).toEqual({ t: "peer_joined", epoch: b.joined.epoch });
      return { roomId, a, b };
    }

    describe("HTTP surface (03)", () => {
      it("GET /health answers 200 ok", async () => {
        const res = await relay.get("/health");
        expect(res.status).toBe(200);
        expect(res.body.trim()).toBe("ok");
      });

      it("GET /v1/info reports protocols, relay version and the limits table", async () => {
        const res = await relay.get("/v1/info");
        expect(res.status).toBe(200);
        const info = JSON.parse(res.body);
        expect(info.protocol).toEqual([...SUPPORTED_PROTOCOLS]);
        expect(info.relay).toMatch(/^\d+\.\d+\.\d+/);
        expect(info.limits).toEqual(RELAY_LIMITS);
      });

      it("answers 404 for anything else, with no CORS or cookies", async () => {
        for (const path of ["/", "/v2/info", "/v1/rooms", "/v1/infox"]) {
          const res = await relay.get(path);
          expect(res.status, path).toBe(404);
          expect(res.headers["access-control-allow-origin"], path).toBeUndefined();
          expect(res.headers["set-cookie"], path).toBeUndefined();
        }
      });

      it("refuses a room id that is not 26 base32 characters with HTTP 400", async () => {
        for (const bad of ["short", room().toUpperCase(), `${room()}a`, room().slice(0, 25) + "1"]) {
          await expect(relay.connect(bad), bad).rejects.toMatchObject({ status: 400 });
        }
      });
    });

    describe("membership (02 §5)", () => {
      it("assigns slots a then b, increments the epoch and tells the first member", async () => {
        const roomId = room();
        const a = await member(roomId);
        expect(a.joined).toEqual({
          t: "joined",
          member: "a",
          token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
          epoch: expect.any(Number),
          peer_present: false,
          buffered: 0,
          expires_at: expect.any(Number),
        });
        const b = await member(roomId);
        expect(b.joined).toMatchObject({ member: "b", peer_present: true, epoch: a.joined.epoch + 1 });
        expect(await text(a.socket)).toEqual({ t: "peer_joined", epoch: b.joined.epoch });
      });

      it("REQ-ROOM-4 refuses a third member with close 4001", async () => {
        const { roomId } = await pair();
        const third = await join(roomId);
        expect(third.first).toEqual({ kind: "close", code: 4001 });
      });

      it("tells the peer when a member disconnects, and lets it rejoin with its token", async () => {
        const { roomId, a, b } = await pair();
        await b.socket.close();
        expect(await text(a.socket)).toEqual({ t: "peer_left", reason: "disconnected" });
        const back = await member(roomId, b.joined.token);
        expect(back.joined).toMatchObject({ member: "b", token: b.joined.token, peer_present: true });
        expect(await text(a.socket)).toEqual({ t: "peer_joined", epoch: back.joined.epoch });
      });

      it("closes the older socket with 4007 when its token rejoins", async () => {
        const { roomId, a, b } = await pair();
        const again = await member(roomId, b.joined.token);
        expect(await closed(b.socket)).toBe(4007);
        expect(await text(a.socket)).toEqual({ t: "peer_joined", epoch: again.joined.epoch });
      });

      it("closes a join with an unknown token with 4002, even when a slot is free", async () => {
        const roomId = room();
        await member(roomId);
        expect((await join(roomId, "A".repeat(43))).first).toEqual({ kind: "close", code: 4002 });
      });

      it("ends the room on leave: peer_left to the other member, 4003 to both, 4003 to later joins", async () => {
        const { roomId, a, b } = await pair();
        a.socket.sendText('{"t":"leave"}');
        expect(await text(b.socket)).toEqual({ t: "peer_left", reason: "left" });
        expect(await closed(b.socket)).toBe(4003);
        expect(await closed(a.socket)).toBe(4003);
        for (const token of [a.joined.token, null]) {
          const late = await join(roomId, token);
          expect(late.first).toEqual({ kind: "text", data: '{"t":"peer_left","reason":"left"}' });
          expect(await closed(late.socket)).toBe(4003);
        }
      });

      it("keeps rooms independent", async () => {
        const one = await pair();
        const two = await pair();
        one.a.socket.sendBinary(msg(1));
        expect(await binary(one.b.socket)).toEqual(msg(1));
        await two.b.socket.quiet();
      });
    });

    describe("control frames (02 §5)", () => {
      it("answers ping with exactly pong, before and after join", async () => {
        const socket = await relay.connect(room());
        socket.sendText('{"t":"ping"}');
        expect(await socket.next()).toEqual({ kind: "text", data: '{"t":"pong"}' });
        socket.sendText(JSON.stringify({ t: "join", v: 1, token: null }));
        expect(JSON.parse(((await socket.next()) as { data: string }).data)).toMatchObject({ t: "joined" });
        socket.sendText('{"t":"ping"}');
        expect(await socket.next()).toEqual({ kind: "text", data: '{"t":"pong"}' });
      });

      it("closes with 4005 when the first frame is not a join", async () => {
        for (const frame of ['{"t":"leave"}', "not json", '{"t":"join","v":1}']) {
          const socket = await relay.connect(room());
          socket.sendText(frame);
          expect(await closed(socket), frame).toBe(4005);
        }
        const socket = await relay.connect(room());
        socket.sendBinary(msg(1));
        expect(await closed(socket)).toBe(4005);
      });

      it("closes with 4004 for an unsupported protocol version", async () => {
        const socket = await relay.connect(room());
        socket.sendText('{"t":"join","v":2,"token":null}');
        expect(await closed(socket)).toBe(4004);
      });

      it("closes the oldest unjoined socket with 4008 beyond 8 per room, and lets the newest join", async () => {
        const roomId = room();
        const waiting: TestSocket[] = [];
        for (let i = 0; i < RELAY_LIMITS.unjoinedSocketsPerRoom; i++) waiting.push(await relay.connect(roomId));
        const newest = await relay.connect(roomId);
        expect(await closed(waiting[0]!)).toBe(4008);
        newest.sendText(JSON.stringify({ t: "join", v: 1, token: null }));
        expect(await text(newest)).toMatchObject({ t: "joined", member: "a" });
        await waiting[1]!.quiet();
      });

      it("sends at most 10 error replies at once to one socket, and still drops the frames", async () => {
        const { a, b } = await pair();
        for (let i = 0; i < RELAY_LIMITS.relayReplyBurst + 3; i++) a.socket.sendBinary(msg(i, RELAY_LIMITS.maxBinaryFrameBytes + 1));
        for (let i = 0; i < RELAY_LIMITS.relayReplyBurst; i++) expect(await text(a.socket)).toEqual({ t: "error", code: "too_large" });
        await a.socket.quiet();
        await b.socket.quiet();
        if (!options.fakeClock) return;
        await relay.advance!(1 * S);
        a.socket.sendBinary(msg(99, RELAY_LIMITS.maxBinaryFrameBytes + 1));
        expect(await text(a.socket)).toEqual({ t: "error", code: "too_large" });
      });

      it("closes with 4005 for a control frame over 1 KiB", async () => {
        const { socket } = await member(room());
        socket.sendText(JSON.stringify({ t: "leave", pad: "x".repeat(1100) }));
        expect(await closed(socket)).toBe(4005);
      });
    });

    describe("binary frames (02 §3, §5; 03 Limits)", () => {
      it("forwards binary frames unchanged in both directions", async () => {
        const { a, b } = await pair();
        a.socket.sendBinary(msg(1));
        expect(await binary(b.socket)).toEqual(msg(1));
        b.socket.sendBinary(msg(2, 32 * 1024));
        expect(await binary(a.socket)).toEqual(msg(2, 32 * 1024));
        await a.socket.quiet();
      });

      it("REQ-MSG-5 buffers frames for an offline member and delivers them in order before peer_joined", async () => {
        const { roomId, a, b } = await pair();
        await b.socket.close();
        expect(await text(a.socket)).toMatchObject({ t: "peer_left" });
        for (let i = 0; i < 3; i++) a.socket.sendBinary(msg(i));
        await a.socket.quiet();
        const back = await member(roomId, b.joined.token);
        expect(back.joined).toMatchObject({ buffered: 3 });
        for (let i = 0; i < 3; i++) expect(await binary(back.socket)).toEqual(msg(i));
        expect(await text(a.socket)).toEqual({ t: "peer_joined", epoch: back.joined.epoch });
      });

      it("never buffers a HELLO", async () => {
        const { roomId, a, b } = await pair();
        a.socket.sendBinary(hello());
        expect(await binary(b.socket)).toEqual(hello());
        await b.socket.close();
        await text(a.socket);
        a.socket.sendBinary(hello());
        const back = await member(roomId, b.joined.token);
        expect(back.joined).toMatchObject({ buffered: 0 });
        await back.socket.quiet();
      });

      it("drops a binary frame over 64 KiB with error too_large", async () => {
        const { a, b } = await pair();
        a.socket.sendBinary(msg(1, RELAY_LIMITS.maxBinaryFrameBytes + 1));
        expect(await text(a.socket)).toEqual({ t: "error", code: "too_large" });
        a.socket.sendBinary(msg(2, RELAY_LIMITS.maxBinaryFrameBytes));
        expect(await binary(b.socket)).toEqual(msg(2, RELAY_LIMITS.maxBinaryFrameBytes));
      });

      it("rate-limits a member after a burst of 20 binary frames", async () => {
        const { a, b } = await pair();
        for (let i = 0; i < RELAY_LIMITS.binaryFrameBurst; i++) a.socket.sendBinary(msg(i));
        a.socket.sendBinary(msg(99));
        for (let i = 0; i < RELAY_LIMITS.binaryFrameBurst; i++) expect(await binary(b.socket)).toEqual(msg(i));
        expect(await text(a.socket)).toMatchObject({ t: "error", code: "rate_limited", retry_after: expect.any(Number) });
        await b.socket.quiet();
      });

      it("refuses a frame beyond the offline buffer's 100 frames with buffer_full", async () => {
        // Sent in bursts within the rate limit; needs the fake clock to stay fast.
        if (!options.fakeClock) return;
        const { a, b } = await pair();
        await b.socket.close();
        await text(a.socket);
        for (let i = 0; i < RELAY_LIMITS.offlineBufferFrames; i++) {
          if (i % 10 === 0) await relay.advance!(10 * S);
          a.socket.sendBinary(msg(i, 8));
        }
        await relay.advance!(10 * S);
        a.socket.sendBinary(msg(100, 8));
        expect(await text(a.socket)).toEqual({ t: "error", code: "buffer_full" });
      });
    });

    describe.runIf(options.fakeClock)("time (03 Limits, REQ-ROOM-7)", () => {
      it("closes a socket that hasn't joined within 10 s with 4006", async () => {
        const socket = await relay.connect(room());
        await relay.advance!(RELAY_LIMITS.joinDeadlineMs);
        expect(await closed(socket)).toBe(4006);
      });

      it("REQ-ROOM-7 ends a room after 72 h with no connected member and no frame", async () => {
        const { roomId, a, b } = await pair();
        await a.socket.close();
        await b.socket.close();
        await relay.advance!(RELAY_LIMITS.idleExpiryMs);
        const late = await join(roomId, a.joined.token);
        expect(late.first).toEqual({ kind: "close", code: 4003 });
      });

      it("REQ-ROOM-7 keeps a connected room alive past the idle expiry", async () => {
        const { a, b } = await pair();
        await relay.advance!(RELAY_LIMITS.idleExpiryMs + H);
        a.socket.sendBinary(msg(1));
        expect(await binary(b.socket)).toEqual(msg(1));
      });

      it("REQ-ROOM-7 closes both members with 4003 at 7 days and forgets the room", async () => {
        const { roomId, a, b } = await pair();
        await relay.advance!(7 * D);
        expect(await closed(a.socket)).toBe(4003);
        expect(await closed(b.socket)).toBe(4003);
        expect((await join(roomId, a.joined.token)).first).toEqual({ kind: "close", code: 4002 });
        const fresh = await member(roomId);
        expect(fresh.joined).toMatchObject({ member: "a", buffered: 0 });
      });

      it("discards buffered frames after 72 h", async () => {
        const { roomId, a, b } = await pair();
        await b.socket.close();
        await text(a.socket);
        a.socket.sendBinary(msg(1));
        await sync(a.socket);
        await relay.advance!(RELAY_LIMITS.bufferedFrameLifetimeMs);
        const back = await member(roomId, b.joined.token);
        expect(back.joined).toMatchObject({ buffered: 0 });
      });
    });
  });
}
