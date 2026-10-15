// Relay room state machine (03, Room state machine; 02 §5). Pure logic: the host (Durable
// Object or Node) feeds it socket events and applies the returned effects.
import { randomBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { z } from "zod";
import { RELAY_LIMITS as L } from "./limits.js";

export type Member = "a" | "b";
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
} as const;
type CloseName = keyof typeof CLOSE;

const PONG = '{"t":"pong"}';
const HELLO_TYPE = 0x01;
const REFILL_PER_MS = L.binaryFramesPerMinute / 60_000;

const controlSchema = z.discriminatedUnion("t", [
  z.strictObject({ t: z.literal("join"), v: z.number(), token: z.string().nullable() }),
  z.strictObject({ t: z.literal("leave") }),
  z.strictObject({ t: z.literal("ping") }),
]);

interface Conn {
  member: Member | null;
  /** Join deadline for a socket that hasn't joined yet. */
  deadline: number | null;
}

export class RelayRoom {
  state: RoomState | null;
  readonly #now: () => number;
  readonly #random: (n: number) => Uint8Array;
  readonly #sockets = new Map<SocketId, Conn>();
  /** In memory only; resets on hibernation, which errs toward leniency (03). */
  readonly #buckets = new Map<Member, { tokens: number; at: number }>();
  #out: Output = emptyOutput();

  constructor(opts: {
    now: () => number;
    random?: (n: number) => Uint8Array;
    state?: RoomState | null;
    /** Sockets that survived hibernation, with the member each belongs to (null: not joined yet). */
    sockets?: Record<SocketId, Member | null>;
  }) {
    this.#now = opts.now;
    this.#random = opts.random ?? randomBytes;
    this.state = opts.state ?? null;
    const now = this.#now();
    for (const [socket, member] of Object.entries(opts.sockets ?? {})) {
      this.#sockets.set(socket, { member, deadline: member ? null : now + L.joinDeadlineMs });
    }
    if (this.state) {
      for (const m of ["a", "b"] as const) {
        const slot = this.state.slots[m];
        if (slot) slot.connected = this.#socketOf(m) !== undefined;
      }
    }
  }

  connect(socket: SocketId): Output {
    return this.#run(() => {
      this.#sockets.set(socket, { member: null, deadline: this.#now() + L.joinDeadlineMs });
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
      if (isObject(raw) && raw.t === "join" && typeof raw.v === "number" && raw.v !== 1) {
        return this.#close(socket, "unsupported_version");
      }
      const parsed = controlSchema.safeParse(raw);
      if (!parsed.success) return this.#close(socket, "protocol_error");
      const frame = parsed.data;
      if (frame.t === "ping") return this.#send(socket, PONG);
      if (conn.member === null) {
        return frame.t === "join" ? this.#join(socket, conn, frame.token) : this.#close(socket, "protocol_error");
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
      if (bytes.length > L.maxBinaryFrameBytes) return this.#error(socket, "too_large");
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
      slot.buffer.push({ at: this.#now(), bytes: bytes.slice() });
      this.#out.persist = true;
    });
  }

  disconnect(socket: SocketId): Output {
    return this.#run(() => {
      const conn = this.#sockets.get(socket);
      if (!conn) return;
      this.#sockets.delete(socket);
      if (conn.member) this.#memberGone(conn.member);
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
        for (const [socket, conn] of this.#sockets) if (conn.member) this.#close(socket, "ended", false);
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

    let member: Member;
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

  #leave(member: Member): void {
    const state = this.state!;
    const peerSocket = this.#socketOf(otherOf(member));
    if (peerSocket !== undefined) this.#send(peerSocket, JSON.stringify({ t: "peer_left", reason: "left" }));
    for (const [socket, conn] of this.#sockets) if (conn.member) this.#close(socket, "ended", false);
    state.ended = { at: this.#now(), reason: "left" };
    state.slots = {};
    this.#out.persist = true;
  }

  /** A joined member's socket is gone: mark the slot offline and tell the peer. */
  #memberGone(member: Member): void {
    const slot = this.state?.slots[member];
    if (!this.state || !slot || this.#socketOf(member) !== undefined) return;
    slot.connected = false;
    this.state.lastActivityAt = this.#now();
    const peerSocket = this.#socketOf(otherOf(member));
    if (peerSocket !== undefined) this.#send(peerSocket, JSON.stringify({ t: "peer_left", reason: "disconnected" }));
    this.#out.persist = true;
  }

  /** Token bucket per member; returns 0 if a token was taken, else seconds to wait. */
  #takeToken(member: Member): number {
    const now = this.#now();
    const b = this.#buckets.get(member) ?? { tokens: L.binaryFrameBurst, at: now };
    b.tokens = Math.min(L.binaryFrameBurst, b.tokens + (now - b.at) * REFILL_PER_MS);
    b.at = now;
    this.#buckets.set(member, b);
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return 0;
    }
    return Math.max(1, Math.ceil((1 - b.tokens) / REFILL_PER_MS / 1000));
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

  #error(socket: SocketId, code: "too_large" | "rate_limited" | "buffer_full", retryAfter?: number): void {
    this.#send(socket, JSON.stringify(retryAfter === undefined ? { t: "error", code } : { t: "error", code, retry_after: retryAfter }));
  }

  /** Closes a socket. A joined member closed for its own fault counts as a disconnect. */
  #close(socket: SocketId, name: CloseName, notifyPeer = true): void {
    const conn = this.#sockets.get(socket);
    this.#out.effects.push({ type: "close", socket, code: CLOSE[name], reason: name });
    this.#sockets.delete(socket);
    if (notifyPeer && conn?.member) this.#memberGone(conn.member);
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

function emptyOutput(): Output {
  return { effects: [], persist: false, deleteAll: false, alarmAt: null };
}

function otherOf(m: Member): Member {
  return m === "a" ? "b" : "a";
}

function slotsOf(state: RoomState): Slot[] {
  return [state.slots.a, state.slots.b].filter((s): s is Slot => s !== undefined);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
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
