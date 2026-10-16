// Node relay (03, Node implementation): the shared RelayRoom state machine behind an HTTP
// server and the `ws` package. State is in memory, optionally saved to a RoomStore
// (03, Persistence); timers replace Durable Object alarms.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { RelayRoom, relayInfo, type Output } from "@pairwire/core";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { systemClock, type Clock } from "./clock.js";
import { createLogger, roomTag, type Logger } from "./log.js";
import type { RoomStore } from "./store.js";

const ROOM_PATH = /^\/v1\/rooms\/([^/]*)$/;
const ROOM_ID = /^[a-z2-7]{26}$/;
/** Above the 64 KiB limit so oversized frames get `error too_large` instead of a ws close. */
const MAX_PAYLOAD = 256 * 1024;

export interface RelayServerOptions {
  port?: number;
  host?: string;
  clock?: Clock;
  log?: Logger;
  version?: string;
  /** Saves room state across restarts; the caller opens and closes it. */
  store?: RoomStore;
}

export interface RelayServer {
  listen(): Promise<{ port: number }>;
  close(): Promise<void>;
}

interface RoomEntry {
  room: RelayRoom;
  sockets: Map<string, WebSocket>;
  cancelAlarm: (() => void) | null;
}

export function createRelayServer(options: RelayServerOptions = {}): RelayServer {
  const clock = options.clock ?? systemClock;
  const log = options.log ?? createLogger();
  const version = options.version ?? "0.0.0";
  const store = options.store;
  const rooms = new Map<string, RoomEntry>();
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });
  let seq = 0;
  let closed = false;

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
    wss.handleUpgrade(req, socket, head, (ws) => attach(roomId, ws));
  }

  function entryFor(roomId: string): RoomEntry {
    let entry = rooms.get(roomId);
    if (!entry) {
      entry = { room: new RelayRoom({ now: () => clock.now() }), sockets: new Map(), cancelAlarm: null };
      rooms.set(roomId, entry);
    }
    return entry;
  }

  function attach(roomId: string, ws: WebSocket): void {
    const entry = entryFor(roomId);
    const id = `c${seq++}`;
    entry.sockets.set(id, ws);
    ws.on("message", (data: RawData, isBinary: boolean) => {
      if (!entry.sockets.has(id)) return;
      const bytes = toBytes(data);
      apply(roomId, entry, isBinary ? entry.room.binary(id, bytes) : entry.room.text(id, new TextDecoder().decode(bytes)));
    });
    ws.on("close", () => {
      if (!entry.sockets.delete(id)) return; // we closed it ourselves; the room already knows
      apply(roomId, entry, entry.room.disconnect(id));
    });
    ws.on("error", () => ws.terminate());
    apply(roomId, entry, entry.room.connect(id));
  }

  function apply(roomId: string, entry: RoomEntry, out: Output): void {
    if (closed) return; // sockets dropped by close() change nothing on disk
    // Save before sending, so no member sees a token that isn't stored yet.
    if (store && (out.persist || out.deleteAll)) {
      try {
        if (entry.room.state && !out.deleteAll) store.save(roomId, entry.room.state);
        else store.delete(roomId);
      } catch {
        log.warn("state_write_failed", { room: roomTag(roomId) });
      }
    }
    for (const e of out.effects) {
      const ws = entry.sockets.get(e.socket);
      if (!ws) continue;
      if (e.type === "send") {
        ws.send(e.data, { binary: typeof e.data !== "string" });
      } else {
        entry.sockets.delete(e.socket);
        ws.close(e.code, e.reason);
        log.info("close", { code: e.code, room: roomTag(roomId) });
      }
    }
    if (out.deleteAll) log.info("room_deleted", { room: roomTag(roomId) });
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
      const entry: RoomEntry = { room: new RelayRoom({ now: () => clock.now(), state }), sockets: new Map(), cancelAlarm: null };
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

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}
