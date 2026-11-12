// Relay room state machine (03, Room state machine; 02 §5, §8). Pure logic: the host (Durable
// Object or Node) feeds it socket events and applies the returned effects. A pair room has
// slots "a" and "b"; a group room (02 §8, ADR-037) has slots 0..capacity-1.
import { randomBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { z } from "zod";
import { GROUP_LIMITS as G, RELAY_LIMITS as L } from "./limits.js";

/** "a"/"b" in a pair room, the slot index in a group room. */
export type Member = "a" | "b" | number;
export type SocketId = string;

export interface BufferedFrame {
  at: number;
  bytes: Uint8Array;
}

export interface Slot {
  /** base64url(32 random bytes), issued by the relay. */
  token: string;
  connected: boolean;
  /** Frames waiting for this member. */
  buffer: BufferedFrame[];
}

/** Persisted per room. A tombstone (`ended`) keeps no tokens and no buffers. */
export interface RoomState {
  /** The first accepted join creates the room. */
  createdAt: number;
  lastActivityAt: number;
  epoch: number;
  ended: null | { at: number; reason: "left" | "expired" };
  slots: { a?: Slot; b?: Slot };
  /** A group room (02 §8): its capacity, 3..8. Absent in a pair room. */
  capacity?: number;
  /** A group room's slots by index: null free, "left" retired. */
  members?: (Slot | "left" | null)[];
}

export type Effect =
  | { type: "send"; socket: SocketId; data: string | Uint8Array }
  | { type: "close"; socket: SocketId; code: number; reason: string };

export interface Output {
  /** In order: sends and closes to apply to sockets. */
  effects: Effect[];
  /** The host must save `room.state`. */
  persist: boolean;
  /** The host must delete all stored state for the room (max age reached). */
  deleteAll: boolean;
  /** When the host must call `alarm()` next, or null. */
  alarmAt: number | null;
}

export const CLOSE = {
  room_full: 4001,
  bad_token: 4002,
  ended: 4003,
  unsupported_version: 4004,
  protocol_error: 4005,
  join_timeout: 4006,
  replaced: 4007,
  overloaded: 4008,
} as const;
type CloseName = keyof typeof CLOSE;

const PONG = '{"t":"pong"}';
const HELLO_TYPE = 0x01;
const REFILL_PER_MS = L.binaryFramesPerMinute / 60_000;
const REPLY_REFILL_PER_MS = L.relayRepliesPerMinute / 60_000;

const controlSchema = z.discriminatedUnion("t", [
  z.strictObject({
    t: z.literal("join"),
    v: z.number(),
    token: z.string().nullable(),
    capacity: z.number().int().min(G.minCapacity).max(G.maxCapacity).optional(),
  }),
  z.strictObject({ t: z.literal("leave") }),
  z.strictObject({ t: z.literal("ping") }),
]);

interface Conn {
  member: Member | null;
  /** Join deadline for a socket that hasn't joined yet. */
  deadline: number | null;
  /** Reply limit (pong, error) for this socket; in memory only, like the rate limit. */
  replies: Bucket;
}

interface Bucket {
  tokens: number;
  at: number;
}

/** A socket a rebuilt room already has (03, Room state machine: host hooks). */
export interface KnownSocket {
  member: Member | null;
  /** When the socket connected (ms); without it, the join deadline counts from the rebuild. */
  connectedAt?: number;
}

export class RelayRoom {
  state: RoomState | null;
  readonly #now: () => number;
  readonly #random: (n: number) => Uint8Array;
  readonly #sockets = new Map<SocketId, Conn>();
  /** In memory only; resets on hibernation, which errs toward leniency (03). */
  readonly #buckets = new Map<Member, Bucket>();
  readonly #admitBuffered: (bytes: number) => boolean;
  #out: Output = emptyOutput();

  constructor(opts: {
    now: () => number;
    random?: (n: number) => Uint8Array;
    state?: RoomState | null;
    /** Sockets that survived hibernation, with their member (null: not joined yet) and connect time. */
    sockets?: Record<SocketId, KnownSocket>;
    /** Asked before a frame is buffered; false refuses it with buffer_full (relay-wide caps). */
    admitBuffered?: (bytes: number) => boolean;
  }) {
    this.#now = opts.now;
    this.#random = opts.random ?? randomBytes;
    this.#admitBuffered = opts.admitBuffered ?? (() => true);
    this.state = opts.state ?? null;
    const now = this.#now();
    for (const [socket, { member, connectedAt }] of Object.entries(opts.sockets ?? {})) {
      this.#sockets.set(socket, newConn(member, member ? null : (connectedAt ?? now) + L.joinDeadlineMs, now));
    }
    if (this.state) for (const [m, slot] of slotEntries(this.state)) slot.connected = this.#socketOf(m) !== undefined;
  }

  /** The member a socket has joined as: null if it hasn't joined yet, undefined if unknown. */
  memberOf(socket: SocketId): Member | null | undefined {
    return this.#sockets.get(socket)?.member;
  }

  /** Offline-buffered frame bytes in this room, for a host that caps the total. */
  bufferedBytes(): number {
    if (!this.state) return 0;
    let n = 0;
    for (const slot of slotsOf(this.state)) for (const f of slot.buffer) n += f.bytes.length;
    return n;
  }

  /** A new socket; `connectedAt` (default now) starts its join deadline. */
  connect(socket: SocketId, connectedAt?: number): Output {
    return this.#run(() => {
      const now = this.#now();
      const unjoined = [...this.#sockets].filter(([, c]) => c.member === null);
      // Close the oldest, so sockets parked here can't lock out one that joins now (03 Limits).
      if (unjoined.length >= L.unjoinedSocketsPerRoom) this.#close(unjoined[0]![0], "overloaded");
      this.#sockets.set(socket, newConn(null, (connectedAt ?? now) + L.joinDeadlineMs, now));
    });
  }

  text(socket: SocketId, data: string): Output {
    return this.#run(() => {
      const conn = this.#sockets.get(socket);
      if (!conn) return;
      if (utf8ToBytes(data).length > L.maxControlFrameBytes) return this.#close(socket, "protocol_error");
      let raw: unknown;
      try {
        raw = JSON.parse(data);
      } catch {
        return this.#close(socket, "protocol_error");
      }
      if (isObject(raw) && raw.t === "join" && typeof raw.v === "number" && raw.v !== 1 && raw.v !== 2) {
        return this.#close(socket, "unsupported_version");
      }
      const parsed = controlSchema.safeParse(raw);
      if (!parsed.success) return this.#close(socket, "protocol_error");
      const frame = parsed.data;
      if (frame.t === "ping") return this.#reply(socket, PONG);
      if (conn.member === null) {
        if (frame.t !== "join") return this.#close(socket, "protocol_error");
        if (frame.v === 1 && frame.capacity !== undefined) return this.#close(socket, "protocol_error");
        return frame.v === 2 ? this.#joinGroup(socket, conn, frame.token, frame.capacity) : this.#join(socket, conn, frame.token);
      }
      if (frame.t === "join") return this.#close(socket, "protocol_error");
      this.#leave(conn.member);
    });
  }

  binary(socket: SocketId, bytes: Uint8Array): Output {
    return this.#run(() => {
      const conn = this.#sockets.get(socket);
      if (!conn) return;
      if (conn.member === null || !this.state || this.state.ended) return this.#close(socket, "protocol_error");
      const member = conn.member;
      if (bytes.length > L.maxBinaryFrameBytes + (typeof member === "number" ? 1 : 0)) return this.#error(socket, "too_large");
      if (typeof member === "number") return this.#binaryGroup(socket, member, bytes);
      const retryAfter = this.#takeToken(member);
      if (retryAfter > 0) return this.#error(socket, "rate_limited", retryAfter);
      this.state.lastActivityAt = this.#now();

      const other = otherOf(member);
      const peerSocket = this.#socketOf(other);
      if (peerSocket !== undefined) return this.#send(peerSocket, bytes);
      const slot = this.state.slots[other];
      if (bytes[0] === HELLO_TYPE || !slot) return; // HELLOs are never buffered; no slot, no buffer
      this.#pruneBuffer(slot);
      const used = slot.buffer.reduce((n, f) => n + f.bytes.length, 0);
      if (slot.buffer.length + 1 > L.offlineBufferFrames || used + bytes.length > L.offlineBufferBytes) {
        return this.#error(socket, "buffer_full");
      }
      if (!this.#admitBuffered(bytes.length)) return this.#error(socket, "buffer_full");
      slot.buffer.push({ at: this.#now(), bytes: bytes.slice() });
      this.#out.persist = true;
    });
  }

  disconnect(socket: SocketId): Output {
    return this.#run(() => {
      const conn = this.#sockets.get(socket);
      if (!conn) return;
      this.#sockets.delete(socket);
      if (conn.member !== null) this.#memberGone(conn.member);
    });
  }

  alarm(): Output {
    return this.#run(() => {
      const now = this.#now();
      for (const [socket, conn] of this.#sockets) {
        if (conn.member === null && conn.deadline !== null && conn.deadline <= now) this.#close(socket, "join_timeout");
      }
      const state = this.state;
      if (!state) return;
      if (now >= state.createdAt + L.maxAgeMs) {
        for (const [socket, conn] of this.#sockets) if (conn.member !== null) this.#close(socket, "ended", false);
        this.state = null;
        this.#buckets.clear();
        this.#out.deleteAll = true;
        return;
      }
      if (state.ended) return;
      for (const slot of slotsOf(state)) if (this.#pruneBuffer(slot)) this.#out.persist = true;
      const anyConnected = slotsOf(state).some((s) => s.connected);
      if (!anyConnected && now - state.lastActivityAt >= L.idleExpiryMs) {
        state.ended = { at: now, reason: "expired" };
        state.slots = {};
        if (state.members) state.members = state.members.map((m) => (m === null ? null : "left"));
        this.#out.persist = true;
      }
    });
  }

  #join(socket: SocketId, conn: Conn, token: string | null): void {
    const now = this.#now();
    if (this.state?.ended) {
      if (this.state.ended.reason === "left") this.#send(socket, JSON.stringify({ t: "peer_left", reason: "left" }));
      return this.#close(socket, "ended");
    }

    if (this.state?.capacity !== undefined) return this.#close(socket, "unsupported_version");
    let member: "a" | "b";
    if (token !== null) {
      const found = (["a", "b"] as const).find((m) => this.state?.slots[m]?.token === token);
      if (!found) return this.#close(socket, "bad_token");
      member = found;
      for (const [other, c] of this.#sockets) {
        if (other !== socket && c.member === member) this.#close(other, "replaced", false);
      }
    } else {
      this.state ??= { createdAt: now, lastActivityAt: now, epoch: 0, ended: null, slots: {} };
      const free = (["a", "b"] as const).find((m) => !this.state!.slots[m]);
      if (!free) return this.#close(socket, "room_full");
      member = free;
      this.state.slots[member] = { token: base64url(this.#random(32)), connected: false, buffer: [] };
    }

    const state = this.state!;
    const slot = state.slots[member]!;
    conn.member = member;
    conn.deadline = null;
    slot.connected = true;
    state.epoch += 1;
    state.lastActivityAt = now;
    this.#pruneBuffer(slot);
    const peerSocket = this.#socketOf(otherOf(member));
    this.#send(
      socket,
      JSON.stringify({
        t: "joined",
        member,
        token: slot.token,
        epoch: state.epoch,
        peer_present: peerSocket !== undefined,
        buffered: slot.buffer.length,
        expires_at: state.createdAt + L.maxAgeMs,
      }),
    );
    for (const frame of slot.buffer) this.#send(socket, frame.bytes);
    slot.buffer = [];
    if (peerSocket !== undefined) this.#send(peerSocket, JSON.stringify({ t: "peer_joined", epoch: state.epoch }));
    this.#out.persist = true;
  }

  /** A `v: 2` join (02 §8.2): only into a group room, which only a join with capacity creates. */
  #joinGroup(socket: SocketId, conn: Conn, token: string | null, capacity: number | undefined): void {
    const now = this.#now();
    if (this.state?.ended) return this.#close(socket, "ended");
    if (this.state && this.state.capacity === undefined) return this.#close(socket, "unsupported_version");
    let member: number;
    if (token !== null) {
      const found = this.state?.members?.findIndex((m) => isSlot(m) && m.token === token) ?? -1;
      if (found < 0) return this.#close(socket, "bad_token");
      member = found;
      for (const [other, c] of this.#sockets) {
        if (other !== socket && c.member === member) this.#close(other, "replaced", false);
      }
    } else {
      if (!this.state) {
        if (capacity === undefined) return this.#close(socket, "ended");
        this.state = { createdAt: now, lastActivityAt: now, epoch: 0, ended: null, slots: {}, capacity, members: Array.from({ length: capacity }, () => null) };
      }
      const free = this.state.members!.indexOf(null);
      if (free < 0) return this.#close(socket, "room_full");
      member = free;
      this.state.members![member] = { token: base64url(this.#random(32)), connected: false, buffer: [] };
    }

    const state = this.state!;
    const slot = state.members![member] as Slot;
    conn.member = member;
    conn.deadline = null;
    slot.connected = true;
    state.epoch += 1;
    state.lastActivityAt = now;
    this.#pruneBuffer(slot);
    const taken = state.members!.flatMap((m, i) => (i !== member && isSlot(m) ? [i] : []));
    const present = taken.filter((i) => this.#socketOf(i) !== undefined);
    this.#send(
      socket,
      JSON.stringify({
        t: "joined",
        member,
        token: slot.token,
        epoch: state.epoch,
        capacity: state.capacity,
        taken,
        present,
        buffered: slot.buffer.length,
        expires_at: state.createdAt + L.maxAgeMs,
      }),
    );
    for (const frame of slot.buffer) this.#send(socket, frame.bytes);
    slot.buffer = [];
    for (const i of present) this.#send(this.#socketOf(i)!, JSON.stringify({ t: "peer_joined", member, epoch: state.epoch }));
    this.#out.persist = true;
  }

  /** `to || frame` from `member` becomes `from || frame` for `to` (02 §8.3). */
  #binaryGroup(socket: SocketId, member: number, bytes: Uint8Array): void {
    const state = this.state!;
    const capacity = state.capacity!;
    const to = bytes[0];
    if (bytes.length < 2 || to === undefined || to === member || to >= capacity) return;
    const target = state.members![to];
    if (!isSlot(target)) return;
    const retryAfter = this.#takeToken(member);
    if (retryAfter > 0) return this.#error(socket, "rate_limited", retryAfter);
    state.lastActivityAt = this.#now();
    const out = bytes.slice();
    out[0] = member;
    const peerSocket = this.#socketOf(to);
    if (peerSocket !== undefined) return this.#send(peerSocket, out);
    if (bytes[1] === HELLO_TYPE) return;
    this.#pruneBuffer(target);
    const used = target.buffer.reduce((n, f) => n + f.bytes.length, 0);
    if (target.buffer.length + 1 > L.offlineBufferFrames || used + out.length > Math.floor(G.roomBufferBytes / capacity)) {
      return this.#error(socket, "buffer_full");
    }
    if (!this.#admitBuffered(out.length)) return this.#error(socket, "buffer_full");
    target.buffer.push({ at: this.#now(), bytes: out });
    this.#out.persist = true;
  }

  #leave(member: Member): void {
    if (typeof member === "number") return this.#leaveGroup(member);
    const state = this.state!;
    const peerSocket = this.#socketOf(otherOf(member));
    if (peerSocket !== undefined) this.#send(peerSocket, JSON.stringify({ t: "peer_left", reason: "left" }));
    for (const [socket, conn] of this.#sockets) if (conn.member !== null) this.#close(socket, "ended", false);
    state.ended = { at: this.#now(), reason: "left" };
    state.slots = {};
    this.#out.persist = true;
  }

  /** 02 §8.2 rule 5: the leaver's slot is retired; the room ends when every taken slot is. */
  #leaveGroup(member: number): void {
    const state = this.state!;
    const members = state.members!;
    for (const [socket, conn] of this.#sockets) if (conn.member === member) this.#close(socket, "ended", false);
    members[member] = "left";
    for (const [socket, conn] of this.#sockets) {
      if (typeof conn.member === "number") this.#send(socket, JSON.stringify({ t: "peer_left", member, reason: "left" }));
    }
    if (!members.some(isSlot)) state.ended = { at: this.#now(), reason: "left" };
    state.lastActivityAt = this.#now();
    this.#out.persist = true;
  }

  /** A joined member's socket is gone: mark the slot offline and tell the peer(s). */
  #memberGone(member: Member): void {
    const slot = this.state ? slotOf(this.state, member) : undefined;
    if (!this.state || !slot || this.#socketOf(member) !== undefined) return;
    slot.connected = false;
    this.state.lastActivityAt = this.#now();
    if (typeof member === "number") {
      for (const [socket, conn] of this.#sockets) {
        if (typeof conn.member === "number") this.#send(socket, JSON.stringify({ t: "peer_left", member, reason: "disconnected" }));
      }
    } else {
      const peerSocket = this.#socketOf(otherOf(member));
      if (peerSocket !== undefined) this.#send(peerSocket, JSON.stringify({ t: "peer_left", reason: "disconnected" }));
    }
    this.#out.persist = true;
  }

  /** Token bucket per member; returns 0 if a token was taken, else seconds to wait. */
  #takeToken(member: Member): number {
    const now = this.#now();
    // A group member sends one copy per peer: the limits scale with capacity − 1 (03 Limits).
    const scale = typeof member === "number" ? Math.max(1, (this.state?.capacity ?? 2) - 1) : 1;
    const burst = L.binaryFrameBurst * scale;
    const refill = REFILL_PER_MS * scale;
    const b = this.#buckets.get(member) ?? { tokens: burst, at: now };
    this.#buckets.set(member, b);
    if (take(b, now, burst, refill)) return 0;
    return Math.max(1, Math.ceil((1 - b.tokens) / refill / 1000));
  }

  /** Drops expired frames; returns whether anything was dropped. */
  #pruneBuffer(slot: Slot): boolean {
    const cutoff = this.#now() - L.bufferedFrameLifetimeMs;
    const before = slot.buffer.length;
    slot.buffer = slot.buffer.filter((f) => f.at > cutoff);
    return slot.buffer.length !== before;
  }

  #socketOf(member: Member): SocketId | undefined {
    for (const [socket, conn] of this.#sockets) if (conn.member === member) return socket;
    return undefined;
  }

  #send(socket: SocketId, data: string | Uint8Array): void {
    this.#out.effects.push({ type: "send", socket, data });
  }

  /** A pong or error: sent only within the socket's reply limit (03 Limits). */
  #reply(socket: SocketId, data: string): void {
    const conn = this.#sockets.get(socket);
    if (conn && take(conn.replies, this.#now(), L.relayReplyBurst, REPLY_REFILL_PER_MS)) this.#send(socket, data);
  }

  #error(socket: SocketId, code: "too_large" | "rate_limited" | "buffer_full", retryAfter?: number): void {
    this.#reply(socket, JSON.stringify(retryAfter === undefined ? { t: "error", code } : { t: "error", code, retry_after: retryAfter }));
  }

  /** Closes a socket. A joined member closed for its own fault counts as a disconnect. */
  #close(socket: SocketId, name: CloseName, notifyPeer = true): void {
    const conn = this.#sockets.get(socket);
    this.#out.effects.push({ type: "close", socket, code: CLOSE[name], reason: name });
    this.#sockets.delete(socket);
    if (notifyPeer && conn && conn.member !== null) this.#memberGone(conn.member);
  }

  #run(fn: () => void): Output {
    this.#out = emptyOutput();
    fn();
    const out = this.#out;
    out.alarmAt = this.#nextAlarm();
    return out;
  }

  #nextAlarm(): number | null {
    const times: number[] = [];
    for (const conn of this.#sockets.values()) if (conn.deadline !== null) times.push(conn.deadline);
    const state = this.state;
    if (state) {
      times.push(state.createdAt + L.maxAgeMs);
      if (!state.ended) {
        for (const slot of slotsOf(state)) {
          if (slot.buffer[0]) times.push(slot.buffer[0].at + L.bufferedFrameLifetimeMs);
        }
        if (!slotsOf(state).some((s) => s.connected)) times.push(state.lastActivityAt + L.idleExpiryMs);
      }
    }
    return times.length ? Math.min(...times) : null;
  }
}

