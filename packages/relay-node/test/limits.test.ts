// relay-node's relay-wide caps and outbound queue limit (03, Node implementation:
// Relay-wide limits; ADR-032).
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { base32Encode } from "../../core/src/base32.js";
import { FrameQueue } from "../../core/test/relay-conformance/frame-queue.js";
import { UpgradeRefused, type Received } from "../../core/test/relay-conformance/suite.js";
import { DEFAULT_CAPS, capsFromEnv, type RelayCaps } from "../src/caps.js";
import { startNodeRelay } from "./ws-relay.js";

const MiB = 1024 * 1024;
const room = () => base32Encode(randomBytes(16));
const frame = (n: number, size: number) => Uint8Array.from({ length: size }, (_, i) => (i === 0 ? 0x02 : (n + i) & 0xff));

interface Raw {
  ws: WebSocket;
  queue: FrameQueue;
  json(): Promise<Record<string, unknown>>;
}

/** A raw client, for headers and for pausing reads. Rejects with UpgradeRefused on an HTTP error. */
function connect(port: number, roomId: string, headers: Record<string, string> = {}): Promise<Raw> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/rooms/${roomId}`, { headers });
    const queue = new FrameQueue();
    ws.on("unexpected-response", (_req, res) => reject(new UpgradeRefused(res.statusCode ?? 0)));
    ws.on("error", reject);
    ws.on("message", (data, isBinary) => {
      const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as Buffer);
      queue.push(isBinary ? { kind: "binary", data: new Uint8Array(buf) } : { kind: "text", data: buf.toString("utf8") });
    });
    ws.on("close", (code) => queue.push({ kind: "close", code }));
    ws.on("open", () =>
      resolve({
        ws,
        queue,
        async json() {
          const ev = await queue.next();
          if (ev.kind !== "text") throw new Error(`expected text, got ${JSON.stringify(ev)}`);
          return JSON.parse(ev.data) as Record<string, unknown>;
        },
      }),
    );
  });
}

async function join(c: Raw, token: string | null = null): Promise<{ token: string }> {
  c.ws.send(JSON.stringify({ t: "join", v: 1, token }));
  const joined = await c.json();
  expect(joined.t).toBe("joined");
  return joined as unknown as { token: string };
}

async function withRelay(caps: Partial<RelayCaps>, fn: (r: Awaited<ReturnType<typeof startNodeRelay>>, lines: string[]) => Promise<void>) {
  const lines: string[] = [];
  const relay = await startNodeRelay((line) => lines.push(line), { caps });
  try {
    await fn(relay, lines);
  } finally {
    await relay.close();
  }
}

const settle = () => new Promise((r) => setTimeout(r, 50));

describe("relay-node caps from the environment (03, Relay-wide limits)", () => {
  it("uses the defaults when nothing is set", () => {
    expect(capsFromEnv({})).toEqual({});
    expect(DEFAULT_CAPS).toEqual({
      maxSockets: 1024,
      maxSocketsPerAddress: 0,
      maxRooms: 10_000,
      maxBufferedBytes: 256 * MiB,
      maxOutboundBytes: 2 * MiB,
      trustProxy: false,
    });
  });

  it("reads each variable, buffered bytes in MiB", () => {
    expect(
      capsFromEnv({
        PAIRWIRE_RELAY_MAX_SOCKETS: "50",
        PAIRWIRE_RELAY_MAX_SOCKETS_PER_ADDRESS: "4",
        PAIRWIRE_RELAY_MAX_ROOMS: "0",
        PAIRWIRE_RELAY_MAX_BUFFERED_MIB: "16",
        PAIRWIRE_RELAY_TRUST_PROXY: "1",
      }),
    ).toEqual({ maxSockets: 50, maxSocketsPerAddress: 4, maxRooms: 0, maxBufferedBytes: 16 * MiB, trustProxy: true });
    expect(capsFromEnv({ PAIRWIRE_RELAY_TRUST_PROXY: "0", PAIRWIRE_RELAY_MAX_SOCKETS: "" })).toEqual({ trustProxy: false });
  });

  it("rejects values that aren't non-negative integers, naming the variable", () => {
    for (const bad of ["-1", "1.5", "ten", "1e3", " 5"]) {
      expect(() => capsFromEnv({ PAIRWIRE_RELAY_MAX_SOCKETS: bad }), bad).toThrow(/PAIRWIRE_RELAY_MAX_SOCKETS/);
    }
    expect(() => capsFromEnv({ PAIRWIRE_RELAY_TRUST_PROXY: "yes" })).toThrow(/PAIRWIRE_RELAY_TRUST_PROXY/);
  });
});

describe("relay-node relay-wide caps (03, Relay-wide limits)", () => {
  it("refuses an upgrade beyond the socket cap with HTTP 503, and admits again once one closes", async () => {
    await withRelay({ maxSockets: 2 }, async ({ port }) => {
      const a = await connect(port, room());
      await connect(port, room());
      await expect(connect(port, room())).rejects.toMatchObject({ status: 503 });
      a.ws.close();
      await settle();
      await connect(port, room());
    });
  });

  it("refuses an upgrade beyond the per-address cap, counting X-Forwarded-For only behind a trusted proxy", async () => {
    await withRelay({ maxSocketsPerAddress: 2 }, async ({ port }) => {
      await connect(port, room(), { "x-forwarded-for": "198.51.100.1" });
      await connect(port, room(), { "x-forwarded-for": "198.51.100.2" });
      // untrusted header: both came from 127.0.0.1
      await expect(connect(port, room(), { "x-forwarded-for": "198.51.100.3" })).rejects.toMatchObject({ status: 503 });
    });
    await withRelay({ maxSocketsPerAddress: 2, trustProxy: true }, async ({ port }) => {
      const xff = (ip: string) => ({ "x-forwarded-for": `203.0.113.9, ${ip}` });
      await connect(port, room(), xff("198.51.100.1"));
      await connect(port, room(), xff("198.51.100.1"));
      await expect(connect(port, room(), xff("198.51.100.1"))).rejects.toMatchObject({ status: 503 });
      await connect(port, room(), xff("198.51.100.2"));
    });
  });

  it("refuses an upgrade to a new room beyond the room cap, but not to a room it holds", async () => {
    await withRelay({ maxRooms: 1 }, async ({ port }) => {
      const held = room();
      await join(await connect(port, held));
      await expect(connect(port, room())).rejects.toMatchObject({ status: 503 });
      await join(await connect(port, held));
    });
  });

  it("answers buffer_full once the relay's buffered bytes reach the cap, across rooms", async () => {
    await withRelay({ maxBufferedBytes: 100 }, async ({ port }) => {
      const offlinePair = async () => {
        const roomId = room();
        const a = await connect(port, roomId);
        await join(a);
        const b = await connect(port, roomId);
        const { token } = await join(b);
        await a.json(); // peer_joined
        b.ws.close();
        expect(await a.json()).toEqual({ t: "peer_left", reason: "disconnected" });
        return { roomId, a, token };
      };
      const one = await offlinePair();
      const two = await offlinePair();
      one.a.ws.send(frame(1, 60));
      await one.a.queue.quiet();
      two.a.ws.send(frame(2, 60));
      expect(await two.a.json()).toEqual({ t: "error", code: "buffer_full" });
      // delivering room one's frame frees its bytes
      const back = await connect(port, one.roomId);
      await join(back, one.token);
      expect(await back.queue.next()).toEqual({ kind: "binary", data: frame(1, 60) });
      two.a.ws.send(frame(3, 60));
      await two.a.queue.quiet();
    });
  });

  it("logs refusals at most once a minute per cap, with a count and never the address or room id", async () => {
    await withRelay({ maxSockets: 1 }, async (relay, lines) => {
      const { port } = relay;
      const roomId = room();
      await connect(port, roomId);
      for (let i = 0; i < 3; i++) await expect(connect(port, roomId)).rejects.toMatchObject({ status: 503 });
      relay.clock.advance(60_000);
      await expect(connect(port, roomId)).rejects.toMatchObject({ status: 503 });
      const refusals = lines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l.event === "limit_refused");
      expect(refusals).toEqual([
        expect.objectContaining({ level: "warn", limit: "sockets", count: 1 }),
        expect.objectContaining({ level: "warn", limit: "sockets", count: 3 }),
      ]);
      const all = lines.join("\n");
      expect(all).not.toContain("127.0.0.1");
      expect(all).not.toContain(roomId);
    });
  });
});

describe("relay-node outbound queue (03, Relay-wide limits; ADR-032)", () => {
  it("closes a member that stops reading with 4008 and tells its peer it disconnected", async () => {
    await withRelay({ maxOutboundBytes: 64 * 1024 }, async (relay, lines) => {
      const { port } = relay;
      const roomId = room();
      const a = await connect(port, roomId);
      await join(a);
      const b = await connect(port, roomId);
      await join(b);
      await a.json(); // peer_joined
      const raw = (b.ws as unknown as { _socket: { pause(): void; resume(): void } })._socket;
      raw.pause(); // b stops reading; the relay's queue to b grows once the kernel buffers fill
      const peerLeft: Received = { kind: "text", data: '{"t":"peer_left","reason":"disconnected"}' };
      const seen: Received[] = [];
      for (let round = 0; round < 40 && !seen.some((ev) => ev.kind === "text" && ev.data === peerLeft.data); round++) {
        for (let i = 0; i < 20; i++) a.ws.send(frame(i, 60 * 1024));
        await settle();
        relay.clock.advance(20_000); // refill a's rate limit
        for (let ev = await a.queue.next(100).catch(() => undefined); ev; ev = await a.queue.next(100).catch(() => undefined)) {
          seen.push(ev);
        }
      }
      expect(seen).toContainEqual(peerLeft);
      expect(lines.some((l) => l.includes('"code":4008'))).toBe(true);
      raw.resume();
      let ev: Received;
      do ev = await b.queue.next(5000);
      while (ev.kind === "binary");
      expect(ev).toEqual({ kind: "close", code: 4008 });
    });
  }, 30_000);
});
