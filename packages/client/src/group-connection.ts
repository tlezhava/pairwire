// The relay connection of one group room (02 §8, 04 §4 Group rooms, ADR-037): one socket,
// and for each peer its own handshake, sessions, seq, acks and resends: each pair of members
// runs the pair-room protocol of 02 §4 and §6 on its own. Frames are addressed by member index.
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import {
  CLIENT_LIMITS,
  Handshake,
  HELLO_TYPE,
  makeAck,
  MAX_HELLO_FAILURES,
  MSG_TYPE,
  noticeMemberLeft,
  noticePeerChanged,
  noticePeerJoined,
  noticePeerLeft,
  noticePeerUnreadable,
  noticeWrongKey,
  openMsg,
  parseGroupRelayFrame,
  receiveDecision,
  sealMsg,
  serializeEnvelope,
  type Envelope,
  type GroupRelayFrame,
  type HelloPayload,
  type Notice,
  type Session,
} from "@pairwire/core";
import { monotonicFactory } from "ulid";
import {
  DEFAULT_TUNING,
  wsSocketFactory,
  type ConnectionOptions,
  type ConnectionStatus,
  type EndReason,
  type RelaySocket,
  type SendInput,
  type SendResult,
  type Timers,
  type Tuning,
  realTimers,
} from "./connection.js";
import { newPeer, readGroup, readGroupOutbox, updateGroup, updateGroupOutbox, type GroupFile, type GroupOutboxEntry, type GroupPeer } from "./group-files.js";
import { closeRoomLocally } from "./lifecycle.js";
import { appendInbox, hasUndeliveredNotice, type InboxEntry } from "./room-files.js";
import { expiresAt, isOpen, readState, updateState, type RoomState } from "./state.js";

type StoredSession = NonNullable<GroupPeer["sessions"]["current"]>;
const fromStored = (s: StoredSession): Session => ({ sid: hexToBytes(s.sid), sendKey: hexToBytes(s.send_key), recvKey: hexToBytes(s.recv_key) });
const toStored = (s: Session): StoredSession => ({ sid: bytesToHex(s.sid), send_key: bytesToHex(s.sendKey), recv_key: bytesToHex(s.recvKey) });

const MAX_TIMER_MS = 2 ** 31 - 1;

/** Thrown by send() when nobody else has joined the room yet (02 §8.5). */
export class NobodyJoinedError extends Error {
  override readonly name = "NobodyJoinedError";
  constructor() {
    super("Nobody else has joined the room yet, so the message was not sent.");
  }
}

type QueueItem = { t: "hello"; to: number; frame: Uint8Array } | { t: "env"; to: number; id: string } | { t: "ack"; to: number };

export class GroupConnection {
  readonly #o: ConnectionOptions;
  readonly #t: Timers;
  readonly #tune: Tuning;
  readonly #ulid: () => string;
  readonly #key: string;

  #socket: RelaySocket | null = null;
  #handshakes = new Map<number, Handshake>();
  #joined = false;
  #present = new Set<number>();
  #stopped = false;
  #halted: string | null = null;
  #attempt = 0;
  #leaving: (() => void) | null = null;
  #leaveRequested = false;
  #helloFailures = 0;
  #unreadableNoticed = new Set<number>();
  #seenEpoch = -1;
  #queue: QueueItem[] = [];
  #sentTimes: number[] = [];
  #pausedUntil = 0;
  #timers = new Map<string, unknown>();

  constructor(options: ConnectionOptions) {
    this.#o = options;
    this.#t = options.timers ?? realTimers;
    this.#tune = { ...DEFAULT_TUNING, ...options.tuning };
    this.#ulid = monotonicFactory(() => this.#t.random());
    this.#key = options.roomKey ?? options.keys.roomId;
  }

  // --- public API (as RoomConnection) --------------------------------------------------

