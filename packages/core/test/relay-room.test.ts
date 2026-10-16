import { describe, expect, it } from "vitest";
import { CLIENT_LIMITS, RELAY_LIMITS, relayInfo } from "../src/limits.js";
import { RelayRoom, decodeRoomState, encodeRoomState, type Effect, type Output, type RoomState } from "../src/relay-room.js";

const T0 = Date.UTC(2026, 9, 15, 12, 0, 0);
const S = 1000;
const H = 3600 * S;
const D = 24 * H;

function harness() {
  let now = T0;
  let counter = 0;
  const room = new RelayRoom({
    now: () => now,
    random: (n) => Uint8Array.from({ length: n }, (_, i) => (counter++ * 31 + i) & 0xff),
  });
  return {
    room,
    advance: (ms: number) => (now += ms),
    now: () => now,
    join: (socket: string, token: string | null = null) => {
      room.connect(socket);
      return room.text(socket, JSON.stringify({ t: "join", v: 1, token }));
    },
  };
}

const sent = (out: Output, socket: string) =>
  out.effects.filter((e): e is Extract<Effect, { type: "send" }> => e.type === "send" && e.socket === socket).map((e) => e.data);
const json = (out: Output, socket: string) =>
  sent(out, socket)
    .filter((d): d is string => typeof d === "string")
    .map((d) => JSON.parse(d) as Record<string, unknown>);
const closes = (out: Output) =>
  out.effects.filter((e): e is Extract<Effect, { type: "close" }> => e.type === "close").map((e) => [e.socket, e.code]);
const tokenOf = (out: Output, socket: string) => json(out, socket).find((f) => f.t === "joined")!.token as string;
const msg = (n: number, size = 40) => Uint8Array.from({ length: size }, (_, i) => (i === 0 ? 0x02 : (n + i) & 0xff));
const hello = () => Uint8Array.from({ length: 100 }, (_, i) => (i === 0 ? 0x01 : i));

describe("limits (03, Limits)", () => {
  it("match the 03 table", () => {
    expect(RELAY_LIMITS).toEqual({
      membersPerRoom: 2,
      joinDeadlineMs: 10 * S,
      maxBinaryFrameBytes: 64 * 1024,
      maxControlFrameBytes: 1024,
      binaryFramesPerMinute: 60,
      binaryFrameBurst: 20,
      offlineBufferFrames: 100,
      offlineBufferBytes: 1024 * 1024,
      bufferedFrameLifetimeMs: 72 * H,
      idleExpiryMs: 72 * H,
      maxAgeMs: 7 * D,
    });
  });

  it("keep the client below the relay (03: a well-behaved client never hits the relay's limits)", () => {
    expect(CLIENT_LIMITS.maxFrameBytes).toBeLessThan(RELAY_LIMITS.maxBinaryFrameBytes);
    expect((CLIENT_LIMITS.binaryFramesPer10s * 60) / 10).toBeLessThan(RELAY_LIMITS.binaryFramesPerMinute);
    expect(CLIENT_LIMITS.binaryFramesPer10s).toBeLessThan(RELAY_LIMITS.binaryFrameBurst);
    expect(CLIENT_LIMITS.sendsPerMinute).toBeLessThan(RELAY_LIMITS.binaryFramesPerMinute);
  });

  it("are reported by GET /v1/info", () => {
    expect(relayInfo("0.1.0")).toEqual({ protocol: [1], relay: "0.1.0", limits: RELAY_LIMITS });
  });
});

