// Node relay (03, Node implementation): the shared RelayRoom state machine behind an HTTP
// server and the `ws` package. State is in memory, optionally saved to a RoomStore
// (03, Persistence); timers replace Durable Object alarms. Relay-wide caps bound sockets,
// rooms, buffered bytes and each socket's send queue (03, Relay-wide limits).
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { CLOSE, RelayRoom, relayInfo, type Output, type RoomState } from "@pairwire/core";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { DEFAULT_CAPS, type RelayCaps } from "./caps.js";
import { systemClock, type Clock } from "./clock.js";
import { createLogger, roomTag, type Logger } from "./log.js";
import type { RoomStore } from "./store.js";

const ROOM_PATH = /^\/v1\/rooms\/([^/]*)$/;
const ROOM_ID = /^[a-z2-7]{26}$/;
/** Above the 64 KiB limit so oversized frames get `error too_large` instead of a ws close. */
const MAX_PAYLOAD = 256 * 1024;
/** At most one `limit_refused` line per cap per minute. */
const REFUSAL_LOG_MS = 60_000;

export interface RelayServerOptions {
  port?: number;
  host?: string;
  clock?: Clock;
  log?: Logger;
  version?: string;
  /** Saves room state across restarts; the caller opens and closes it. */
  store?: RoomStore;
  /** Relay-wide limits; anything left out takes its default. */
  caps?: Partial<RelayCaps>;
}

export interface RelayServer {
  listen(): Promise<{ port: number }>;
  close(): Promise<void>;
}

interface RoomEntry {
  room: RelayRoom;
  sockets: Map<string, WebSocket>;
  cancelAlarm: (() => void) | null;
  /** This room's share of `bufferedTotal`, as of its last output. */
  bufferedBytes: number;
}

type CapName = "sockets" | "sockets_per_address" | "rooms" | "buffered_bytes";

