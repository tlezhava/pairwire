// Group rooms (02 §8, 03 Limits and Room state machine, ADR-037): the relay room in group
// mode, group relay frames, the v2 HELLO and pw2 share strings.
import { describe, expect, it } from "vitest";
import { Handshake, openHello, sealHello, type HelloPayload } from "../src/handshake.js";
import { deriveRoomKeys } from "../src/keys.js";
import { GROUP_LIMITS, RELAY_LIMITS, relayInfo } from "../src/limits.js";
import { parseGroupRelayFrame } from "../src/relay-frames.js";
import { RelayRoom, decodeRoomState, encodeRoomState, type Effect, type Output } from "../src/relay-room.js";
import { encodeShareString, generateSecret, parseShareString } from "../src/share.js";

const T0 = Date.UTC(2026, 10, 12, 12, 0, 0);
const H = 3600 * 1000;

function harness() {
  let now = T0;
  let counter = 0;
  const room = new RelayRoom({ now: () => now, random: (n) => Uint8Array.from({ length: n }, (_, i) => (counter++ * 31 + i) & 0xff) });
  return {
    room,
    advance: (ms: number) => (now += ms),
    join: (socket: string, frame: Record<string, unknown>) => {
      room.connect(socket);
      return room.text(socket, JSON.stringify({ t: "join", ...frame }));
    },
  };
}

const sent = (out: Output, socket: string) =>
  out.effects.filter((e): e is Extract<Effect, { type: "send" }> => e.type === "send" && e.socket === socket).map((e) => e.data);
const json = (out: Output, socket: string) =>
  sent(out, socket)
    .filter((d): d is string => typeof d === "string")
    .map((d) => JSON.parse(d) as Record<string, unknown>);
const binary = (out: Output, socket: string) => sent(out, socket).filter((d): d is Uint8Array => d instanceof Uint8Array);
const closes = (out: Output) => out.effects.filter((e): e is Extract<Effect, { type: "close" }> => e.type === "close").map((e) => [e.socket, e.code]);
const joined = (out: Output, socket: string) => json(out, socket).find((f) => f.t === "joined")!;
/** to || MSG frame */
const msgTo = (to: number, n = 1, size = 40) => Uint8Array.from({ length: size }, (_, i) => (i === 0 ? to : i === 1 ? 0x02 : (n + i) & 0xff));
const helloTo = (to: number) => Uint8Array.from({ length: 100 }, (_, i) => (i === 0 ? to : i === 1 ? 0x01 : i));

/** A room for `capacity` with members s0..s(n-1) joined. */
function group(capacity: number, n: number) {
  const h = harness();
  const tokens: string[] = [];
  const first = h.join("s0", { v: 2, token: null, capacity });
  tokens.push(joined(first, "s0").token as string);
  for (let i = 1; i < n; i++) tokens.push(joined(h.join(`s${i}`, { v: 2, token: null }), `s${i}`).token as string);
  return { ...h, tokens };
}