describe("membership (02 §5)", () => {
  it("gives the first token-less join slot a, a 32-byte token and the room's expires_at", () => {
    const h = harness();
    const out = h.join("s1");
    const [joined] = json(out, "s1");
    expect(joined).toEqual({
      t: "joined",
      member: "a",
      token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      epoch: 1,
      peer_present: false,
      buffered: 0,
      expires_at: T0 + 7 * D,
    });
    expect(out.persist).toBe(true);
  });

  it("gives the second join slot b and tells a, in that order", () => {
    const h = harness();
    h.join("s1");
    const out = h.join("s2");
    expect(json(out, "s2")).toEqual([expect.objectContaining({ t: "joined", member: "b", epoch: 2, peer_present: true })]);
    expect(json(out, "s1")).toEqual([{ t: "peer_joined", epoch: 2 }]);
    const order = out.effects.map((e) => (e.type === "send" ? e.socket : e.type));
    expect(order.indexOf("s2")).toBeLessThan(order.indexOf("s1"));
  });

  it("REQ-ROOM-4 refuses a third token-less join with 4001 (the room is sealed)", () => {
    const h = harness();
    h.join("s1");
    h.join("s2");
    const out = h.join("s3");
    expect(closes(out)).toEqual([["s3", 4001]]);
    expect(json(out, "s3")).toEqual([]);
  });

  it("REQ-ROOM-4 keeps the room sealed after a member disconnects", () => {
    const h = harness();
    h.join("s1");
    h.join("s2");
    h.room.disconnect("s2");
    expect(closes(h.join("s3"))).toEqual([["s3", 4001]]);
  });

  it("lets a member rejoin its slot with its token, with a new epoch, and tells the peer", () => {
    const h = harness();
    const a = tokenOf(h.join("s1"), "s1");
    h.join("s2");
    const left = h.room.disconnect("s1");
    expect(json(left, "s2")).toEqual([{ t: "peer_left", reason: "disconnected" }]);
    const back = h.join("s1b", a);
    expect(json(back, "s1b")).toEqual([expect.objectContaining({ t: "joined", member: "a", token: a, epoch: 3, peer_present: true })]);
    expect(json(back, "s2")).toEqual([{ t: "peer_joined", epoch: 3 }]);
  });

  it("closes the older socket with 4007 when the same token rejoins, without a peer_left", () => {
    const h = harness();
    const a = tokenOf(h.join("s1"), "s1");
    h.join("s2");
    const out = h.join("s1b", a);
    expect(closes(out)).toEqual([["s1", 4007]]);
    expect(json(out, "s2")).toEqual([{ t: "peer_joined", epoch: 3 }]);
    expect(h.room.disconnect("s1").effects).toEqual([]);
  });

  it("closes a join with an unknown token with 4002, even when a slot is free", () => {
    const h = harness();
    h.join("s1");
    expect(closes(h.join("s2", "A".repeat(43)))).toEqual([["s2", 4002]]);
    expect(closes(h.join("s3", "not-a-token"))).toEqual([["s3", 4002]]);
    expect(json(h.join("s4"), "s4")[0]).toMatchObject({ t: "joined", member: "b" });
  });

  it("ends the room on leave for both members and tombstones it", () => {
    const h = harness();
    const a = tokenOf(h.join("s1"), "s1");
    const b = tokenOf(h.join("s2"), "s2");
    const out = h.room.text("s1", '{"t":"leave"}');
    expect(json(out, "s2")).toEqual([{ t: "peer_left", reason: "left" }]);
    expect(closes(out).sort()).toEqual([
      ["s1", 4003],
      ["s2", 4003],
    ]);
    expect(h.room.state?.ended).toEqual({ at: T0, reason: "left" });
    expect(h.room.state?.slots).toEqual({});
    for (const [socket, token] of [["s3", a], ["s4", b], ["s5", null]] as const) {
      const late = h.join(socket, token);
      expect(json(late, socket)).toEqual([{ t: "peer_left", reason: "left" }]);
      expect(closes(late)).toEqual([[socket, 4003]]);
    }
  });

  it("tells a member who was offline during leave that the room ended when it returns", () => {
    const h = harness();
    h.join("s1");
    const b = tokenOf(h.join("s2"), "s2");
    h.room.disconnect("s2");
    const out = h.room.text("s1", '{"t":"leave"}');
    expect(closes(out)).toEqual([["s1", 4003]]);
    const back = h.join("s2b", b);
    expect(json(back, "s2b")).toEqual([{ t: "peer_left", reason: "left" }]);
    expect(closes(back)).toEqual([["s2b", 4003]]);
  });
});

