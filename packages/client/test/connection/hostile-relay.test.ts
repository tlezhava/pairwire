// A relay that lies (05, A1; 02 §4.1, §5; ADR-031): bad control frames, replayed epochs
// and HELLOs. The relay here is a scripted fake socket, so each frame is under the test's
// control and nothing is sent to a network.
import { join } from "node:path";
import { deriveRoomKeys, generateSecret, Handshake, HELLO_TYPE, type HelloPayload } from "@pairwire/core";
import { afterEach, describe, expect, it } from "vitest";
import { RoomConnection, type ConnectionEvents, type SocketFactory, type SocketHandlers } from "../../src/connection.js";
import { createLogger } from "../../src/log.js";
import { createRoom, readState } from "../../src/state.js";
import { tempDir } from "../state/helpers.js";
import { FAST, sleep, until } from "./harness.js";

const TOKEN = "T".repeat(43);
const EXPIRES = Date.now() + 3600_000;

interface FakeSocket {
  handlers: SocketHandlers;
  text: string[];
  binary: Uint8Array[];
  closed: number | null;
}

const joined = (epoch: unknown, peer_present = true, over: Record<string, unknown> = {}) =>
  JSON.stringify({ t: "joined", member: "a", token: TOKEN, epoch, peer_present, buffered: 0, expires_at: EXPIRES, ...over });

const peerHello = (name: string): HelloPayload => ({ v: 1, name, harness: "codex", client: "pairwire/test", instance: "b".repeat(26), caps: ["ack"] });

const stops: (() => void)[] = [];
afterEach(() => {
  for (const s of stops.splice(0)) s();
});

function setup(events: ConnectionEvents = {}) {
  const secret = generateSecret();
  const keys = deriveRoomKeys(secret);
  const home = join(tempDir(), ".pairwire");
  createRoom(home, { roomId: keys.roomId, secret, relay: "127.0.0.1:1", name: "Tazo", now: Date.now() }, {});
  const sockets: FakeSocket[] = [];
  const factory: SocketFactory = (_url, handlers) => {
    const s: FakeSocket = { handlers, text: [], binary: [], closed: null };
    sockets.push(s);
    queueMicrotask(() => handlers.onOpen());
    return { sendText: (d) => s.text.push(d), sendBinary: (d) => s.binary.push(d), close: (code) => (s.closed = code ?? 1000) };
  };
  const lines: string[] = [];
  const conn = new RoomConnection({
    home,
    keys,
    url: `ws://127.0.0.1:1/v1/rooms/${keys.roomId}`,
    hello: { v: 1, name: "Tazo", harness: "claude-code", client: "pairwire/test", instance: readState(home, keys.roomId)!.instance, caps: ["ack"] },
    log: createLogger({ sink: (l) => lines.push(l) }),
    events,
    socketFactory: factory,
    tuning: FAST,
  });
  stops.push(() => conn.stop());
  conn.start();
  const socket = async (n: number) => {
    await until(() => sockets.length > n && sockets[n]!.text.length > 0, 3000, `socket ${n} to send join`);
    return sockets[n]!;
  };
  const state = () => readState(home, keys.roomId)!;
  const warnings = (event: string) => lines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l.event === event);
  return { keys, conn, sockets, socket, state, warnings, lines };
}

describe("connection: invalid relay control frames (02 §5)", () => {
  const bad: [string, string][] = [
    ["an epoch over u32", '{"t":"peer_joined","epoch":4294967296}'],
    ["no epoch", '{"t":"peer_joined"}'],
    ["a fractional epoch", '{"t":"peer_joined","epoch":1.5}'],
    ["an unbounded retry_after", '{"t":"error","code":"rate_limited","retry_after":1000000000000}'],
    ["text that is not JSON", "{oops"],
  ];
  for (const [what, frame] of bad) {
    it(`ADR-031: ${what} neither throws nor halts; the client logs it and reconnects`, async () => {
      const r = setup();
      const s0 = await r.socket(0);
      s0.handlers.onText(joined(1, false));
      expect(() => s0.handlers.onText(frame)).not.toThrow();
      expect(s0.closed).toBe(1002);
      expect(r.conn.status().halted).toBeNull();
      const [warning] = r.warnings("relay_protocol_error");
      expect(warning).toMatchObject({ reason: "bad_frame" });
      expect(r.lines.join("\n")).not.toContain(frame);
      await r.socket(1); // reconnected with backoff
      expect(r.state().epoch).toBe(1);
    });
  }

  it("ADR-031: a joined with a bad epoch changes nothing in state.json", async () => {
    const r = setup();
    const s0 = await r.socket(0);
    expect(() => s0.handlers.onText(joined(1.5, false, { expires_at: 1 }))).not.toThrow();
    expect(s0.closed).toBe(1002);
    expect(r.state()).toMatchObject({ epoch: null, token: null, expires_at: null });
    const s1 = await r.socket(1);
    s1.handlers.onText(joined(2, false));
    expect(r.state()).toMatchObject({ epoch: 2, token: TOKEN, expires_at: EXPIRES, member: "a" });
    expect(r.conn.status().socket).toBe("joined");
  });

  it("ignores a frame type it does not know, for newer relays", async () => {
    const r = setup();
    const s0 = await r.socket(0);
    s0.handlers.onText(joined(1, false));
    s0.handlers.onText('{"t":"room_info","anything":[1,2]}');
    expect(s0.closed).toBeNull();
    expect(r.warnings("relay_protocol_error")).toEqual([]);
  });

  it("ADR-031: an exception in a handler stays out of the socket library and costs a reconnect", async () => {
    const r = setup({
      inbound: () => {
        throw new Error("listener failed");
      },
    });
    const peer = new Handshake({ keys: r.keys, payload: peerHello("Nika") });
    const s0 = await r.socket(0);
    s0.handlers.onText(joined(1));
    // The first session queues a peer_joined notice, whose listener throws.
    expect(() => s0.handlers.onBinary(peer.startEpoch(1)!)).not.toThrow();
    expect(r.warnings("relay_handler_failed")).toEqual([expect.objectContaining({ on: "binary", error: "Error" })]);
    expect(s0.closed).toBe(1002);
    await r.socket(1);
  });
});