function newConn(member: Member | null, deadline: number | null, now: number): Conn {
  return { member, deadline, replies: { tokens: L.relayReplyBurst, at: now } };
}

/** Token bucket: refills, then takes one token if there is one. */
function take(b: Bucket, now: number, burst: number, perMs: number): boolean {
  b.tokens = Math.min(burst, b.tokens + Math.max(0, now - b.at) * perMs);
  b.at = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}

function emptyOutput(): Output {
  return { effects: [], persist: false, deleteAll: false, alarmAt: null };
}

function otherOf(m: "a" | "b"): "a" | "b" {
  return m === "a" ? "b" : "a";
}

function isSlot(m: Slot | "left" | null | undefined): m is Slot {
  return typeof m === "object" && m !== null;
}

function slotEntries(state: RoomState): [Member, Slot][] {
  const pair: [Member, Slot | undefined][] = [
    ["a", state.slots.a],
    ["b", state.slots.b],
  ];
  const group: [Member, Slot | "left" | null][] = (state.members ?? []).map((m, i) => [i, m]);
  return [...pair, ...group].flatMap(([m, s]) => (isSlot(s) ? [[m, s] as [Member, Slot]] : []));
}

function slotsOf(state: RoomState): Slot[] {
  return slotEntries(state).map(([, s]) => s);
}