describe("protocol errors before and after join (02 §5)", () => {
  const firstFrames: [string, string][] = [
    ["leave", '{"t":"leave"}'],
    ["garbage", "not json"],
    ["unknown type", '{"t":"hello"}'],
    ["join without token field", '{"t":"join","v":1}'],
    ["join with extra field", '{"t":"join","v":1,"token":null,"admin":true}'],
  ];
  for (const [name, frame] of firstFrames) {
    it(`closes with 4005 when the first frame is ${name}`, () => {
      const h = harness();
      h.room.connect("s1");
      expect(closes(h.room.text("s1", frame))).toEqual([["s1", 4005]]);
    });
  }

  it("closes with 4005 when binary data arrives before join", () => {
    const h = harness();
    h.room.connect("s1");
    expect(closes(h.room.binary("s1", msg(1)))).toEqual([["s1", 4005]]);
  });

  it("closes with 4004 for an unsupported protocol version", () => {
    const h = harness();
    h.room.connect("s1");
    expect(closes(h.room.text("s1", '{"t":"join","v":2,"token":null}'))).toEqual([["s1", 4004]]);
  });

  it("closes with 4005 for a control frame over 1 KiB, measured in UTF-8 bytes", () => {
    const h = harness();
    h.join("s1");
    const big = JSON.stringify({ t: "leave", pad: "ж".repeat(520) });
    expect(closes(h.room.text("s1", big))).toEqual([["s1", 4005]]);
  });

  it("closes with 4005 for a second join on a joined socket", () => {
    const h = harness();
    h.join("s1");
    expect(closes(h.room.text("s1", '{"t":"join","v":1,"token":null}'))).toEqual([["s1", 4005]]);
  });

  it("answers ping with pong at any time, including before join, without other effects", () => {
    const h = harness();
    h.room.connect("s1");
    const out = h.room.text("s1", '{"t":"ping"}');
    expect(out.effects).toEqual([{ type: "send", socket: "s1", data: '{"t":"pong"}' }]);
    expect(out.persist).toBe(false);
    expect(json(h.room.text("s1", '{"t":"join","v":1,"token":null}'), "s1")[0]).toMatchObject({ t: "joined" });
  });

  it("closes a socket that hasn't joined within 10 s with 4006", () => {
    const h = harness();
    const out = h.room.connect("s1");
    expect(out.alarmAt).toBe(T0 + 10 * S);
    h.advance(10 * S - 1);
    expect(closes(h.room.alarm())).toEqual([]);
    h.advance(1);
    expect(closes(h.room.alarm())).toEqual([["s1", 4006]]);
  });

  it("ignores frames and disconnects from sockets it doesn't know", () => {
    const h = harness();
    expect(h.room.binary("ghost", msg(1)).effects).toEqual([]);
    expect(h.room.text("ghost", '{"t":"leave"}').effects).toEqual([]);
    expect(h.room.disconnect("ghost").effects).toEqual([]);
  });
});

