import { env, evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { base32Encode } from "../../core/src/base32.js";
import { RELAY_LIMITS } from "../../core/src/limits.js";
import type { TestSocket } from "../../core/test/relay-conformance/suite.js";
import pkg from "../package.json" with { type: "json" };
import type { RoomObject } from "../src/room.js";
import { RELAY_VERSION } from "../src/version.js";
import { connectRaw } from "./worker-relay.js";

const newRoom = () => base32Encode(crypto.getRandomValues(new Uint8Array(16)));
const stubFor = (roomId: string) => env.ROOMS.get(env.ROOMS.idFromName(roomId));
const msg = (n: number) => Uint8Array.from({ length: 40 }, (_, i) => (i === 0 ? 2 : (n + i) & 0xff));

async function json(s: TestSocket) {
  const ev = await s.next();
  if (ev.kind !== "text") throw new Error(`expected text, got ${JSON.stringify(ev)}`);
  return JSON.parse(ev.data) as Record<string, unknown>;
}
async function member(roomId: string, token: string | null = null) {
  const { socket } = await connectRaw(roomId);
  socket.sendText(JSON.stringify({ t: "join", v: 1, token }));
  const joined = (await json(socket)) as { t: string; token: string; epoch: number; buffered: number };
  expect(joined.t).toBe("joined");
  return { socket, joined };
}
async function pair(roomId = newRoom()) {
  const a = await member(roomId);
  const b = await member(roomId);
  await json(a.socket); // peer_joined
  return { roomId, a, b };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("relay-worker Durable Object (03, Cloudflare implementation)", () => {
  it("reports its package version at /v1/info", () => {
    expect(RELAY_VERSION).toBe(pkg.version);
  });

  it("keeps sockets, slots and tokens across a simulated hibernation (attachments restored)", async () => {
    const { roomId, a, b } = await pair();
    await evictDurableObject(stubFor(roomId));
    a.socket.sendBinary(msg(1));
    expect(await b.socket.next()).toEqual({ kind: "binary", data: msg(1) });
    b.socket.sendBinary(msg(2));
    expect(await a.socket.next()).toEqual({ kind: "binary", data: msg(2) });
    // the room still knows both slots: a third token-less join is refused
    const third = await connectRaw(roomId);
    third.socket.sendText('{"t":"join","v":1,"token":null}');
    expect(await third.socket.next()).toEqual({ kind: "close", code: 4001 });
  });

  it("keeps buffered frames in storage across hibernation", async () => {
    const { roomId, a, b } = await pair();
    await b.socket.close();
    await json(a.socket); // peer_left
    a.socket.sendBinary(msg(7));
    a.socket.sendText('{"t":"ping"}');
    await a.socket.next(); // pong: the frame has been processed
    await evictDurableObject(stubFor(roomId));
    const back = await member(roomId, b.joined.token);
    expect(back.joined.buffered).toBe(1);
    expect(await back.socket.next()).toEqual({ kind: "binary", data: msg(7) });
  });

  it("answers pings by auto-response without invoking webSocketMessage", async () => {
    const { roomId, a } = await pair();
    const stub = stubFor(roomId);
    const before = await runInDurableObject(stub, (o: RoomObject) => o.handled);
    for (let i = 0; i < 5; i++) {
      a.socket.sendText('{"t":"ping"}');
      expect(await a.socket.next()).toEqual({ kind: "text", data: '{"t":"pong"}' });
    }
    expect(await runInDurableObject(stub, (o: RoomObject) => o.handled)).toBe(before);
    a.socket.sendBinary(msg(1));
    await vi.waitFor(async () => expect(await runInDurableObject(stub, (o: RoomObject) => o.handled)).toBe(before + 1));
  });

  it("schedules the idle-expiry alarm when the last member leaves and the max-age alarm while connected", async () => {
    const { roomId, a, b } = await pair();
    const stub = stubFor(roomId);
    const created = await runInDurableObject(stub, async (_o, state) => (await state.storage.get<{ createdAt: number }>("state"))!.createdAt);
    expect(await runInDurableObject(stub, (_o, state) => state.storage.getAlarm())).toBe(created + RELAY_LIMITS.maxAgeMs);
    await a.socket.close();
    await b.socket.close();
    await vi.waitFor(async () => {
      const alarm = await runInDurableObject(stub, (_o, state) => state.storage.getAlarm());
      expect(alarm).toBeLessThan(created + RELAY_LIMITS.maxAgeMs);
      expect(alarm).toBeGreaterThanOrEqual(created + RELAY_LIMITS.idleExpiryMs);
    });
  });

  it("REQ-ROOM-7 tombstones an idle room when its alarm fires after 72 h", async () => {
    const { roomId, a, b } = await pair();
    await a.socket.close();
    await b.socket.close();
    const stub = stubFor(roomId);
    await vi.waitFor(async () => expect(await runInDurableObject(stub, (_o, s) => s.storage.getAlarm())).not.toBeNull());
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + RELAY_LIMITS.idleExpiryMs + 1000);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const state = await runInDurableObject(stub, (_o, s) => s.storage.get<{ ended: unknown; slots: unknown }>("state"));
    expect(state).toMatchObject({ ended: { reason: "expired" }, slots: {} });
    vi.useRealTimers();
    const late = await connectRaw(roomId);
    late.socket.sendText(JSON.stringify({ t: "join", v: 1, token: a.joined.token }));
    expect(await late.socket.next()).toEqual({ kind: "close", code: 4003 });
  });

  it("REQ-ROOM-7 closes members with 4003 and deletes all storage at max age", async () => {
    const { roomId, a, b } = await pair();
    const stub = stubFor(roomId);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + RELAY_LIMITS.maxAgeMs + 1000);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    vi.useRealTimers();
    expect(await a.socket.next()).toEqual({ kind: "close", code: 4003 });
    expect(await b.socket.next()).toEqual({ kind: "close", code: 4003 });
    const stored = await runInDurableObject(stub, async (_o, s) => [...(await s.storage.list()).keys()]);
    expect(stored).toEqual([]);
  });
});