  start(): void {
    const s = this.#state();
    if (!s || !isOpen(s)) return;
    if (this.#t.now() >= expiresAt(s)) return this.#end("expired");
    this.#halted = s.error === "wrong_key" ? "wrong_key" : null;
    if (this.#halted) return this.#emitStatus();
    this.#connect();
  }

  resume(): void {
    if (this.#halted !== "wrong_key") return;
    updateState(this.#o.home, this.#key, (s) => ({ ...s, error: null }));
    this.#halted = null;
    if (!this.#socket) this.#connect();
  }

  stop(): void {
    this.#stopped = true;
    this.#clearAll();
    this.#socket?.close(1000);
    this.#socket = null;
  }

  status(): ConnectionStatus {
    const g = this.#group();
    return {
      socket: this.#joined ? "joined" : this.#socket ? "connecting" : "offline",
      peerConnected: this.#present.size > 0,
      session: !!g && Object.values(g.peers).some((p) => !p.left && p.sessions.current !== null),
      halted: this.#halted,
    };
  }

  /** Members connected now, by index. */
  presentMembers(): number[] {
    return [...this.#present].sort((a, b) => a - b);
  }

  /** Group rooms carry no coordination kinds (02 §8.5). */
  peerHasCollab(): boolean {
    return false;
  }

  /**
   * One copy per member that has joined and not left (02 §8.5), each with that peer's next
   * seq, persisted before anything is written. Throws NobodyJoinedError when there is no one.
   */
  send(input: SendInput): SendResult {
    const s = this.#state();
    if (!s || !isOpen(s)) throw new Error("The room is not open.");
    if ("fallbackBody" in input) throw new Error("Coordination kinds are not sent in group rooms.");
    const id = this.#ulid();
    const ts = new Date(this.#t.now()).toISOString();
    const base = { v: 1 as const, id, ts, reply_to: input.reply_to ?? null, body: input.body, acks: null, author: input.author, kind: input.kind };
    serializeEnvelope({ ...base, seq: 1 } as Envelope);
    const targets: { to: number; envelope: Envelope; live: boolean }[] = [];
    updateGroup(this.#o.home, this.#key, (g) => {
      for (const [i, p] of Object.entries(g.peers)) {
        if (p.left) continue;
        p.my_seq += 1;
        targets.push({ to: Number(i), envelope: { ...base, seq: p.my_seq } as Envelope, live: p.sessions.current !== null });
      }
      return g;
    });
    if (targets.length === 0) throw new NobodyJoinedError();
    const entries: GroupOutboxEntry[] = targets.map((t) => ({ to: t.to, envelope: t.envelope, status: t.live ? "sent" : "queued", sent_at: null, delivered_at: null }));
    updateGroupOutbox(this.#o.home, this.#key, (all) => [...all, ...entries]);
    const first = targets[0]!.envelope;
    this.#o.events?.sent?.(first);
    for (const t of targets) if (t.live) this.#queue.push({ t: "env", to: t.to, id });
    this.#pump();
    const live = targets.some((t) => t.live);
    return { id, seq: first.seq, status: live ? "sent" : "queued", envelope: first, encoding: null };
  }

  /** Sends `bye` to every peer, then relay `leave`, then removes the room locally (02 §8.2). */
  async leave(message: string | null = null): Promise<void> {
    const s = this.#state();
    if (!s || !isOpen(s)) return;
    const done = new Promise<void>((resolve) => {
      this.#leaving = resolve;
      this.#set("leave", this.#tune.leaveTimeoutMs, resolve);
    });
    try {
      this.send({ kind: "bye", body: message, author: "agent" });
    } catch {
      // nobody to tell
    }
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

  notice(notice: Notice): void {
    this.#notice(notice);
  }

  // --- connection ----------------------------------------------------------------------

  #state(): RoomState | null {
    return readState(this.#o.home, this.#key);
  }

  #group(): GroupFile | null {
    try {
      return readGroup(this.#o.home, this.#key);
    } catch {
      return null;
    }
  }

  #connect(): void {
    if (this.#stopped || this.#halted) return;
    const s = this.#state();
    const g = this.#group();
    if (!s || !isOpen(s) || !g) return;
    this.#seenEpoch = s.epoch ?? -1;
    this.#handshakes.clear();
    this.#helloFailures = 0;
    this.#joined = false;
    this.#present.clear();
    const factory = this.#o.socketFactory ?? wsSocketFactory;
    let socket: RelaySocket | null = null;
    const current = () => socket !== null && socket === this.#socket;
    socket = factory(this.#o.url, {
      onOpen: () =>
        this.#guard(current, "open", () => {
          const st = this.#state();
          const gr = this.#group();
          const token = st?.token ?? null;
          const creating = token === null && gr?.starter === true && gr.capacity !== null;
          socket!.sendText(JSON.stringify({ t: "join", v: 2, token, ...(creating ? { capacity: gr.capacity } : {}) }));
          this.#schedulePing();
        }),
      onText: (d) => this.#guard(current, "text", () => this.#onText(d)),
      onBinary: (d) => this.#guard(current, "binary", () => this.#onBinary(d)),
      onClose: (code) => this.#guard(current, "close", () => this.#onClose(code)),
    });
    this.#socket = socket;
    this.#emitStatus();
  }

  #guard(current: () => boolean, on: "open" | "text" | "binary" | "close", fn: () => void): void {
    if (!current()) return;
    try {
      fn();
    } catch (e) {
      this.#o.log.warn("relay_handler_failed", { on, error: e instanceof Error ? e.name : typeof e });
      try {
        if (on !== "close" && current()) this.#relayProtocolError("handler_failed");
        else if (on === "close" && !this.#socket) this.#scheduleReconnect();
      } catch {
        // already logged
      }
    }
  }

  #relayProtocolError(reason: string, fields: Record<string, string | number | null> = {}): void {
    this.#o.log.warn("relay_protocol_error", { reason, ...fields });
    const socket = this.#socket;
    try {
      this.#onClose(1002);
    } finally {
      socket?.close(1002);
    }
  }

  #schedulePing(): void {
    this.#set("ping", this.#tune.pingIntervalMs, () => {
      this.#socket?.sendText('{"t":"ping"}');
      this.#schedulePing();
    });
  }

  #onText(data: string): void {
    const parsed = parseGroupRelayFrame(data);
    if (!parsed.ok) {
      if (parsed.reason === "unknown_type") return;
      return this.#relayProtocolError("bad_frame", { frame: parsed.t, fields: parsed.fields.join(",") });
    }
    const frame = parsed.frame;
    switch (frame.t) {
      case "joined":
        return this.#onJoined(frame);
      case "peer_joined":
        return this.#onPeerJoined(frame.member, frame.epoch);
      case "peer_left":
        return this.#onPeerLeft(frame.member, frame.reason);
      case "error": {
        this.#o.log.warn("relay_error", { code: frame.code });
        if (frame.code === "rate_limited" || frame.code === "buffer_full") {
          const retry = frame.retry_after !== undefined ? frame.retry_after * 1000 : this.#tune.defaultRetryMs;
          this.#pausedUntil = this.#t.now() + retry;
          this.#set("retry", retry, () => this.#resendAll());
        }
        return;
      }
      case "pong":
        return;
    }
  }