describe("forwarding and buffering (02 §5, 03)", () => {
  it("forwards binary frames to the connected peer unchanged", () => {
    const h = harness();
    h.join("s1");
    h.join("s2");
    const frame = msg(7);
    const out = h.room.binary("s1", frame);
    expect(sent(out, "s2")).toEqual([frame]);
    expect(sent(out, "s1")).toEqual([]);
  });

  it("REQ-MSG-5 buffers frames for an offline member and delivers them in order on rejoin", () => {
    const h = harness();
    h.join("s1");
    const b = tokenOf(h.join("s2"), "s2");
    h.room.disconnect("s2");
    const frames = [msg(1), msg(2), msg(3)];
    for (const f of frames) expect(h.room.binary("s1", f).effects).toEqual([]);
    const back = h.join("s2b", b);
    const toB = sent(back, "s2b");
    expect(JSON.parse(toB[0] as string)).toMatchObject({ t: "joined", buffered: 3 });
    expect(toB.slice(1)).toEqual(frames);
    // joined, then the buffered frames, then peer_joined to the other member
    const order = back.effects.map((e) => (e.type === "send" ? e.socket : e.type));
    expect(order).toEqual(["s2b", "s2b", "s2b", "s2b", "s1"]);
    expect(h.room.state?.slots.b?.buffer).toEqual([]);
  });

  it("drops frames while the other slot has never been taken", () => {
    const h = harness();
    h.join("s1");
    expect(h.room.binary("s1", msg(1)).effects).toEqual([]);
    const out = h.join("s2");
    expect(json(out, "s2")[0]).toMatchObject({ buffered: 0 });
    expect(sent(out, "s2")).toHaveLength(1);
  });

  it("never buffers a HELLO: it is forwarded if the peer is connected and dropped otherwise", () => {
    const h = harness();
    h.join("s1");
    expect(h.room.binary("s1", hello()).effects).toEqual([]);
    const out = h.join("s2");
    expect(json(out, "s2")[0]).toMatchObject({ buffered: 0 });
    expect(sent(out, "s2")).toHaveLength(1);
    expect(sent(h.room.binary("s1", hello()), "s2")).toEqual([hello()]);
  });

  it("drops a binary frame over 64 KiB with error too_large and accepts exactly 64 KiB", () => {
    const h = harness();
    h.join("s1");
    h.join("s2");
    const over = h.room.binary("s1", msg(1, 64 * 1024 + 1));
    expect(json(over, "s1")).toEqual([{ t: "error", code: "too_large" }]);
    expect(sent(over, "s2")).toEqual([]);
    expect(sent(h.room.binary("s1", msg(1, 64 * 1024)), "s2")).toHaveLength(1);
  });

  it("rate-limits binary frames per member: burst 20, then 1 per second", () => {
    const h = harness();
    h.join("s1");
    h.join("s2");
    for (let i = 0; i < 20; i++) expect(sent(h.room.binary("s1", i % 2 ? hello() : msg(i)), "s2")).toHaveLength(1);
    const limited = h.room.binary("s1", msg(21));
    expect(json(limited, "s1")).toEqual([{ t: "error", code: "rate_limited", retry_after: 1 }]);
    expect(sent(limited, "s2")).toEqual([]);
    // the other member has its own bucket
    expect(sent(h.room.binary("s2", msg(1)), "s1")).toHaveLength(1);
    h.advance(1 * S);
    expect(sent(h.room.binary("s1", msg(22)), "s2")).toHaveLength(1);
    expect(json(h.room.binary("s1", msg(23)), "s1")[0]).toMatchObject({ code: "rate_limited" });
  });

  it("does not count pings or control frames against the rate limit", () => {
    const h = harness();
    h.join("s1");
    h.join("s2");
    for (let i = 0; i < 50; i++) h.room.text("s1", '{"t":"ping"}');
    expect(sent(h.room.binary("s1", msg(1)), "s2")).toHaveLength(1);
  });

  it("refuses the 101st buffered frame with buffer_full", () => {
    const h = harness();
    h.join("s1");
    h.join("s2");
    h.room.disconnect("s2");
    for (let i = 0; i < 100; i++) {
      h.advance(1 * S);
      expect(h.room.binary("s1", msg(i)).effects, `frame ${i}`).toEqual([]);
    }
    h.advance(1 * S);
    expect(json(h.room.binary("s1", msg(100)), "s1")).toEqual([{ t: "error", code: "buffer_full" }]);
  });

  it("refuses a frame that would push the buffer past 1 MiB with buffer_full", () => {
    const h = harness();
    h.join("s1");
    h.join("s2");
    h.room.disconnect("s2");
    for (let i = 0; i < 16; i++) {
      h.advance(1 * S);
      expect(h.room.binary("s1", msg(i, 64 * 1024)).effects).toEqual([]);
    }
    h.advance(1 * S);
    expect(json(h.room.binary("s1", msg(16, 1)), "s1")).toEqual([{ t: "error", code: "buffer_full" }]);
  });

  it("discards buffered frames older than 72 h", () => {
    const h = harness();
    h.join("s1");
    const b = tokenOf(h.join("s2"), "s2");
    h.room.disconnect("s2");
    h.room.binary("s1", msg(1));
    h.advance(1 * H);
    h.room.binary("s1", msg(2));
    h.advance(71 * H);
    h.room.alarm();
    expect(h.room.state?.slots.b?.buffer).toHaveLength(1);
    const back = h.join("s2b", b);
    expect(json(back, "s2b")[0]).toMatchObject({ buffered: 1 });
    expect(sent(back, "s2b").slice(1)).toEqual([msg(2)]);
  });
});

