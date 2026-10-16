// The relay connection of one room (02 §4–6, 04 §3): join and rejoin with the member token,
// the HELLO handshake per epoch, reliable ordered delivery with acks and resends, frame
// pacing, reconnect with backoff, and the room's end. One instance per owning MCP server.
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import {
  CLIENT_LIMITS,
  COLLAB_CAP,
  fallbackEnvelope,
  Handshake,
  HELLO_TYPE,
  isCollabKind,
  makeAck,
  MSG_TYPE,
  noticePeerChanged,
  noticePeerJoined,
  noticePeerLeft,
  noticePeerUnreadable,
  noticeWrongKey,
  openMsg,
  receiveDecision,
  sealMsg,
  serializeEnvelope,
  type CollabData,
  type CollabEnvelope,
  type CollabKind,
  type Envelope,
  type HelloPayload,
  type Notice,
  type RoomKeys,
  type Session,
} from "@pairwire/core";
import { monotonicFactory } from "ulid";
import { WebSocket } from "ws";
import { closeRoomLocally } from "./lifecycle.js";
import type { Logger } from "./log.js";
import { appendCoordSent, appendInbox, readCoordSent, readOutbox, unacked, updateOutbox, type InboxEntry, type OutboxEntry } from "./room-files.js";
import { expiresAt, isOpen, readSessionCaps, readState, updateState, writeSessionCaps, type RoomState, type StoredSession } from "./state.js";

// ---------------------------------------------------------------------------------------
// Injectable socket and timers, so tests can drop, duplicate or delay frames and use short
// intervals.

export interface SocketHandlers {
  onOpen(): void;
  onText(data: string): void;
  onBinary(data: Uint8Array): void;
  onClose(code: number): void;
}

export interface RelaySocket {
  sendText(data: string): void;
  sendBinary(data: Uint8Array): void;
  close(code?: number): void;
}

export type SocketFactory = (url: string, handlers: SocketHandlers) => RelaySocket;

export const wsSocketFactory: SocketFactory = (url, h) => {
  const ws = new WebSocket(url);
  ws.on("open", () => h.onOpen());
  ws.on("message", (data, isBinary) => {
    const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as Buffer);
    if (isBinary) h.onBinary(new Uint8Array(buf));
    else h.onText(buf.toString("utf8"));
  });
  ws.on("close", (code) => h.onClose(code));
  ws.on("error", () => {
    // a 'close' event always follows
  });
  return {
    sendText: (d) => ws.readyState === WebSocket.OPEN && ws.send(d),
    sendBinary: (d) => ws.readyState === WebSocket.OPEN && ws.send(d, { binary: true }),
    close: (code = 1000) => {
      if (ws.readyState === WebSocket.CONNECTING) ws.terminate();
      else ws.close(code);
    },
  };
};

export interface Timers {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  random(): number;
}

export const realTimers: Timers = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  random: () => Math.random(),
};

/** Intervals from 02 §5–6 and 04; tests shorten them. */
export interface Tuning {
  pingIntervalMs: number;
  ackDelayMs: number;
  resendAfterMs: number;
  framesPerWindow: number;
  windowMs: number;
  backoffMinMs: number;
  backoffMaxMs: number;
  /** Pause after `rate_limited`/`buffer_full` without `retry_after`. */
  defaultRetryMs: number;
  /** How long `leave` waits for the bye to go out and the relay to close. */
  leaveTimeoutMs: number;
}

export const DEFAULT_TUNING: Tuning = {
  pingIntervalMs: CLIENT_LIMITS.pingIntervalMs,
  ackDelayMs: CLIENT_LIMITS.ackDelayMs,
  resendAfterMs: CLIENT_LIMITS.resendAfterMs,
  framesPerWindow: CLIENT_LIMITS.binaryFramesPer10s,
  windowMs: 10_000,
  backoffMinMs: 1000,
  backoffMaxMs: 30_000,
  defaultRetryMs: 30_000,
  leaveTimeoutMs: 5000,
};

// ---------------------------------------------------------------------------------------

export type EndReason = "left" | "peer_left" | "expired" | "room_full" | "gone";