describe("relay room: group mode (02 §8.2)", () => {
  it("REQ-ROOM-9 a v2 tokenless join with capacity creates a group room; members get slots 0 upward", () => {
    const h = harness();
    const a = h.join("s0", { v: 2, token: null, capacity: 3 });
    expect(joined(a, "s0")).toMatchObject({ t: "joined", member: 0, epoch: 1, capacity: 3, taken: [], present: [], buffered: 0, expires_at: T0 + RELAY_LIMITS.maxAgeMs });
    const b = h.join("s1", { v: 2, token: null });
    expect(joined(b, "s1")).toMatchObject({ member: 1, epoch: 2, capacity: 3, present: [0] });
    expect(json(b, "s0")).toEqual([{ t: "peer_joined", member: 1, epoch: 2 }]);
    const c = h.join("s2", { v: 2, token: null, capacity: 8 }); // capacity is read only on creation
    expect(joined(c, "s2")).toMatchObject({ member: 2, epoch: 3, capacity: 3, present: [0, 1] });
    expect(json(c, "s0")).toEqual([{ t: "peer_joined", member: 2, epoch: 3 }]);
    expect(json(c, "s1")).toEqual([{ t: "peer_joined", member: 2, epoch: 3 }]);
  });

  it("REQ-ROOM-4 seals after capacity joins, left slots included", () => {
    const g = group(3, 3);
    expect(closes(g.join("s3", { v: 2, token: null }))).toEqual([["s3", 4001]]);
    g.room.text("s1", JSON.stringify({ t: "leave" }));
    expect(closes(g.join("s4", { v: 2, token: null }))).toEqual([["s4", 4001]]);
  });

  it("only the starter creates a room: a tokenless join without capacity to no room is closed 4003", () => {
    const h = harness();
    expect(closes(h.join("s0", { v: 2, token: null }))).toEqual([["s0", 4003]]);
    expect(h.room.state).toBeNull();
    expect(closes(h.join("s1", { v: 2, token: "x".repeat(43) }))).toEqual([["s1", 4002]]);
  });

  it("refuses a join whose version doesn't match the room's mode with 4004, and bad capacities with 4005", () => {
    const g = group(3, 1);
    expect(closes(g.join("p", { v: 1, token: null }))).toEqual([["p", 4004]]);
    const pair = harness();
    pair.join("a", { v: 1, token: null });
    expect(closes(pair.join("g", { v: 2, token: null, capacity: 3 }))).toEqual([["g", 4004]]);
    for (const capacity of [2, 9, 3.5, "3"]) expect(closes(harness().join("x", { v: 2, token: null, capacity }))).toEqual([["x", 4005]]);
    expect(closes(harness().join("x", { v: 1, token: null, capacity: 3 }))).toEqual([["x", 4005]]);
    expect(closes(harness().join("x", { v: 3, token: null }))).toEqual([["x", 4004]]);
  });

  it("routes to || frame to the addressed member as from || frame", () => {
    const g = group(3, 3);
    const out = g.room.binary("s0", msgTo(2, 7));
    expect(binary(out, "s2")).toEqual([msgTo(0, 7)]);
    expect(binary(out, "s1")).toEqual([]);
    const back = g.room.binary("s2", helloTo(1));
    expect(binary(back, "s1")).toEqual([helloTo(2)]);
  });

  it("drops frames to self, to free slots, out of range or too short", () => {
    const g = group(4, 3);
    for (const frame of [msgTo(0), msgTo(3), msgTo(4), msgTo(255), Uint8Array.of(1)]) {
      const out = g.room.binary("s0", frame);
      expect(out.effects).toEqual([]);
    }
  });

  it("REQ-MSG-5 buffers MSGs per offline recipient, never HELLOs, and flushes on rejoin with the sender's address", () => {
    const g = group(3, 3);
    g.room.disconnect("s2");
    expect(g.room.binary("s0", helloTo(2)).effects).toEqual([]);
    g.room.binary("s0", msgTo(2, 1));
    g.room.binary("s1", msgTo(2, 2));
    const back = g.join("s2b", { v: 2, token: g.tokens[2] });
    expect(joined(back, "s2b")).toMatchObject({ member: 2, buffered: 2, present: [0, 1] });
    expect(binary(back, "s2b")).toEqual([msgTo(0, 1), msgTo(1, 2)]);
  });

  it("joined lists every taken slot, including members offline now", () => {
    const g = group(4, 3);
    g.room.disconnect("s1");
    const back = g.join("s0b", { v: 2, token: g.tokens[0] });
    expect(joined(back, "s0b")).toMatchObject({ member: 0, taken: [1, 2], present: [2] });
  });

  it("caps a group member's offline buffer at 2 MiB / capacity", () => {
    const g = group(4, 2);
    g.room.disconnect("s1");
    const size = 32 * 1024;
    const fits = Math.floor(GROUP_LIMITS.roomBufferBytes / 4 / size);
    for (let i = 0; i < fits; i++) {
      g.advance(2000);
      expect(json(g.room.binary("s0", msgTo(1, i, size)), "s0")).toEqual([]);
    }
    g.advance(2000);
    expect(json(g.room.binary("s0", msgTo(1, 99, size)), "s0")).toEqual([{ t: "error", code: "buffer_full" }]);
  });

  it("scales the rate limit with capacity − 1", () => {
    const g = group(3, 3);
    const burst = RELAY_LIMITS.binaryFrameBurst * 2;
    for (let i = 0; i < burst; i++) expect(json(g.room.binary("s0", msgTo(1 + (i % 2), i)), "s0")).toEqual([]);
    expect(json(g.room.binary("s0", msgTo(1)), "s0")[0]).toMatchObject({ t: "error", code: "rate_limited" });
  });

  it("REQ-ROOM-11 leave retires only the leaver; the room ends when every taken slot is retired", () => {
    const g = group(3, 3);
    const out = g.room.text("s1", JSON.stringify({ t: "leave" }));
    expect(json(out, "s0")).toEqual([{ t: "peer_left", member: 1, reason: "left" }]);
    expect(json(out, "s2")).toEqual([{ t: "peer_left", member: 1, reason: "left" }]);
    expect(closes(out)).toEqual([["s1", 4003]]);
    expect(g.room.state?.ended).toBeNull();
    expect(g.room.binary("s0", msgTo(1)).effects).toEqual([]); // to a retired slot
    expect(binary(g.room.binary("s0", msgTo(2)), "s2")).toEqual([msgTo(0)]);
    expect(closes(g.join("again", { v: 2, token: g.tokens[1] }))).toEqual([["again", 4002]]);
    g.room.disconnect("s2");
    expect(closes(g.room.text("s0", JSON.stringify({ t: "leave" })))).toEqual([["s0", 4003]]);
    expect(g.room.state?.ended).toBeNull(); // member 2 hasn't left
    const last = g.join("s2c", { v: 2, token: g.tokens[2] });
    expect(joined(last, "s2c")).toMatchObject({ member: 2, taken: [], present: [] });
    expect(closes(g.room.text("s2c", JSON.stringify({ t: "leave" })))).toEqual([["s2c", 4003]]);
    expect(g.room.state?.ended).toMatchObject({ reason: "left" });
    expect(closes(g.join("late", { v: 2, token: g.tokens[2] }))).toEqual([["late", 4003]]);
  });

  it("tells the others when a member's socket closes, with its index", () => {
    const g = group(3, 3);
    const out = g.room.disconnect("s0");
    expect(json(out, "s1")).toEqual([{ t: "peer_left", member: 0, reason: "disconnected" }]);
    expect(json(out, "s2")).toEqual([{ t: "peer_left", member: 0, reason: "disconnected" }]);
  });

  it("a rejoin replaces the older socket of the same member (4007)", () => {
    const g = group(3, 2);
    const out = g.join("s1b", { v: 2, token: g.tokens[1] });
    expect(closes(out)).toEqual([["s1", 4007]]);
    expect(json(out, "s0")).toEqual([{ t: "peer_joined", member: 1, epoch: 3 }]);
  });

  it("idle expiry ends a group room with nobody connected", () => {
    const g = group(3, 2);
    g.room.disconnect("s0");
    g.room.disconnect("s1");
    g.advance(RELAY_LIMITS.idleExpiryMs);
    g.room.alarm();
    expect(g.room.state?.ended).toMatchObject({ reason: "expired" });
    expect(closes(g.join("x", { v: 2, token: g.tokens[0] }))).toEqual([["x", 4003]]);
  });

  it("encodes and decodes a group room's state; a pair room's encoding has no group fields", () => {
    const g = group(4, 3);
    g.room.disconnect("s2");
    g.room.binary("s0", msgTo(2, 5));
    g.room.text("s1", JSON.stringify({ t: "leave" }));
    const text = encodeRoomState(g.room.state!);
    expect(decodeRoomState(text)).toEqual(g.room.state);
    const rebuilt = new RelayRoom({ now: () => T0 + H, state: decodeRoomState(text), sockets: { s0: { member: 0 } } });
    const back = rebuilt.connect("s2b");
    expect(back.effects).toEqual([]);
    const flushed = rebuilt.text("s2b", JSON.stringify({ t: "join", v: 2, token: g.tokens[2] }));
    expect(binary(flushed, "s2b")).toEqual([msgTo(0, 5)]);
    expect(joined(flushed, "s2b")).toMatchObject({ present: [0] });

    const pair = harness();
    pair.join("a", { v: 1, token: null });
    expect(Object.keys(JSON.parse(encodeRoomState(pair.room.state!)) as object).sort()).toEqual(["createdAt", "ended", "epoch", "lastActivityAt", "slots"]);
  });

  it("reports protocol 2 and the group limits at /v1/info", () => {
    expect(relayInfo("0.4.0")).toEqual({ protocol: [1, 2], relay: "0.4.0", limits: RELAY_LIMITS, group_limits: GROUP_LIMITS });
    expect(GROUP_LIMITS).toEqual({ minCapacity: 3, maxCapacity: 8, roomBufferBytes: 2 * 1024 * 1024 });
  });
});