describe("REQ-ROOM-7 expiry and max age (03)", () => {
  it("REQ-ROOM-7 ends a room with no connected member and no frame for 72 h", () => {
    const h = harness();
    const a = tokenOf(h.join("s1"), "s1");
    h.join("s2");
    h.room.disconnect("s1");
    const last = h.room.disconnect("s2");
    expect(last.alarmAt).toBe(T0 + 72 * H);
    h.advance(72 * H - 1);
    expect(h.room.alarm().persist).toBe(false);
    expect(h.room.state?.ended).toBeNull();
    h.advance(1);
    expect(h.room.alarm().persist).toBe(true);
    expect(h.room.state?.ended).toEqual({ at: T0 + 72 * H, reason: "expired" });
    const late = h.join("s3", a);
    expect(json(late, "s3")).toEqual([]);
    expect(closes(late)).toEqual([["s3", 4003]]);
  });

  it("REQ-ROOM-7 counts an open socket as activity, so a connected room never idles out", () => {
    const h = harness();
    h.join("s1");
    h.advance(6 * D);
    h.room.alarm();
    expect(h.room.state?.ended).toBeNull();
  });

  it("REQ-ROOM-7 closes everything with 4003 at 7 days and deletes all storage", () => {
    const h = harness();
    const a = tokenOf(h.join("s1"), "s1");
    expect(h.join("s2").alarmAt).toBe(T0 + 7 * D);
    h.advance(7 * D);
    const out = h.room.alarm();
    expect(closes(out).sort()).toEqual([
      ["s1", 4003],
      ["s2", 4003],
    ]);
    expect(out.deleteAll).toBe(true);
    expect(h.room.state).toBeNull();
    expect(closes(h.join("s3", a))).toEqual([["s3", 4002]]);
    const fresh = h.join("s4");
    expect(json(fresh, "s4")[0]).toMatchObject({ t: "joined", member: "a", epoch: 1, expires_at: h.now() + 7 * D });
  });

  it("keeps a tombstone until max age, then deletes it", () => {
    const h = harness();
    h.join("s1");
    h.room.text("s1", '{"t":"leave"}');
    const before = h.room.alarm();
    expect(before.alarmAt).toBe(T0 + 7 * D);
    h.advance(7 * D);
    expect(h.room.alarm().deleteAll).toBe(true);
    expect(h.room.state).toBeNull();
  });
});

describe("persisted state", () => {
  it("restores from persisted state with its sockets reattached (hibernation)", () => {
    const h = harness();
    const a = tokenOf(h.join("s1"), "s1");
    h.join("s2");
    h.room.disconnect("s2");
    h.room.binary("s1", msg(9));
    const saved: RoomState = structuredClone(h.room.state!);
    const restored = new RelayRoom({ now: h.now, state: saved, sockets: { s1: "a" } });
    expect(sent(restored.binary("s1", msg(10)), "s1")).toEqual([]);
    expect(restored.state?.slots.b?.buffer).toHaveLength(2);
    expect(restored.state?.slots.a?.token).toBe(a);
    const back = restored.connect("s2b");
    expect(back.effects).toEqual([]);
  });
});