export function createRelayServer(options: RelayServerOptions = {}): RelayServer {
  const clock = options.clock ?? systemClock;
  const log = options.log ?? createLogger();
  const version = options.version ?? "0.0.0";
  const store = options.store;
  const caps: RelayCaps = { ...DEFAULT_CAPS, ...options.caps };
  const under = (cap: number, value: number) => cap === 0 || value < cap;
  const rooms = new Map<string, RoomEntry>();
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });
  let seq = 0;
  let closed = false;
  let socketCount = 0;
  /** Open sockets per client address. Addresses stay in memory and are never logged (03, Logging). */
  const perAddress = new Map<string, number>();
  let bufferedTotal = 0;
  const refusals = new Map<CapName, { count: number; loggedAt: number | null }>();

  const http: Server = createServer((req, res) => handleHttp(req, res));
  http.on("upgrade", (req, socket, head) => handleUpgrade(req, socket, head));

  function handleHttp(req: IncomingMessage, res: ServerResponse): void {
    const path = (req.url ?? "/").split("?")[0];
    const reply = (status: number, body: string, type = "text/plain") => {
      res.writeHead(status, { "content-type": type });
      res.end(body);
    };
    if (req.method === "GET" && path === "/health") return reply(200, "ok");
    if (req.method === "GET" && path === "/v1/info") return reply(200, JSON.stringify(relayInfo(version)), "application/json");
    const room = path?.match(ROOM_PATH);
    if (room) return reply(ROOM_ID.test(room[1]!) ? 426 : 400, ROOM_ID.test(room[1]!) ? "upgrade required" : "bad room id");
    reply(404, "not found");
  }

  function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const path = (req.url ?? "/").split("?")[0];
    const match = path?.match(ROOM_PATH);
    const refuse = (status: number, text: string) => {
      socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    };
    if (!match) return refuse(404, "Not Found");
    const roomId = match[1]!;
    if (!ROOM_ID.test(roomId)) return refuse(400, "Bad Request");
    const address = clientAddress(req, caps.trustProxy);
    const full: CapName | null = !under(caps.maxSockets, socketCount)
      ? "sockets"
      : !under(caps.maxSocketsPerAddress, perAddress.get(address) ?? 0)
        ? "sockets_per_address"
        : !rooms.has(roomId) && !under(caps.maxRooms, rooms.size)
          ? "rooms"
          : null;
    if (full) {
      refused(full);
      return refuse(503, "Service Unavailable");
    }
    wss.handleUpgrade(req, socket, head, (ws) => attach(roomId, ws, address));
  }

  /** Counts a refusal and logs it unless this cap was logged in the last minute. */
  function refused(cap: CapName): void {
    const r = refusals.get(cap) ?? { count: 0, loggedAt: null };
    refusals.set(cap, r);
    r.count++;
    const now = clock.now();
    if (r.loggedAt !== null && now - r.loggedAt < REFUSAL_LOG_MS) return;
    log.warn("limit_refused", { limit: cap, count: r.count });
    r.count = 0;
    r.loggedAt = now;
  }

  function newEntry(state: RoomState | null = null): RoomEntry {
    const admitBuffered = (bytes: number) => {
      if (caps.maxBufferedBytes === 0 || bufferedTotal + bytes <= caps.maxBufferedBytes) return true;
      refused("buffered_bytes");
      return false;
    };
    const room = new RelayRoom({ now: () => clock.now(), state, admitBuffered });
    return { room, sockets: new Map(), cancelAlarm: null, bufferedBytes: 0 };
  }

  function entryFor(roomId: string): RoomEntry {
    let entry = rooms.get(roomId);
    if (!entry) {
      entry = newEntry();
      rooms.set(roomId, entry);
    }
    return entry;
  }

  function attach(roomId: string, ws: WebSocket, address: string): void {
    const entry = entryFor(roomId);
    const id = `c${seq++}`;
    entry.sockets.set(id, ws);
    socketCount++;
    perAddress.set(address, (perAddress.get(address) ?? 0) + 1);
    ws.on("message", (data: RawData, isBinary: boolean) => {
      if (!entry.sockets.has(id)) return;
      const bytes = toBytes(data);
      apply(roomId, entry, isBinary ? entry.room.binary(id, bytes) : entry.room.text(id, new TextDecoder().decode(bytes)));
    });
    ws.on("close", () => {
      socketCount--;
      const left = (perAddress.get(address) ?? 1) - 1;
      if (left > 0) perAddress.set(address, left);
      else perAddress.delete(address);
      if (!entry.sockets.delete(id)) return; // we closed it ourselves; the room already knows
      apply(roomId, entry, entry.room.disconnect(id));
    });
    ws.on("error", () => ws.terminate());
    apply(roomId, entry, entry.room.connect(id));
  }

  function apply(roomId: string, entry: RoomEntry, out: Output): void {
    if (closed) return; // sockets dropped by close() change nothing on disk
    const bytes = entry.room.bufferedBytes();
    bufferedTotal += bytes - entry.bufferedBytes;
    entry.bufferedBytes = bytes;
    // Save before sending, so no member sees a token that isn't stored yet. A failed write
    // is logged and the room keeps running from memory (03, Persistence).
    if (store && (out.persist || out.deleteAll)) {
      try {
        if (entry.room.state && !out.deleteAll) store.save(roomId, entry.room.state);
        else store.delete(roomId);
      } catch {
        log.warn("state_write_failed", { room: roomTag(roomId) });
      }
    }
    const overloaded: string[] = [];
    for (const e of out.effects) {
      const ws = entry.sockets.get(e.socket);
      if (!ws) continue;
      if (e.type === "send") {
        const size = typeof e.data === "string" ? Buffer.byteLength(e.data) : e.data.byteLength;
        if (caps.maxOutboundBytes > 0 && ws.bufferedAmount + size > caps.maxOutboundBytes) {
          // Not reading: drop the frame and the socket (the sender's client resends unacked frames).
          entry.sockets.delete(e.socket);
          ws.close(CLOSE.overloaded, "overloaded");
          log.info("close", { code: CLOSE.overloaded, room: roomTag(roomId) });
          overloaded.push(e.socket);
          continue;
        }
        ws.send(e.data, { binary: typeof e.data !== "string" });
      } else {
        entry.sockets.delete(e.socket);
        ws.close(e.code, e.reason);
        log.info("close", { code: e.code, room: roomTag(roomId) });
      }
    }
    if (out.deleteAll) log.info("room_deleted", { room: roomTag(roomId) });
    if (overloaded.length > 0) {
      // Each counts as a disconnect. The room's alarm time covers the whole room, so the last
      // of these outputs arms the timer and decides whether the room is forgotten.
      for (const id of overloaded) apply(roomId, entry, entry.room.disconnect(id));
      return;
    }
    entry.cancelAlarm?.();
    entry.cancelAlarm = null;
    if (out.alarmAt !== null) {
      entry.cancelAlarm = clock.schedule(out.alarmAt, () => {
        entry.cancelAlarm = null;
        apply(roomId, entry, entry.room.alarm());
      });
    }
    // An empty room with no state and no timer has nothing left to remember.
    if (entry.room.state === null && entry.sockets.size === 0 && entry.cancelAlarm === null) rooms.delete(roomId);
  }

  /**
   * Loads saved rooms. A slot saved as connected lost its socket to the restart: that counts
   * as a disconnect now. One alarm() per room applies what fell due while the relay was down
   * and arms the next timer.
   */
  function restore(from: RoomStore): void {
    const { rooms: saved, dropped } = from.load();
    const now = clock.now();
    for (const [roomId, state] of saved) {
      if (!state.ended && Object.values(state.slots).some((slot) => slot.connected)) {
        state.lastActivityAt = Math.max(state.lastActivityAt, now);
      }
      const entry = newEntry(state);
      rooms.set(roomId, entry);
      apply(roomId, entry, { ...entry.room.alarm(), persist: true });
    }
    log.info("state_loaded", { rooms: saved.size, dropped });
    if (dropped > 0) log.warn("state_dropped", { rooms: dropped });
  }

  if (store) restore(store);

  return {
    listen() {
      const port = options.port ?? 8787;
      const host = options.host ?? "0.0.0.0";
      return new Promise((resolve, reject) => {
        http.once("error", reject);
        http.listen(port, host, () => {
          const actual = (http.address() as AddressInfo).port;
          log.info("listening", { port: actual });
          log.info("limits", {
            max_sockets: caps.maxSockets,
            max_sockets_per_address: caps.maxSocketsPerAddress,
            max_rooms: caps.maxRooms,
            max_buffered_bytes: caps.maxBufferedBytes,
            max_outbound_bytes: caps.maxOutboundBytes,
            trust_proxy: caps.trustProxy,
          });
          if (!isLoopback(host) && process.env.PAIRWIRE_RELAY_INSECURE_OK === undefined) {
            log.warn("tls_reminder", {
              message:
                "pairwire clients require wss://. Put this relay behind a TLS-terminating proxy, or set PAIRWIRE_RELAY_INSECURE_OK=1 to silence this warning.",
            });
          }
          resolve({ port: actual });
        });
      });
    },
    async close() {
      closed = true;
      for (const entry of rooms.values()) {
        entry.cancelAlarm?.();
        for (const ws of entry.sockets.values()) ws.terminate();
      }
      rooms.clear();
      wss.close();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}

function toBytes(data: RawData): Uint8Array {
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice();
}

/** The address the per-address cap counts: the TCP peer, or the proxy's last X-Forwarded-For entry. */
function clientAddress(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const header = req.headers["x-forwarded-for"];
    const last = (Array.isArray(header) ? header.join(",") : header)?.split(",").pop()?.trim();
    if (last) return last;
  }
  return req.socket.remoteAddress ?? "unknown";
}

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}