export interface ConnectionEvents {
  /** A peer message or local notice was appended to the inbox. */
  inbound?(entry: InboxEntry): void;
  /** An envelope of ours got a seq and entered the outbox. */
  sent?(envelope: Envelope): void;
  /** Our envelopes with these ids were acked (REQ-MSG-6). */
  delivered?(ids: string[]): void;
  /** The peer's identity changed (04 §3, Peer identity). */
  peerChanged?(notice: Notice): void;
  /** Connection or session state changed. */
  status?(status: ConnectionStatus): void;
  /** The room ended locally; the connection is stopped. */
  ended?(reason: EndReason): void;
}

export interface ConnectionStatus {
  socket: "offline" | "connecting" | "joined";
  peerConnected: boolean;
  /** A session exists (current), so sends go out at once. */
  session: boolean;
  /** Set when the connection stopped for good: wrong key, replaced, protocol error. */
  halted: string | null;
}

export interface ConnectionOptions {
  home: string;
  keys: RoomKeys;
  /** wss://host/v1/rooms/<room_id> */
  url: string;
  hello: HelloPayload;
  log: Logger;
  events?: ConnectionEvents;
  socketFactory?: SocketFactory;
  timers?: Timers;
  tuning?: Partial<Tuning>;
}

export type SendInput =
  | {
      kind: "chat" | "question" | "answer" | "bye";
      body: string | null;
      reply_to?: string | null;
      author: "agent" | "human";
    }
  | ({
      [K in CollabKind]: { kind: K; data: CollabData[K] };
    }[CollabKind] & {
      body: string | null;
      reply_to?: string | null;
      author: "agent";
      /** The chat body for a peer without `collab1`, already checked (02 §6.3.6). */
      fallbackBody: string;
      /** coord-sent.jsonl: our local time of the send (default: now) and an accept's own copy (04 §3). */
      sentAt?: number;
      localPath?: string;
    });

export interface SendResult {
  id: string;
  seq: number;
  status: "sent" | "queued";
  envelope: Envelope;
  /** How a structured kind went out under the current session; null while queued. */
  encoding: "structured" | "chat" | null;
}

type QueueItem = { t: "hello"; frame: Uint8Array } | { t: "env"; id: string } | { t: "ack" };

/** Whether the peer HELLO behind session `sid` advertised `collab1`. */
function collabFor(home: string, roomId: string, sid: string): boolean {
  return readSessionCaps(home, roomId)[sid]?.includes(COLLAB_CAP) ?? false;
}

/**
 * What goes on the wire for an outbox entry (02 §6.3.6). The outbox holds the fallback chat of
 * a structured kind, in the shape 0.1.x reads; a session with `collab1` sends the structured
 * envelope with the same id from coord-sent.jsonl instead.
 */
function wireEnvelope(entry: OutboxEntry, structured: ReadonlyMap<string, Envelope> | null): Envelope {
  const env = entry.envelope;
  const original = env.kind === "chat" ? structured?.get(env.id) : undefined;
  return original && isCollabKind(original.kind) && original.seq === env.seq ? original : env;
}

const toStored = (s: Session): StoredSession => ({ sid: bytesToHex(s.sid), send_key: bytesToHex(s.sendKey), recv_key: bytesToHex(s.recvKey) });
const fromStored = (s: StoredSession): Session => ({ sid: hexToBytes(s.sid), sendKey: hexToBytes(s.send_key), recvKey: hexToBytes(s.recv_key) });

/** setTimeout can't wait longer than about 24.8 days. */
const MAX_TIMER_MS = 2 ** 31 - 1;

export class RoomConnection {
  readonly #o: ConnectionOptions;
  readonly #t: Timers;
  readonly #tune: Tuning;
  readonly #ulid: () => string;
  readonly #roomId: string;

  #socket: RelaySocket | null = null;
  #handshake: Handshake | null = null;
  #joined = false;
  #peerConnected = false;
  #peerLeft = false;
  #stopped = false;
  #halted: string | null = null;
  #attempt = 0;
  #leaving: (() => void) | null = null;
  #leaveRequested = false;
  #unreadableNoticed = false;

  #queue: QueueItem[] = [];
  #sentTimes: number[] = [];
  #pausedUntil = 0;

  #timers = new Map<string, unknown>();

  constructor(options: ConnectionOptions) {
    this.#o = options;
    this.#t = options.timers ?? realTimers;
    this.#tune = { ...DEFAULT_TUNING, ...options.tuning };
    this.#ulid = monotonicFactory(() => this.#t.random());
    this.#roomId = options.keys.roomId;
  }