describe("RoomState codec (03, Room state machine)", () => {
  function liveState(): RoomState {
    const h = harness();
    h.join("s1");
    h.join("s2");
    h.room.disconnect("s2");
    h.room.binary("s1", msg(1));
    h.advance(5 * S);
    h.room.binary("s1", Uint8Array.from({ length: 300 }, (_, i) => (i * 13) & 0xff));
    return h.room.state!;
  }

  it("round-trips a state with tokens, epoch and buffered frames", () => {
    const state = liveState();
    expect(state.slots.b!.buffer).toHaveLength(2);
    const text = encodeRoomState(state);
    expect(typeof text).toBe("string");
    const back = decodeRoomState(text);
    expect(back).toEqual(state);
    expect(back.slots.b!.buffer[1]!.bytes).toBeInstanceOf(Uint8Array);
    expect(back.slots.b!.buffer[1]!.bytes).toEqual(state.slots.b!.buffer[1]!.bytes);
  });

  it("round-trips a tombstone and an empty buffer", () => {
    const tomb: RoomState = { createdAt: T0, lastActivityAt: T0 + S, epoch: 3, ended: { at: T0 + H, reason: "left" }, slots: {} };
    expect(decodeRoomState(encodeRoomState(tomb))).toEqual(tomb);
    const empty = new Uint8Array(0);
    const one: RoomState = { ...tomb, ended: null, slots: { a: { token: "x".repeat(43), connected: true, buffer: [{ at: T0, bytes: empty }] } } };
    expect(decodeRoomState(encodeRoomState(one))).toEqual(one);
  });

  it("stores frame bytes as base64url text, so the encoding never holds raw binary", () => {
    const state = liveState();
    const parsed = JSON.parse(encodeRoomState(state)) as { slots: { b: { buffer: { bytes: unknown }[] } } };
    for (const f of parsed.slots.b.buffer) expect(f.bytes).toMatch(/^[A-Za-z0-9_-]*$/);
    expect(parsed.slots.b.buffer[0]!.bytes).toBe(Buffer.from(state.slots.b!.buffer[0]!.bytes).toString("base64url"));
  });

  it("decodes into a state a RelayRoom keeps using", () => {
    const state = liveState();
    const room = new RelayRoom({ now: () => T0 + 10 * S, state: decodeRoomState(encodeRoomState(state)) });
    room.connect("s3");
    const out = room.text("s3", JSON.stringify({ t: "join", v: 1, token: state.slots.b!.token }));
    expect(json(out, "s3")[0]).toMatchObject({ t: "joined", member: "b", epoch: state.epoch + 1, buffered: 2 });
    expect(sent(out, "s3").filter((d) => typeof d !== "string")).toEqual(state.slots.b!.buffer.map((f) => f.bytes));
  });

  it("rejects malformed input", () => {
    const good = JSON.parse(encodeRoomState(liveState())) as Record<string, unknown>;
    const bad: string[] = [
      "",
      "not json",
      "null",
      "[]",
      JSON.stringify({ ...good, epoch: "1" }),
      JSON.stringify({ ...good, extra: 1 }),
      JSON.stringify({ ...good, ended: { at: 1, reason: "bored" } }),
      JSON.stringify({ ...good, slots: { c: (good.slots as Record<string, unknown>).a } }),
      JSON.stringify({ ...good, slots: { a: { token: "t", connected: false, buffer: [{ at: 1, bytes: "not base64!" }] } } }),
      JSON.stringify({ ...good, slots: { a: { token: "t", connected: false, buffer: [{ at: 1, bytes: "A" }] } } }),
      JSON.stringify({ ...good, slots: { a: { token: "t", connected: false } } }),
    ];
    for (const text of bad) expect(() => decodeRoomState(text), text).toThrow();
  });
});

describe("token encoding", () => {
  it("base64url matches Node's encoder for every length up to 40 bytes", async () => {
    const { base64url } = await import("../src/relay-room.js");
    for (let n = 0; n <= 40; n++) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 73 + n * 11) & 0xff);
      expect(base64url(bytes)).toBe(Buffer.from(bytes).toString("base64url"));
    }
  });

  it("base64urlDecode inverts base64url for every length up to 40 bytes and rejects bad input", async () => {
    const { base64url, base64urlDecode } = await import("../src/relay-room.js");
    for (let n = 0; n <= 40; n++) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 73 + n * 11) & 0xff);
      expect(base64urlDecode(base64url(bytes))).toEqual(bytes);
    }
    for (const bad of ["A", "AAAAA", "AA==", "A+B/", "AA AA", "\u00e9A"]) expect(() => base64urlDecode(bad), bad).toThrow();
    // Non-canonical: the unused low bits of the last character must be zero.
    expect(() => base64urlDecode("AB")).toThrow();
    expect(base64urlDecode("AA")).toEqual(Uint8Array.of(0));
  });
});

describe("memberOf", () => {
  it("reports the slot a socket joined as, null before join and undefined once gone", () => {
    const h = harness();
    h.room.connect("s1");
    expect(h.room.memberOf("s1")).toBeNull();
    h.room.text("s1", '{"t":"join","v":1,"token":null}');
    expect(h.room.memberOf("s1")).toBe("a");
    h.room.disconnect("s1");
    expect(h.room.memberOf("s1")).toBeUndefined();
  });
});
