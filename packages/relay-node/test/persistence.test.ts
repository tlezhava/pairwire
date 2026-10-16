// relay-node SQLite persistence (03, Persistence; ADR-021). The real-SQLite cases need
// node:sqlite (Node 22.13+) and skip elsewhere; the "unavailable" case runs everywhere.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { base32Encode } from "../../core/src/base32.js";
import { RELAY_LIMITS } from "../../core/src/limits.js";
import { RelayRoom } from "../../core/src/relay-room.js";
import type { Received, TestSocket } from "../../core/test/relay-conformance/suite.js";
import { ManualClock } from "../src/clock.js";
import { openSqliteStore, parseStateSetting, type RoomStore, type SqliteModule } from "../src/store.js";
import { startNodeRelay } from "./ws-relay.js";

const T0 = Date.UTC(2026, 9, 15, 12);
const H = 3600 * 1000;
const D = 24 * H;
const sqlite = process.getBuiltinModule?.("node:sqlite") as SqliteModule | undefined;

const room = () => base32Encode(randomBytes(16));
const msg = (n: number) => Uint8Array.from({ length: 48 }, (_, i) => (i === 0 ? 0x02 : (n * 7 + i) & 0xff));
const joinFrame = (token: string | null) => JSON.stringify({ t: "join", v: 1, token });

async function text(socket: TestSocket): Promise<Record<string, unknown>> {
  const ev = await socket.next();
  if (ev.kind !== "text") throw new Error(`expected a text frame, got ${JSON.stringify(ev)}`);
  return JSON.parse(ev.data) as Record<string, unknown>;
}
async function sync(socket: TestSocket): Promise<void> {
  socket.sendText('{"t":"ping"}');
  expect(await socket.next()).toEqual({ kind: "text", data: '{"t":"pong"}' });
}