  // --- public API ----------------------------------------------------------------------

  /** Connects if the room is open; ends it locally first if it is past its expiry. */
  start(): void {
    const s = this.#state();
    if (!s || !isOpen(s)) return;
    if (this.#t.now() >= expiresAt(s)) return this.#end("expired");
    this.#halted = s.error === "wrong_key" ? "wrong_key" : null;
    if (this.#halted) return this.#emitStatus();
    this.#connect();
  }

  /** The human ran a pairwire command: clear a wrong-key halt and reconnect (02 §4.2). */
  resume(): void {
    if (this.#halted !== "wrong_key") return;
    updateState(this.#o.home, this.#roomId, (s) => ({ ...s, error: null }));
    this.#halted = null;
    if (!this.#socket) this.#connect();
  }

  /** Closes the socket without ending the room (session shutdown). */
  stop(): void {
    this.#stopped = true;
    this.#clearAll();
    this.#socket?.close(1000);
    this.#socket = null;
  }

  status(): ConnectionStatus {
    const s = this.#state();
    return {
      socket: this.#joined ? "joined" : this.#socket ? "connecting" : "offline",
      peerConnected: this.#peerConnected,
      session: !!s?.sessions.current,
      halted: this.#halted,
    };
  }

  /**
   * Assigns the next seq (persisted before anything is written to the socket), stores the
   * envelope in the outbox and sends it under the current session, or queues it until the
   * first session exists (02 §6.2). Throws EnvelopeTooLargeError before using a seq.
   */
  send(input: SendInput): SendResult {
    const s = this.#state();
    if (!s || !isOpen(s)) throw new Error("The room is not open.");
    const common = {
      v: 1 as const,
      id: this.#ulid(),
      seq: s.my_seq + 1,
      ts: new Date(this.#t.now()).toISOString(),
      reply_to: input.reply_to ?? null,
      body: input.body,
      acks: null,
    };
    const structured = "fallbackBody" in input;
    const envelope = (structured ? { ...common, author: "agent", kind: input.kind, data: input.data } : { ...common, author: input.author, kind: input.kind }) as Envelope;
    serializeEnvelope(envelope);
    const fallback = structured ? fallbackEnvelope(envelope as CollabEnvelope, input.fallbackBody) : null;
    if (fallback) serializeEnvelope(fallback);
    updateState(this.#o.home, this.#roomId, (st) => ({ ...st, my_seq: Math.max(st.my_seq, envelope.seq) }));
    const status = s.sessions.current ? "sent" : "queued";
    // A structured kind: the structured envelope goes to coord-sent.jsonl first, so the pump
    // finds it; the outbox keeps the fallback chat, which 0.1.x can read and resend (02 §6.3.6).
    if (structured) {
      const sentAt = input.sentAt ?? this.#t.now();
      appendCoordSent(this.#o.home, this.#roomId, { envelope, sent_at: sentAt, ...(input.localPath ? { local_path: input.localPath } : {}) });
    }
    const entry: OutboxEntry = { envelope: fallback ?? envelope, status, sent_at: null, delivered_at: null };
    updateOutbox(this.#o.home, this.#roomId, (entries) => [...entries, entry]);
    this.#o.events?.sent?.(envelope);
    if (status === "sent") {
      this.#queue.push({ t: "env", id: envelope.id });
      this.#pump();
    }
    const encoding = !structured || status === "queued" ? null : this.peerHasCollab() ? "structured" : "chat";
    return { id: envelope.id, seq: envelope.seq, status, envelope, encoding };
  }

  /** Whether the current session's peer advertised `collab1` (02 §6.3.2). */
  peerHasCollab(): boolean {
    const current = this.#state()?.sessions.current;
    return !!current && collabFor(this.#o.home, this.#roomId, current.sid);
  }

  /**
   * REQ-ROOM-5: sends `bye` (with the optional message) under the current session, then relay
   * `leave`, then removes the room locally. The caller has already validated and scanned the
   * message. Resolves when done; never throws for network problems.
   */
  async leave(message: string | null = null): Promise<void> {
    const s = this.#state();
    if (!s || !isOpen(s)) return;
    const done = new Promise<void>((resolve) => {
      this.#leaving = resolve;
      this.#set("leave", this.#tune.leaveTimeoutMs, resolve);
    });
    if (s.sessions.current) this.send({ kind: "bye", body: message, author: "agent" });
    this.#leaveRequested = true;
    if (this.#joined) this.#sendLeaveWhenDrained();
    else if (!this.#socket && !this.#halted) this.#connect();
    await done;
    this.#leaving = null;
    this.#clear("leave");
    this.#stopped = true;
    this.#clearAll();
    this.#socket?.close(1000);
    this.#socket = null;
    this.#end("left");
  }

  // --- connection ----------------------------------------------------------------------

  #state(): RoomState | null {
    return readState(this.#o.home, this.#roomId);
  }

  #connect(): void {
    if (this.#stopped || this.#halted) return;
    const s = this.#state();
    if (!s || !isOpen(s)) return;
    this.#handshake = new Handshake({ keys: this.#o.keys, payload: this.#o.hello });
    this.#joined = false;
    this.#peerConnected = false;
    const factory = this.#o.socketFactory ?? wsSocketFactory;
    let socket: RelaySocket | null = null;
    const current = () => socket !== null && socket === this.#socket;
    socket = factory(this.#o.url, {
      onOpen: () => {
        if (!current()) return;
        socket!.sendText(JSON.stringify({ t: "join", v: 1, token: this.#state()?.token ?? null }));
        this.#schedulePing();
      },
      onText: (d) => current() && this.#onText(d),
      onBinary: (d) => current() && this.#onBinary(d),
      onClose: (code) => current() && this.#onClose(code),
    });
    this.#socket = socket;
    this.#emitStatus();
  }

  #schedulePing(): void {
    this.#set("ping", this.#tune.pingIntervalMs, () => {
      this.#socket?.sendText('{"t":"ping"}');
      this.#schedulePing();
    });
  }

  #onText(data: string): void {
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return this.#o.log.warn("relay_bad_frame");
    }
    switch (frame.t) {
      case "joined":
        return this.#onJoined(frame);
      case "peer_joined":
        this.#peerConnected = true;
        this.#emitStatus();
        return this.#startEpoch(Number(frame.epoch));
      case "peer_left":
        this.#peerConnected = false;
        if (frame.reason === "left") this.#peerLeft = true;
        return this.#emitStatus();
      case "error": {
        const code = String(frame.code);
        this.#o.log.warn("relay_error", { code });
        if (code === "rate_limited" || code === "buffer_full") {
          const retry = typeof frame.retry_after === "number" ? frame.retry_after * 1000 : this.#tune.defaultRetryMs;
          this.#pausedUntil = this.#t.now() + retry;
          this.#set("retry", retry, () => this.#resendUnacked());
        }
        return;
      }
      default:
        return; // pong and unknown frames
    }
  }

  #onJoined(frame: Record<string, unknown>): void {
    const epoch = Number(frame.epoch);
    const expires = typeof frame.expires_at === "number" ? frame.expires_at : null;
    updateState(this.#o.home, this.#roomId, (s) => ({
      ...s,
      member: frame.member === "a" || frame.member === "b" ? frame.member : s.member,
      token: typeof frame.token === "string" ? frame.token : s.token,
      epoch,
      expires_at: expires ?? s.expires_at,
    }));
    this.#joined = true;
    this.#attempt = 0;
    this.#peerConnected = frame.peer_present === true;
    this.#scheduleExpiry();
    this.#scheduleResendCheck();
    this.#o.log.info("joined", { epoch, peer_present: this.#peerConnected, buffered: Number(frame.buffered ?? 0) });
    this.#emitStatus();
    if (this.#leaveRequested) return this.#sendLeaveWhenDrained();
    if (this.#peerConnected) this.#startEpoch(epoch);
    else this.#handshake?.noteEpoch(epoch);
    // Envelopes accepted while we were offline go out under the current session; the relay
    // buffers them if the peer is away too (02 §6.2).
    if (this.#state()?.sessions.current) this.#sendNeverSent();
  }

  #startEpoch(epoch: number): void {
    const hello = this.#handshake?.startEpoch(epoch);
    if (!hello) return;
    this.#queue.unshift({ t: "hello", frame: hello });
    this.#pump();
  }

  #onBinary(data: Uint8Array): void {
    if (data[0] === HELLO_TYPE) {
      const ev = this.#handshake!.receive(data);
      if (ev.type === "session") return this.#onSession(ev.session, ev.peer);
      this.#o.log.debug("hello_dropped", { reason: ev.reason });
      if (ev.wrongKey) this.#onWrongKey();
      return;
    }
    if (data[0] !== MSG_TYPE) return this.#o.log.debug("frame_dropped", { reason: "unknown_type" });
    const s = this.#state();
    if (!s) return;
    const sessions = [s.sessions.current, s.sessions.previous].filter((x): x is StoredSession => x !== null).map(fromStored);
    const opened = openMsg(data, { roomIdBytes: this.#o.keys.roomIdBytes, sessions });
    if (!opened.ok) {
      if (opened.skipSeq !== undefined) return this.#onUnreadable(opened.skipSeq, opened.reason);
      return this.#o.log.debug("frame_dropped", { reason: opened.reason });
    }
    this.#onEnvelope(opened.envelope);
  }

  #onSession(session: Session, peer: HelloPayload): void {
    const before = this.#state();
    if (!before) return;
    const after = updateState(this.#o.home, this.#roomId, (s) => ({
      ...s,
      status: "active",
      sessions: { current: toStored(session), previous: s.sessions.current },
      peer: { name: peer.name, harness: peer.harness, instance: peer.instance },
    }));
    const sids = [after.sessions.current, after.sessions.previous].flatMap((x) => (x ? [x.sid] : []));
    writeSessionCaps(this.#o.home, this.#roomId, sids[0]!, peer.caps, sids);
    this.#o.log.info("session", { first: before.peer === null });
    if (before.peer === null) {
      this.#notice(noticePeerJoined(peer.name, peer.harness));
    } else if (before.peer.instance !== peer.instance || before.peer.name !== peer.name) {
      const notice = noticePeerChanged(before.peer, peer);
      this.#o.log.warn("peer_changed");
      this.#o.events?.peerChanged?.(notice);
      this.#notice(notice);
    }
    this.#emitStatus();
    this.#resendUnacked();
  }

  #onEnvelope(env: Envelope): void {
    const s = this.#state();
    if (!s) return;
    const decision = receiveDecision(env, s.peer_max_seq);
    if (decision === "ack") return this.#onAck(env.acks ?? 0);
    if (decision === "out_of_order") return this.#o.log.debug("frame_dropped", { reason: "out_of_order", seq: env.seq });
    if (decision === "accept") {
      const entry: InboxEntry = {
        source: "peer",
        id: env.id,
        from: s.peer?.name ?? "",
        harness: s.peer?.harness ?? "other",
        received_at: this.#t.now(),
        envelope: env,
      };
      const added = appendInbox(this.#o.home, this.#roomId, entry);
      updateState(this.#o.home, this.#roomId, (st) => ({ ...st, peer_max_seq: Math.max(st.peer_max_seq, env.seq) }));
      if (added) this.#o.events?.inbound?.(entry);
    }
    this.#scheduleAck();
  }

  /**
   * An envelope that decrypted but can't be used still counts for ordering, so a newer peer's
   * message never stalls the ones after it (02 §6.1, ADR-025). Never shown; one notice per
   * connection tells the humans something didn't arrive.
   */
  #onUnreadable(seq: number, reason: string): void {
    const s = this.#state();
    if (!s) return;
    this.#o.log.info("frame_skipped", { reason, seq });
    if (seq > s.peer_max_seq + 1) return; // out of order: the resend comes back in order
    if (seq === s.peer_max_seq + 1) {
      updateState(this.#o.home, this.#roomId, (st) => ({ ...st, peer_max_seq: Math.max(st.peer_max_seq, seq) }));
      if (!this.#unreadableNoticed) {
        this.#unreadableNoticed = true;
        this.#notice(noticePeerUnreadable(s.peer?.name ?? ""));
      }
    }
    this.#scheduleAck();
  }

  #onAck(acks: number): void {
    const now = this.#t.now();
    const ids: string[] = [];
    updateOutbox(this.#o.home, this.#roomId, (entries) =>
      entries.map((e) => {
        if (e.status === "delivered" || e.envelope.seq > acks) return e;
        ids.push(e.envelope.id);
        return { ...e, status: "delivered", delivered_at: now };
      }),
    );
    if (ids.length > 0) this.#o.events?.delivered?.(ids);
  }

  #scheduleAck(): void {
    if (this.#timers.has("ack")) return;
    this.#set("ack", this.#tune.ackDelayMs, () => {
      this.#queue.push({ t: "ack" });
      this.#pump();
    });
  }

  #onWrongKey(): void {
    this.#o.log.warn("wrong_key");
    updateState(this.#o.home, this.#roomId, (s) => ({ ...s, error: "wrong_key" }));
    this.#halted = "wrong_key";
    this.#notice(noticeWrongKey());
    this.#socket?.close(1000);
  }

  #onClose(code: number): void {
    this.#socket = null;
    this.#joined = false;
    this.#peerConnected = false;
    this.#queue = [];
    for (const name of ["ping", "ack", "pump", "resend", "retry", "expiry"]) this.#clear(name);
    this.#o.log.info("closed", { code });
    if (this.#leaving) return this.#leaving();
    switch (code) {
      case 4001:
        return this.#end("room_full");
      case 4002:
      case 4003:
        return this.#end(this.#peerLeft ? "peer_left" : "gone");
      case 4004:
      case 4005:
        return this.#halt(code === 4004 ? "unsupported_version" : "protocol_error");
      case 4007:
        return this.#halt("replaced");
      default:
        this.#emitStatus();
        return this.#scheduleReconnect();
    }
  }

  #halt(reason: string): void {
    this.#halted = reason;
    if (reason !== "replaced") updateState(this.#o.home, this.#roomId, (s) => ({ ...s, error: reason }));
    this.#emitStatus();
  }

  #scheduleReconnect(): void {
    if (this.#stopped || this.#halted) return;
    const base = Math.min(this.#tune.backoffMaxMs, this.#tune.backoffMinMs * 2 ** this.#attempt);
    const delay = Math.round(base * (0.5 + this.#t.random() / 2));
    this.#attempt++;
    this.#set("reconnect", delay, () => this.#connect());
  }

  #scheduleExpiry(): void {
    const s = this.#state();
    if (!s) return;
    const wait = Math.max(0, expiresAt(s) - this.#t.now());
    if (wait > MAX_TIMER_MS) return; // rescheduled on the next join
    this.#set("expiry", wait, () => this.#end("expired"));
  }

  /** Rule (b) of 02 §6.2: resend when the oldest unacked envelope is old and the peer is here. */
  #scheduleResendCheck(): void {
    const every = Math.max(50, Math.min(1000, Math.floor(this.#tune.resendAfterMs / 3)));
    this.#set("resend", every, () => {
      const now = this.#t.now();
      const oldest = unacked(readOutbox(this.#o.home, this.#roomId)).find((e) => e.sent_at !== null);
      if (this.#peerConnected && oldest?.sent_at != null && now - oldest.sent_at >= this.#tune.resendAfterMs) {
        this.#o.log.debug("resend", { reason: "timeout" });
        this.#resendUnacked();
      }
      this.#scheduleResendCheck();
    });
  }

  /** Queues every unacked envelope, in seq order, once (rule (a) and (b) of 02 §6.2). */
  #resendUnacked(): void {
    const queued = new Set(this.#queue.flatMap((q) => (q.t === "env" ? [q.id] : [])));
    for (const e of unacked(readOutbox(this.#o.home, this.#roomId))) {
      if (!queued.has(e.envelope.id)) this.#queue.push({ t: "env", id: e.envelope.id });
    }
    this.#pump();
  }

  #sendNeverSent(): void {
    const queued = new Set(this.#queue.flatMap((q) => (q.t === "env" ? [q.id] : [])));
    for (const e of unacked(readOutbox(this.#o.home, this.#roomId))) {
      if (e.sent_at === null && !queued.has(e.envelope.id)) this.#queue.push({ t: "env", id: e.envelope.id });
    }
    this.#pump();
  }

  /** Writes queued frames while the rolling window allows (02 §6.2 pacing). */
  #pump(): void {
    this.#clear("pump");
    if (!this.#socket || !this.#joined) return;
    const now = this.#t.now();
    if (now < this.#pausedUntil) return this.#set("pump", this.#pausedUntil - now, () => this.#pump());
    this.#sentTimes = this.#sentTimes.filter((at) => now - at < this.#tune.windowMs);
    const s = this.#state();
    const session = s?.sessions.current ? fromStored(s.sessions.current) : null;
    // The encoding of structured kinds follows the caps of the session we encrypt under (02 §6.3.6).
    const collab = !!s?.sessions.current && collabFor(this.#o.home, this.#roomId, s.sessions.current.sid);
    const outbox = new Map(readOutbox(this.#o.home, this.#roomId).map((e) => [e.envelope.id, e]));
    let structured: Map<string, Envelope> | null | undefined;
    const structuredFor = () => (structured ??= collab ? new Map(readCoordSent(this.#o.home, this.#roomId).map((c) => [c.envelope.id, c.envelope])) : null);
    const sentIds: string[] = [];

    while (this.#queue.length > 0 && this.#sentTimes.length < this.#tune.framesPerWindow) {
      const item = this.#queue.shift()!;
      let frame: Uint8Array | null = null;
      if (item.t === "hello") frame = item.frame;
      else if (session && item.t === "ack") {
        frame = sealMsg({ roomIdBytes: this.#o.keys.roomIdBytes, session, envelope: makeAck(s!.peer_max_seq, this.#ulid(), new Date(now).toISOString()) });
        this.#clear("ack");
      } else if (session && item.t === "env") {
        const entry = outbox.get(item.id);
        if (entry && entry.status !== "delivered") {
          frame = sealMsg({ roomIdBytes: this.#o.keys.roomIdBytes, session, envelope: wireEnvelope(entry, structuredFor()) });
          sentIds.push(item.id);
        }
      }
      if (!frame) continue;
      this.#socket.sendBinary(frame);
      // The moment of the write, not of the pump: a batch can straddle a millisecond.
      this.#sentTimes.push(this.#t.now());
    }

    if (sentIds.length > 0) {
      const ids = new Set(sentIds);
      updateOutbox(this.#o.home, this.#roomId, (entries) =>
        entries.map((e) => (ids.has(e.envelope.id) && e.status !== "delivered" ? { ...e, status: "sent", sent_at: now } : e)),
      );
    }
    if (this.#queue.length > 0) {
      const wait = this.#sentTimes[0]! + this.#tune.windowMs - now;
      this.#set("pump", Math.max(1, wait), () => this.#pump());
    } else if (this.#leaveRequested) {
      this.#socket.sendText('{"t":"leave"}');
    }
  }

  #sendLeaveWhenDrained(): void {
    if (this.#queue.length === 0) this.#socket?.sendText('{"t":"leave"}');
    else this.#pump(); // sends leave once the queue is empty
  }

  /** Queues a local notice from the session (hold mode's `held`, 04 §5). */
  notice(notice: Notice): void {
    this.#notice(notice);
  }

  #notice(notice: Notice): void {
    const entry: InboxEntry = { source: "local", id: this.#ulid(), event: notice.event, text: notice.text, received_at: this.#t.now() };
    appendInbox(this.#o.home, this.#roomId, entry);
    this.#o.events?.inbound?.(entry);
  }

  /** The room is over: queue the notice, remove it locally, stop for good. */
  #end(reason: EndReason): void {
    const s = this.#state();
    this.#stopped = true;
    this.#clearAll();
    this.#socket?.close(1000);
    this.#socket = null;
    if (!s || !isOpen(s)) return;
    if (reason === "peer_left") this.#notice(noticePeerLeft(s.peer?.name ?? "", "left"));
    else if (reason === "expired" || reason === "gone") this.#notice(noticePeerLeft(s.peer?.name ?? "", "expired"));
    closeRoomLocally(this.#o.home, this.#roomId, reason === "left" ? "left" : "ended", reason === "left" ? null : reason);
    this.#o.log.info("room_ended", { reason });
    this.#o.events?.ended?.(reason);
    this.#emitStatus();
  }

  #emitStatus(): void {
    this.#o.events?.status?.(this.status());
  }

  #set(name: string, ms: number, fn: () => void): void {
    this.#clear(name);
    this.#timers.set(
      name,
      this.#t.setTimeout(() => {
        this.#timers.delete(name);
        fn();
      }, ms),
    );
  }

  #clear(name: string): void {
    const h = this.#timers.get(name);
    if (h !== undefined) this.#t.clearTimeout(h);
    this.#timers.delete(name);
  }

  #clearAll(): void {
    for (const name of [...this.#timers.keys()]) if (name !== "leave") this.#clear(name);
  }
}