describe("connection: epoch floor across connections (02 §4.1)", () => {
  it("ADR-031: a reconnect given an epoch at or below the floor sends no HELLO and reconnects", async () => {
    const r = setup();
    const s0 = await r.socket(0);
    s0.handlers.onText(joined(5));
    expect(s0.binary.map((b) => b[0])).toEqual([HELLO_TYPE]);
    expect(r.state().epoch).toBe(5);
    s0.handlers.onClose(1006);

    const s1 = await r.socket(1);
    s1.handlers.onText(joined(5, true, { expires_at: 1 }));
    expect(s1.binary).toEqual([]);
    expect(s1.closed).toBe(1002);
    expect(r.state()).toMatchObject({ epoch: 5, expires_at: EXPIRES });
    expect(r.warnings("relay_protocol_error")).toEqual([expect.objectContaining({ reason: "epoch_rollback", epoch: 5, floor: 5 })]);

    // A relay that lost an epoch catches up: the next accepted socket is above the floor.
    const s2 = await r.socket(2);
    s2.handlers.onText(joined(6));
    expect(s2.binary.map((b) => b[0])).toEqual([HELLO_TYPE]);
    expect(r.state().epoch).toBe(6);
    expect(r.conn.status().halted).toBeNull();
  });

  it("ADR-031: a relay replaying the peer's HELLO from an earlier connection can't replace the session", async () => {
    const r = setup();
    const peer = new Handshake({ keys: r.keys, payload: peerHello("Nika") });
    const s0 = await r.socket(0);
    s0.handlers.onText(joined(5));
    const recorded = peer.startEpoch(5)!;
    s0.handlers.onBinary(recorded);
    const sid = r.state().sessions.current?.sid;
    expect(sid).toBeTruthy();
    s0.handlers.onClose(1006);

    // The relay answers the reconnect with the old epoch and replays the HELLO: refused.
    const s1 = await r.socket(1);
    s1.handlers.onText(joined(5));
    s1.handlers.onBinary(recorded);
    // Or with a newer epoch, replaying the old HELLO anyway: dropped as stale.
    const s2 = await r.socket(2);
    s2.handlers.onText(joined(9));
    s2.handlers.onBinary(recorded);
    expect(r.state().sessions).toMatchObject({ current: { sid }, previous: null });
  });

  it("ADR-031: peer_joined before joined, or not above the connection's epoch, is a relay protocol error", async () => {
    const r = setup();
    const s0 = await r.socket(0);
    s0.handlers.onText('{"t":"peer_joined","epoch":3}');
    expect(s0.closed).toBe(1002);
    expect(s0.binary).toEqual([]);

    const s1 = await r.socket(1);
    s1.handlers.onText(joined(4, false));
    s1.handlers.onText('{"t":"peer_joined","epoch":4}');
    expect(s1.closed).toBe(1002);
    expect(s1.binary).toEqual([]);
    expect(r.warnings("relay_protocol_error").map((w) => w.reason)).toEqual(["epoch_order", "epoch_order"]);
  });

  it("ADR-031: persists the epoch of every peer_joined as the floor", async () => {
    const r = setup();
    const s0 = await r.socket(0);
    s0.handlers.onText(joined(4, false));
    s0.handlers.onText('{"t":"peer_joined","epoch":8}');
    expect(s0.binary.map((b) => b[0])).toEqual([HELLO_TYPE]);
    expect(r.state().epoch).toBe(8);
    s0.handlers.onClose(1006);
    const s1 = await r.socket(1);
    s1.handlers.onText(joined(7));
    expect(s1.closed).toBe(1002);
    await sleep(0);
    expect(r.state().epoch).toBe(8);
  });
});