  #raiseEpoch(epoch: number, change: (s: RoomState) => RoomState = (s) => s): void {
    this.#seenEpoch = epoch;
    updateState(this.#o.home, this.#key, (s) => ({ ...change(s), epoch: Math.max(s.epoch ?? -1, epoch) }));
  }

  #onJoined(frame: Extract<GroupRelayFrame, { t: "joined" }>): void {
    if (frame.epoch <= this.#seenEpoch) {
      this.#attempt = 0;
      return this.#relayProtocolError("epoch_rollback", { epoch: frame.epoch, floor: this.#seenEpoch });
    }
    const before = this.#group();
    if (before?.member !== null && before?.member !== undefined && before.member !== frame.member) {
      return this.#relayProtocolError("member_changed");
    }
    if (before?.capacity !== null && before?.capacity !== undefined && before.capacity !== frame.capacity) {
      return this.#relayProtocolError("capacity_changed");
    }
    this.#raiseEpoch(frame.epoch, (s) => ({ ...s, token: frame.token, expires_at: frame.expires_at }));
    // Peers retired while we were away no longer appear in `taken` (02 §8.2).
    const gone: string[] = [];
    updateGroup(this.#o.home, this.#key, (g) => {
      g.member = frame.member;
      g.capacity = frame.capacity;
      for (const i of frame.taken) g.peers[String(i)] ??= newPeer();
      for (const [i, p] of Object.entries(g.peers)) {
        if (!p.left && !frame.taken.includes(Number(i))) {
          p.left = true;
          if (p.name !== null) gone.push(p.name);
        }
      }
      return g;
    });
    for (const name of gone) this.#notice(noticeMemberLeft(name));
    this.#joined = true;
    this.#attempt = 0;
    this.#present = new Set(frame.present);
    this.#scheduleExpiry();
    this.#scheduleResendCheck();
    this.#o.log.info("joined", { epoch: frame.epoch, present: frame.present.length, buffered: frame.buffered });
    this.#emitStatus();
    if (this.#leaveRequested) return this.#sendLeaveWhenDrained();
    for (const m of frame.present) this.#startEpoch(m, frame.epoch);
    this.#sendNeverSent();
  }

  #onPeerJoined(member: number, epoch: number): void {
    const g = this.#group();
    if (!this.#joined || epoch <= this.#seenEpoch || !g || member === g.member || g.capacity === null || member >= g.capacity) {
      return this.#relayProtocolError("epoch_order", { epoch, seen: this.#seenEpoch });
    }
    this.#raiseEpoch(epoch);
    updateGroup(this.#o.home, this.#key, (gr) => {
      gr.peers[String(member)] ??= newPeer();
      return gr;
    });
    this.#present.add(member);
    this.#emitStatus();
    this.#startEpoch(member, epoch);
  }

  #onPeerLeft(member: number, reason: "disconnected" | "left"): void {
    this.#present.delete(member);
    if (reason === "left") {
      let name: string | null = null;
      let already = true;
      updateGroup(this.#o.home, this.#key, (g) => {
        const p = g.peers[String(member)];
        if (p && !p.left) {
          already = false;
          p.left = true;
          p.sessions = { current: null, previous: null };
          name = p.name;
        }
        return g;
      });
      this.#handshakes.delete(member);
      this.#queue = this.#queue.filter((q) => q.to !== member);
      // Copies to a member who left can never be delivered.
      updateGroupOutbox(this.#o.home, this.#key, (entries) => entries.filter((e) => e.to !== member || e.status === "delivered"));
      if (!already && name !== null) this.#notice(noticeMemberLeft(name));
    }
    this.#emitStatus();
  }

  #handshakeFor(member: number): Handshake | null {
    const g = this.#group();
    if (!g || g.member === null) return null;
    let h = this.#handshakes.get(member);
    if (!h) {
      h = new Handshake({ keys: this.#o.keys, payload: this.#o.hello, floor: this.#state()?.epoch ?? -1, pair: { me: g.member, peer: member } });
      // The floor is the room's highest epoch, which is also this event's: start just below it.
      this.#handshakes.set(member, h);
    }
    return h;
  }

  #startEpoch(member: number, epoch: number): void {
    const g = this.#group();
    if (!g || g.member === null) return;
    // A fresh handshake per event: its floor is below `epoch` (02 §8.4).
    const h = new Handshake({ keys: this.#o.keys, payload: this.#o.hello, floor: epoch - 1, pair: { me: g.member, peer: member } });
    this.#handshakes.set(member, h);
    const hello = h.startEpoch(epoch);
    if (!hello) return;
    this.#queue.unshift({ t: "hello", to: member, frame: hello });
    this.#pump();
  }

  #onBinary(data: Uint8Array): void {
    const g = this.#group();
    const from = data[0];
    if (!g || g.member === null || g.capacity === null || from === undefined || from === g.member || from >= g.capacity || data.length < 2) {
      return this.#o.log.debug("frame_dropped", { reason: "bad_address" });
    }
    const frame = data.subarray(1);
    if (frame[0] === HELLO_TYPE) {
      const h = this.#handshakes.get(from) ?? this.#handshakeFor(from);
      if (!h) return;
      const ev = h.receive(frame);
      if (ev.type === "session") return this.#onSession(from, ev.session, ev.peer);
      this.#o.log.debug("hello_dropped", { reason: ev.reason });
      if (ev.reason === "decrypt_failed" && ++this.#helloFailures === MAX_HELLO_FAILURES) this.#onWrongKey();
      return;
    }
    if (frame[0] !== MSG_TYPE) return this.#o.log.debug("frame_dropped", { reason: "unknown_type" });
    const peer = g.peers[String(from)];
    if (!peer || peer.left) return this.#o.log.debug("frame_dropped", { reason: "unknown_peer" });
    const sessions = [peer.sessions.current, peer.sessions.previous].filter((x): x is StoredSession => x !== null).map(fromStored);
    const opened = openMsg(frame, { roomIdBytes: this.#o.keys.roomIdBytes, sessions });
    if (!opened.ok) {
      if (opened.skipSeq !== undefined) return this.#onUnreadable(from, opened.skipSeq, opened.reason);
      return this.#o.log.debug("frame_dropped", { reason: opened.reason });
    }
    this.#onEnvelope(from, opened.envelope);
  }

  #onSession(from: number, session: Session, hello: HelloPayload): void {
    let before: GroupPeer | null = null;
    updateGroup(this.#o.home, this.#key, (g) => {
      const p = (g.peers[String(from)] ??= newPeer());
      before = structuredClone(p);
      p.sessions = { current: toStored(session), previous: p.sessions.current };
      p.name = hello.name;
      p.harness = hello.harness;
      p.instance = hello.instance;
      p.caps = [...new Set(hello.caps.filter((c) => c.length <= 32))].slice(0, 16);
      p.left = false;
      return g;
    });
    updateState(this.#o.home, this.#key, (s) => ({ ...s, status: "active" }));
    const was = before as GroupPeer | null;
    this.#o.log.info("session", { first: was?.instance === null });
    if (!was || was.instance === null || was.name === null || was.harness === null) {
      this.#notice(noticePeerJoined(hello.name, hello.harness));
    } else if (was.instance !== hello.instance || was.name !== hello.name) {
      const notice = noticePeerChanged({ name: was.name, harness: was.harness }, hello);
      this.#o.log.warn("peer_changed");
      this.#o.events?.peerChanged?.(notice);
      if (!hasUndeliveredNotice(this.#o.home, this.#key, "peer_changed")) this.#notice(notice);
    }
    this.#emitStatus();
    this.#resendFor(from);
  }

  #onEnvelope(from: number, env: Envelope): void {
    const peer = this.#group()?.peers[String(from)];
    if (!peer) return;
    const decision = receiveDecision(env, peer.peer_max_seq);
    if (decision === "ack") return this.#onAck(from, env.acks ?? 0);
    if (decision === "out_of_order") return this.#o.log.debug("frame_dropped", { reason: "out_of_order", seq: env.seq });
    if (decision === "accept") {
      const entry: InboxEntry = {
        source: "peer",
        id: env.id,
        from: peer.name ?? "",
        harness: peer.harness ?? "other",
        received_at: this.#t.now(),
        envelope: env,
      };
      const added = appendInbox(this.#o.home, this.#key, entry);
      this.#setPeerMaxSeq(from, env.seq);
      if (added) this.#o.events?.inbound?.(entry);
    }
    this.#scheduleAck(from);
  }

  #setPeerMaxSeq(from: number, seq: number): void {
    updateGroup(this.#o.home, this.#key, (g) => {
      const p = g.peers[String(from)];
      if (p) p.peer_max_seq = Math.max(p.peer_max_seq, seq);
      return g;
    });
  }

  #onUnreadable(from: number, seq: number, reason: string): void {
    const peer = this.#group()?.peers[String(from)];
    if (!peer) return;
    this.#o.log.info("frame_skipped", { reason, seq });
    if (seq > peer.peer_max_seq + 1) return;
    if (seq === peer.peer_max_seq + 1) {
      this.#setPeerMaxSeq(from, seq);
      if (!this.#unreadableNoticed.has(from)) {
        this.#unreadableNoticed.add(from);
        this.#notice(noticePeerUnreadable(peer.name ?? ""));
      }
    }
    this.#scheduleAck(from);
  }

  #onAck(from: number, acks: number): void {
    const now = this.#t.now();
    const newly = new Set<string>();
    const after = updateGroupOutbox(this.#o.home, this.#key, (entries) =>
      entries.map((e) => {
        if (e.to !== from || e.status === "delivered" || e.envelope.seq > acks) return e;
        newly.add(e.envelope.id);
        return { ...e, status: "delivered", delivered_at: now };
      }),
    );
    // A message is delivered once every copy is (04 §4, Group rooms).
    const ids = [...newly].filter((id) => after.every((e) => e.envelope.id !== id || e.status === "delivered"));
    if (ids.length > 0) this.#o.events?.delivered?.(ids);
  }

  #scheduleAck(to: number): void {
    const name = `ack:${to}`;
    if (this.#timers.has(name)) return;
    this.#set(name, this.#tune.ackDelayMs, () => {
      this.#queue.push({ t: "ack", to });
      this.#pump();
    });
  }

  #onWrongKey(): void {
    this.#o.log.warn("wrong_key");
    updateState(this.#o.home, this.#key, (s) => ({ ...s, error: "wrong_key" }));
    this.#halted = "wrong_key";
    this.#notice(noticeWrongKey());
    this.#socket?.close(1000);
  }

  #onClose(code: number): void {
    this.#socket = null;
    this.#joined = false;
    this.#present.clear();
    this.#queue = [];
    for (const name of [...this.#timers.keys()]) if (name !== "reconnect" && name !== "leave") this.#clear(name);
    this.#o.log.info("closed", { code });
    if (this.#leaving) return this.#leaving();
    switch (code) {
      case 4001:
        return this.#end("room_full");
      case 4002:
      case 4003:
        return this.#end("gone");
      case 4004:
        // The relay hosts no group rooms, or this isn't one (04 §4, Group rooms).
        return this.#end("unsupported");
      case 4005:
        return this.#halt("protocol_error");
      case 4007:
        return this.#halt("replaced");
      default:
        this.#emitStatus();
        return this.#scheduleReconnect();
    }
  }

  #halt(reason: string): void {
    this.#halted = reason;
    if (reason !== "replaced") updateState(this.#o.home, this.#key, (s) => ({ ...s, error: reason }));
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
    if (wait > MAX_TIMER_MS) return;
    this.#set("expiry", wait, () => this.#end("expired"));
  }

  /** 02 §6.2 rule (b), per peer: resend when its oldest unacked copy is old and it is here. */
  #scheduleResendCheck(): void {
    const every = Math.max(50, Math.min(1000, Math.floor(this.#tune.resendAfterMs / 3)));
    this.#set("resend", every, () => {
      const now = this.#t.now();
      const entries = readGroupOutbox(this.#o.home, this.#key);
      for (const to of this.#present) {
        const oldest = entries.find((e) => e.to === to && e.status !== "delivered" && e.sent_at !== null);
        if (oldest?.sent_at != null && now - oldest.sent_at >= this.#tune.resendAfterMs) this.#resendFor(to);
      }
      this.#scheduleResendCheck();
    });
  }

  #queuedIds(to: number): Set<string> {
    return new Set(this.#queue.flatMap((q) => (q.t === "env" && q.to === to ? [q.id] : [])));
  }

  #resendFor(to: number): void {
    const queued = this.#queuedIds(to);
    for (const e of readGroupOutbox(this.#o.home, this.#key)) {
      if (e.to === to && e.status !== "delivered" && !queued.has(e.envelope.id)) this.#queue.push({ t: "env", to, id: e.envelope.id });
    }
    this.#pump();
  }

  #resendAll(): void {
    for (const to of new Set(readGroupOutbox(this.#o.home, this.#key).map((e) => e.to))) this.#resendFor(to);
  }

  #sendNeverSent(): void {
    const g = this.#group();
    for (const e of readGroupOutbox(this.#o.home, this.#key)) {
      if (e.status === "delivered" || e.sent_at !== null) continue;
      if (!g?.peers[String(e.to)]?.sessions.current) continue;
      if (!this.#queuedIds(e.to).has(e.envelope.id)) this.#queue.push({ t: "env", to: e.to, id: e.envelope.id });
    }
    this.#pump();
  }

  /** Writes queued frames while the rolling window allows: 8 × (capacity − 1) per 10 s (02 §8.5). */
  #pump(): void {
    this.#clear("pump");
    if (!this.#socket || !this.#joined) return;
    const now = this.#t.now();
    if (now < this.#pausedUntil) return this.#set("pump", this.#pausedUntil - now, () => this.#pump());
    this.#sentTimes = this.#sentTimes.filter((at) => now - at < this.#tune.windowMs);
    const g = this.#group();
    const limit = this.#tune.framesPerWindow * Math.max(1, (g?.capacity ?? 2) - 1);
    const outbox = readGroupOutbox(this.#o.home, this.#key);
    const sent: { to: number; id: string }[] = [];

    while (this.#queue.length > 0 && this.#sentTimes.length < limit) {
      const item = this.#queue.shift()!;
      const peer = g?.peers[String(item.to)];
      const session = peer?.sessions.current ? fromStored(peer.sessions.current) : null;
      let frame: Uint8Array | null = null;
      if (item.t === "hello") frame = item.frame;
      else if (session && item.t === "ack") {
        frame = sealMsg({ roomIdBytes: this.#o.keys.roomIdBytes, session, envelope: makeAck(peer!.peer_max_seq, this.#ulid(), new Date(now).toISOString()) });
        this.#clear(`ack:${item.to}`);
      } else if (session && item.t === "env") {
        const entry = outbox.find((e) => e.to === item.to && e.envelope.id === item.id);
        if (entry && entry.status !== "delivered") {
          frame = sealMsg({ roomIdBytes: this.#o.keys.roomIdBytes, session, envelope: entry.envelope });
          sent.push({ to: item.to, id: item.id });
        }
      }
      if (!frame) continue;
      const addressed = new Uint8Array(frame.length + 1);
      addressed[0] = item.to;
      addressed.set(frame, 1);
      this.#socket.sendBinary(addressed);
      this.#sentTimes.push(this.#t.now());
    }

    if (sent.length > 0) {
      const keys = new Set(sent.map((x) => `${x.to}:${x.id}`));
      updateGroupOutbox(this.#o.home, this.#key, (entries) =>
        entries.map((e) => (keys.has(`${e.to}:${e.envelope.id}`) && e.status !== "delivered" ? { ...e, status: "sent", sent_at: now } : e)),
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
    else this.#pump();
  }

  #notice(notice: Notice): void {
    const entry: InboxEntry = { source: "local", id: this.#ulid(), event: notice.event, text: notice.text, received_at: this.#t.now() };
    appendInbox(this.#o.home, this.#key, entry);
    this.#o.events?.inbound?.(entry);
  }

  #end(reason: EndReason): void {
    const s = this.#state();
    this.#stopped = true;
    this.#clearAll();
    this.#socket?.close(1000);
    this.#socket = null;
    if (!s || !isOpen(s)) return;
    if (reason === "expired" || reason === "gone") this.#notice(noticePeerLeft("", "expired"));
    const error = reason === "left" ? null : reason === "unsupported" ? "unsupported_version" : reason;
    closeRoomLocally(this.#o.home, this.#key, reason === "left" ? "left" : "ended", error);
    this.#o.log.info("room_ended", { reason });
    this.#o.events?.ended?.(reason);
    this.#emitStatus();
  }

  #emitStatus(): void {
    this.#o.events?.status?.(this.status());
  }

  #set(name: string, ms: number, fn: () => void): void {
    this.#clear(name);
    const delay = Number.isNaN(ms) ? MAX_TIMER_MS : Math.min(MAX_TIMER_MS, Math.max(0, ms));
    this.#timers.set(
      name,
      this.#t.setTimeout(() => {
        this.#timers.delete(name);
        fn();
      }, delay),
    );
  }

  #clear(name: string): void {
    const h = this.#timers.get(name);
    if (h !== undefined) {
      this.#t.clearTimeout(h);
      this.#timers.delete(name);
    }
  }

  #clearAll(): void {
    for (const name of [...this.#timers.keys()]) this.#clear(name);
  }
}

/** For tests and status: the default pacing window per peer. */
export const GROUP_FRAMES_PER_PEER_PER_10S = CLIENT_LIMITS.binaryFramesPer10s;