describe("PAIRWIRE_RELAY_STATE (03, Persistence)", () => {
  it("accepts unset, empty, memory and sqlite:<path>, and nothing else", () => {
    expect(parseStateSetting(undefined)).toEqual({ kind: "memory" });
    expect(parseStateSetting("")).toEqual({ kind: "memory" });
    expect(parseStateSetting("memory")).toEqual({ kind: "memory" });
    expect(parseStateSetting("sqlite:/data/relay.db")).toEqual({ kind: "sqlite", path: "/data/relay.db" });
    for (const bad of ["sqlite:", "sqlite", "redis://x", "/data/relay.db"]) expect(() => parseStateSetting(bad), bad).toThrow(/PAIRWIRE_RELAY_STATE/);
  });

  it("fails with a clear message where node:sqlite is unavailable (Node 20, Node 22 before 22.13)", () => {
    expect(() => openSqliteStore("/nonexistent/relay.db", () => undefined)).toThrow(
      /needs the built-in node:sqlite module, which Node v[\d.]+ doesn't have\. Run the relay on Node 22\.13 or later.*unset PAIRWIRE_RELAY_STATE/,
    );
  });

  it("exits with status 1 on a bad setting instead of falling back to memory", () => {
    const main = fileURLToPath(new URL("../src/main.ts", import.meta.url));
    const tsx = fileURLToPath(new URL("../../../node_modules/tsx/dist/cli.mjs", import.meta.url));
    const run = spawnSync(process.execPath, [tsx, "--conditions=source", main], {
      env: { ...process.env, PORT: "0", HOST: "127.0.0.1", PAIRWIRE_RELAY_STATE: "redis://nope" },
      encoding: "utf8",
      timeout: 20_000,
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('"event":"bad_state"');
    expect(run.stderr).not.toContain('"event":"listening"');
  });
});

describe.runIf(sqlite)("relay-node SQLite persistence (03, Persistence)", () => {
  let dir: string;
  let path: string;
  let clock: ManualClock;
  let store: RoomStore;
  let relay: Awaited<ReturnType<typeof startNodeRelay>>;
  let lines: string[];

  async function start(): Promise<void> {
    store = openSqliteStore(path);
    relay = await startNodeRelay((line) => lines.push(line), { clock, store });
  }
  async function restart(downtime = 0): Promise<void> {
    await relay.close();
    store.close();
    clock.advance(downtime);
    await start();
  }
  async function member(roomId: string, token: string | null = null) {
    const socket = await relay.connect(roomId);
    socket.sendText(joinFrame(token));
    const joined = await text(socket);
    expect(joined.t).toBe("joined");
    return { socket, joined: joined as { member: string; token: string; epoch: number; buffered: number; peer_present: boolean } };
  }
  async function first(roomId: string, token: string | null): Promise<Received> {
    const socket = await relay.connect(roomId);
    socket.sendText(joinFrame(token));
    return socket.next();
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "pairwire-relay-"));
    path = join(dir, "relay.db");
    clock = new ManualClock(T0);
    lines = [];
    await start();
  });
  afterEach(async () => {
    await relay.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("REQ-MSG-5 keeps tokens, epoch and buffered frames across a restart; the member rejoins and gets its frames", async () => {
    const roomId = room();
    const a = await member(roomId);
    const b = await member(roomId);
    await text(a.socket); // peer_joined
    await b.socket.close();
    expect(await text(a.socket)).toEqual({ t: "peer_left", reason: "disconnected" });
    a.socket.sendBinary(msg(1));
    a.socket.sendBinary(msg(2));
    await sync(a.socket);

    await restart(H);
    expect(lines.some((l) => l.includes('"event":"state_loaded"') && l.includes('"rooms":1'))).toBe(true);

    const b2 = await member(roomId, b.joined.token);
    expect(b2.joined).toMatchObject({ member: "b", token: b.joined.token, epoch: 3, buffered: 2, peer_present: false });
    expect(await b2.socket.next()).toEqual({ kind: "binary", data: msg(1) });
    expect(await b2.socket.next()).toEqual({ kind: "binary", data: msg(2) });

    const a2 = await member(roomId, a.joined.token);
    expect(a2.joined).toMatchObject({ member: "a", epoch: 4, peer_present: true });
    expect(await text(b2.socket)).toEqual({ t: "peer_joined", epoch: 4 });
    a2.socket.sendBinary(msg(3));
    expect(await b2.socket.next()).toEqual({ kind: "binary", data: msg(3) });
    expect(await first(roomId, null)).toEqual({ kind: "close", code: 4001 });
  });

  it("REQ-ROOM-7 idle expiry still fires after a restart", async () => {
    const roomId = room();
    const a = await member(roomId);
    await a.socket.close();
    await restart();
    await relay.advance!(RELAY_LIMITS.idleExpiryMs - H);
    expect((await member(roomId, a.joined.token)).joined.member).toBe("a");
  });

  it("REQ-ROOM-7 idle expiry is re-armed from saved state and fires on time after a restart", async () => {
    const roomId = room();
    const a = await member(roomId);
    await a.socket.close();
    await relay.advance!(H);
    await restart();
    await relay.advance!(RELAY_LIMITS.idleExpiryMs - H);
    expect(await first(roomId, a.joined.token)).toEqual({ kind: "close", code: 4003 });
  });

  it("REQ-ROOM-7 applies an idle expiry that fell due while the relay was down", async () => {
    const roomId = room();
    const a = await member(roomId);
    await a.socket.close();
    await sync(await relay.connect(roomId)); // the disconnect has reached the relay
    await restart(RELAY_LIMITS.idleExpiryMs + H);
    expect(await first(roomId, a.joined.token)).toEqual({ kind: "close", code: 4003 });
  });

  it("REQ-ROOM-7 max age still closes the room and deletes its row after a restart", async () => {
    const roomId = room();
    const a = await member(roomId);
    await member(roomId);
    await text(a.socket);
    await restart(6 * D);
    const back = await member(roomId, a.joined.token);
    await relay.advance!(D);
    expect(await back.socket.next()).toEqual({ kind: "close", code: 4003 });
    expect(await first(roomId, a.joined.token)).toEqual({ kind: "close", code: 4002 });
    await sync(await relay.connect(room()));
    expect(store.load().rooms.has(roomId)).toBe(false);
  });

  it("keeps a tombstone across a restart: later joins get peer_left and 4003", async () => {
    const roomId = room();
    const a = await member(roomId);
    const b = await member(roomId);
    await text(a.socket);
    a.socket.sendText('{"t":"leave"}');
    expect(await text(b.socket)).toEqual({ t: "peer_left", reason: "left" });
    await restart();
    const late = await relay.connect(roomId);
    late.sendText(joinFrame(b.joined.token));
    expect(await late.next()).toEqual({ kind: "text", data: '{"t":"peer_left","reason":"left"}' });
    expect(await late.next()).toEqual({ kind: "close", code: 4003 });
  });

  it("treats a slot saved as connected as disconnected at startup, so idle expiry counts from the restart", async () => {
    // A crash leaves the last saved state behind: here, a member still marked connected.
    await relay.close();
    const roomId = room();
    const live = new RelayRoom({ now: () => clock.now() });
    live.connect("s1");
    const joined = live.text("s1", joinFrame(null)).effects[0];
    const token = (JSON.parse(joined?.type === "send" ? String(joined.data) : "{}") as { token: string }).token;
    expect(live.state!.slots.a!.connected).toBe(true);
    store.save(roomId, live.state!);
    clock.advance(RELAY_LIMITS.idleExpiryMs + D); // down for longer than the idle expiry
    relay = await startNodeRelay((line) => lines.push(line), { clock, store });

    await relay.advance!(RELAY_LIMITS.idleExpiryMs - H);
    expect((await member(roomId, token)).joined).toMatchObject({ member: "a", epoch: 2 });
  });

  it("drops a row that fails to decode, logs the count, and keeps the rest", async () => {
    const roomId = room();
    const a = await member(roomId);
    await sync(a.socket);
    await relay.close();
    store.close();
    const db = new sqlite!.DatabaseSync(path);
    db.prepare("INSERT INTO rooms (room_id, state) VALUES (?, ?)").run(room(), '{"not":"a room"}');
    db.close();
    lines = [];
    await start();
    expect(lines.some((l) => l.includes('"event":"state_dropped"') && l.includes('"rooms":1'))).toBe(true);
    expect(lines.join("\n")).not.toContain(roomId);
    expect([...store.load().rooms.keys()]).toEqual([roomId]);
    expect((await member(roomId, a.joined.token)).joined.member).toBe("a");
  });

  it.skipIf(process.platform === "win32")("creates the file owner-only (it holds member tokens)", () => {
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("refuses a file written with a newer schema", async () => {
    await relay.close();
    store.close();
    const db = new sqlite!.DatabaseSync(path);
    db.exec("PRAGMA user_version = 99");
    db.close();
    expect(() => openSqliteStore(path)).toThrow(/schema 99/);
    const fix = new sqlite!.DatabaseSync(path);
    fix.exec("PRAGMA user_version = 1");
    fix.close();
    await start();
  });
});