function slotOf(state: RoomState, member: Member): Slot | undefined {
  if (typeof member === "number") {
    const m = state.members?.[member];
    return isSlot(m) ? m : undefined;
  }
  return state.slots[member];
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

const slotSchema = z.strictObject({
  token: z.string(),
  connected: z.boolean(),
  buffer: z.array(z.strictObject({ at: z.number().int(), bytes: z.string() })),
});
const roomStateSchema = z.strictObject({
  createdAt: z.number().int(),
  lastActivityAt: z.number().int(),
  epoch: z.number().int().nonnegative(),
  ended: z.strictObject({ at: z.number().int(), reason: z.enum(["left", "expired"]) }).nullable(),
  slots: z.strictObject({ a: slotSchema.optional(), b: slotSchema.optional() }),
  capacity: z.number().int().min(G.minCapacity).max(G.maxCapacity).optional(),
  members: z.array(z.union([slotSchema, z.literal("left"), z.null()])).max(G.maxCapacity).optional(),
});

/** RoomState as JSON text, frame bytes as base64url (03, Room state machine). */
export function encodeRoomState(state: RoomState): string {
  const slot = (s: Slot) => ({ ...s, buffer: s.buffer.map((f) => ({ at: f.at, bytes: base64url(f.bytes) })) });
  return JSON.stringify({
    ...state,
    slots: { ...(state.slots.a && { a: slot(state.slots.a) }), ...(state.slots.b && { b: slot(state.slots.b) }) },
    ...(state.members && { members: state.members.map((m) => (isSlot(m) ? slot(m) : m)) }),
  });
}

/** Inverse of encodeRoomState; throws on anything that isn't a valid encoded RoomState. */
export function decodeRoomState(text: string): RoomState {
  const parsed = roomStateSchema.parse(JSON.parse(text));
  const slot = (s: z.infer<typeof slotSchema>): Slot => ({
    ...s,
    buffer: s.buffer.map((f) => ({ at: f.at, bytes: base64urlDecode(f.bytes) })),
  });
  const slots: RoomState["slots"] = {};
  if (parsed.slots.a) slots.a = slot(parsed.slots.a);
  if (parsed.slots.b) slots.b = slot(parsed.slots.b);
  const { capacity, members, ...rest } = parsed;
  if (capacity === undefined && members === undefined) return { ...rest, slots };
  if (capacity === undefined || members === undefined || members.length !== capacity) throw new Error("bad group room state");
  return { ...rest, slots, capacity, members: members.map((m) => (m === null || m === "left" ? m : slot(m))) };
}

const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** base64url without padding. */
export function base64url(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    const chars = Math.min(4, Math.ceil(((bytes.length - i) * 8) / 6));
    for (let k = 0; k < chars; k++) out += B64URL[(n >> (18 - 6 * k)) & 63];
  }
  return out;
}

/** Inverse of base64url; throws on padding, foreign characters or a non-canonical tail. */
export function base64urlDecode(text: string): Uint8Array {
  if (text.length % 4 === 1) throw new Error("bad base64url length");
  const out = new Uint8Array(Math.floor((text.length * 6) / 8));
  let acc = 0;
  let bits = 0;
  let o = 0;
  for (const ch of text) {
    const v = B64URL.indexOf(ch);
    if (v < 0) throw new Error("bad base64url character");
    acc = ((acc << 6) | v) & 0xffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  if ((acc & ((1 << bits) - 1)) !== 0) throw new Error("non-canonical base64url");
  return out;
}