describe("group relay frames (02 §8.2)", () => {
  const ok = (frame: object) => parseGroupRelayFrame(JSON.stringify(frame));
  const joinedFrame = { t: "joined", member: 2, token: "A".repeat(43), epoch: 9, capacity: 4, taken: [0, 1, 3], present: [0, 1], buffered: 0, expires_at: 1 };

  it("accepts the §8.2 frames", () => {
    expect(ok(joinedFrame)).toMatchObject({ ok: true, frame: joinedFrame });
    expect(ok({ t: "peer_joined", member: 1, epoch: 10 })).toMatchObject({ ok: true });
    expect(ok({ t: "peer_left", member: 1, reason: "left" })).toMatchObject({ ok: true });
    expect(ok({ t: "pong" })).toMatchObject({ ok: true });
    expect(ok({ t: "error", code: "rate_limited", retry_after: 3 })).toMatchObject({ ok: true });
    expect(ok({ t: "something_new" })).toEqual({ ok: false, reason: "unknown_type" });
  });

  it("refuses out-of-bounds members, capacities and present lists", () => {
    for (const bad of [
      { ...joinedFrame, member: 4 },
      { ...joinedFrame, member: -1 },
      { ...joinedFrame, capacity: 2 },
      { ...joinedFrame, capacity: 9 },
      { ...joinedFrame, present: [0, 2] },
      { ...joinedFrame, present: [1, 0] },
      { ...joinedFrame, present: [0, 0] },
      { ...joinedFrame, present: [0, 4] },
      { ...joinedFrame, present: [0, 1, 3, 3] },
      { ...joinedFrame, taken: [0, 1], present: [0, 3] },
      { ...joinedFrame, taken: [0, 2] },
      { ...joinedFrame, member: "a" },
    ]) {
      expect(ok(bad)).toMatchObject({ ok: false, reason: "invalid", t: "joined" });
    }
    expect(ok({ t: "peer_joined", member: 8, epoch: 1 })).toMatchObject({ ok: false, reason: "invalid" });
    expect(ok({ t: "peer_left", member: 1 })).toMatchObject({ ok: false, reason: "invalid" });
  });
});

