// Two clients against a real relay-node on a random port (07-testing.md, client and e2e).
import { join } from "node:path";
import { base32Encode, deriveRoomKeys, generateSecret, RELAY_LIMITS, type RoomKeys } from "@pairwire/core";
import { randomBytes } from "@noble/hashes/utils.js";
import { afterEach } from "vitest";
import { createLogger as relayLogger } from "../../../relay-node/src/log.js";
import type { Clock } from "../../../relay-node/src/clock.js";
import { createRelayServer, type RelayServer } from "../../../relay-node/src/server.js";
import { RoomConnection, wsSocketFactory, type ConnectionEvents, type SocketFactory, type Tuning } from "../../src/connection.js";
import { createLogger } from "../../src/log.js";
import { readInbox, readOutbox, type InboxEntry } from "../../src/room-files.js";
import { createRoom, readState } from "../../src/state.js";
import { tempDir } from "../state/helpers.js";

export const FAST: Partial<Tuning> = {
  pingIntervalMs: 60_000,
  ackDelayMs: 30,
  resendAfterMs: 400,
  backoffMinMs: 50,
  backoffMaxMs: 200,
  defaultRetryMs: 200,
  leaveTimeoutMs: 2000,
};

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

/** A clock running `offsetMs` behind real time, so `expires_at` falls `offsetMs` early. */
export function shiftedClock(offsetMs: number): Clock {
  return {
    now: () => Date.now() - offsetMs,
    schedule(at, fn) {
      const t = setTimeout(fn, Math.max(0, at - (Date.now() - offsetMs)));
      return () => clearTimeout(t);
    },
  };
}

export async function startRelay(clock?: Clock): Promise<{ port: number; server: RelayServer }> {
  const server = createRelayServer({ port: 0, host: "127.0.0.1", log: relayLogger(() => {}), ...(clock ? { clock } : {}) });
  const { port } = await server.listen();
  cleanups.push(() => server.close());
  return { port, server };
}

export interface Client {
  name: string;
  home: string;
  keys: RoomKeys;
  conn: RoomConnection;
  events: { inbound: InboxEntry[]; delivered: string[]; ended: string[] };
  frames: { sent: { at: number; type: number }[] };
  inbox: () => InboxEntry[];
  outbox: () => ReturnType<typeof readOutbox>;
  state: () => NonNullable<ReturnType<typeof readState>>;
  restart: (opts?: ClientOptions) => Client;
}

export interface ClientOptions {
  tuning?: Partial<Tuning>;
  /** Wraps the real socket factory, e.g. to drop or duplicate frames. */
  wrap?: (inner: SocketFactory) => SocketFactory;
  /** Reuse an existing home (restart) instead of creating the room. */
  home?: string;
  /** Different keys than the room's (wrong-key tests). */
  keys?: RoomKeys;
}

export function makeClient(name: string, port: number, secret: Uint8Array, opts: ClientOptions = {}): Client {
  const realKeys = deriveRoomKeys(secret);
  const keys = opts.keys ?? realKeys;
  const home = opts.home ?? join(tempDir(), ".pairwire");
  if (!opts.home) createRoom(home, { roomId: realKeys.roomId, secret, relay: `127.0.0.1:${port}`, name, now: Date.now() }, {});
  const instance = readState(home, realKeys.roomId)!.instance;
  const events: Client["events"] = { inbound: [], delivered: [], ended: [] };
  const frames: Client["frames"] = { sent: [] };
  const recordSends: SocketFactory = (url, handlers) => {
    const inner = (opts.wrap ?? ((f) => f))(wsSocketFactory)(url, handlers);
    return {
      ...inner,
      sendBinary: (d) => {
        frames.sent.push({ at: Date.now(), type: d[0]! });
        inner.sendBinary(d);
      },
    };
  };
  const handlers: ConnectionEvents = {
    inbound: (e) => events.inbound.push(e),
    delivered: (ids) => events.delivered.push(...ids),
    ended: (r) => events.ended.push(r),
  };
  const conn = new RoomConnection({
    home,
    keys,
    url: `ws://127.0.0.1:${port}/v1/rooms/${realKeys.roomId}`,
    hello: { v: 1, name, harness: "claude-code", client: "pairwire/test", instance, caps: ["ack"] },
    log: createLogger({ sink: () => {} }),
    events: handlers,
    socketFactory: recordSends,
    tuning: { ...FAST, ...opts.tuning },
  });
  cleanups.push(() => conn.stop());
  const client: Client = {
    name,
    home,
    keys: realKeys,
    conn,
    events,
    frames,
    inbox: () => readInbox(home, realKeys.roomId),
    outbox: () => readOutbox(home, realKeys.roomId),
    state: () => readState(home, realKeys.roomId)!,
    restart: (o = {}) => {
      conn.stop();
      return makeClient(name, port, secret, { ...opts, ...o, home });
    },
  };
  return client;
}

export function newSecret(): Uint8Array {
  return generateSecret();
}

/** Keys that share the room id but not the HELLO key, as a client with the wrong secret would. */
export function wrongKeys(secret: Uint8Array): RoomKeys {
  const real = deriveRoomKeys(secret);
  const other = deriveRoomKeys(generateSecret());
  return { ...other, roomId: real.roomId, roomIdBytes: real.roomIdBytes };
}

export async function until(cond: () => boolean, ms = 5000, what = "condition"): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const randomInstance = () => base32Encode(randomBytes(16));
export const MAX_AGE = RELAY_LIMITS.maxAgeMs;