describe("v2 HELLO (02 §8.4)", () => {
  const keys = deriveRoomKeys(generateSecret());
  const payload: HelloPayload = { v: 1, name: "Ana", harness: "codex", client: "pairwire/0.4.0", instance: "a".repeat(26), caps: ["ack"] };

  it("opens only with the from and to it was sealed for", () => {
    const ePub = new Uint8Array(32).fill(9);
    const frame = sealHello({ keys, epoch: 4, ePub, payload, pair: { from: 1, to: 2 } });
    expect(openHello(frame, keys, { from: 1, to: 2 })).toMatchObject({ ok: true, epoch: 4 });
    expect(openHello(frame, keys, { from: 0, to: 2 })).toEqual({ ok: false, reason: "decrypt_failed" });
    expect(openHello(frame, keys, { from: 1, to: 0 })).toEqual({ ok: false, reason: "decrypt_failed" });
    expect(openHello(frame, keys)).toEqual({ ok: false, reason: "decrypt_failed" });
    expect(openHello(sealHello({ keys, epoch: 4, ePub, payload }), keys, { from: 1, to: 2 })).toEqual({ ok: false, reason: "decrypt_failed" });
  });

  it("two members' pair handshakes agree on one session", () => {
    const a = new Handshake({ keys, payload, pair: { me: 0, peer: 2 } });
    const c = new Handshake({ keys, payload: { ...payload, name: "Cy" }, pair: { me: 2, peer: 0 } });
    const fromA = a.startEpoch(3)!;
    const fromC = c.startEpoch(3)!;
    const atC = c.receive(fromA);
    const atA = a.receive(fromC);
    if (atC.type !== "session" || atA.type !== "session") throw new Error("no session");
    expect(atC.session.sid).toEqual(atA.session.sid);
    expect(atC.session.sendKey).toEqual(atA.session.recvKey);
    // A HELLO A sealed for C is no use to a third member.
    const b = new Handshake({ keys, payload, pair: { me: 1, peer: 0 } });
    b.startEpoch(5);
    const a2 = new Handshake({ keys, payload, pair: { me: 0, peer: 2 } });
    expect(b.receive(a2.startEpoch(5)!)).toMatchObject({ type: "dropped", reason: "decrypt_failed" });
  });
});

describe("pw2 share strings (02 §8.1)", () => {
  it("REQ-ROOM-9 encodes and parses group rooms, with the same key schedule", () => {
    const secret = generateSecret();
    const pw2 = encodeShareString(secret, { host: "relay.example.com" }, { group: true });
    expect(pw2).toMatch(/^pw2_[a-z2-7]{52}@relay\.example\.com$/);
    expect(parseShareString(pw2)).toEqual({ secret, relay: { host: "relay.example.com" }, group: true });
    expect(parseShareString(encodeShareString(secret))).toEqual({ secret, relay: null, group: false });
    expect(() => parseShareString("pw3_" + "a".repeat(52))).toThrow(/protocol version this client doesn't support/);
  });
});
