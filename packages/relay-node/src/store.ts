// Optional room state persistence (03, Persistence): one row per room holding core's
// encodeRoomState(), in a SQLite file opened with Node's built-in node:sqlite.
import { closeSync, openSync } from "node:fs";
import { decodeRoomState, encodeRoomState, type RoomState } from "@pairwire/core";

export interface RoomStore {
  /** Every saved room. Rows that fail to decode are deleted and counted in `dropped`. */
  load(): { rooms: Map<string, RoomState>; dropped: number };
  save(roomId: string, state: RoomState): void;
  delete(roomId: string): void;
  close(): void;
}

export type StateSetting = { kind: "memory" } | { kind: "sqlite"; path: string };

/** Reads PAIRWIRE_RELAY_STATE: unset, empty or `memory`, or `sqlite:<path>`. */
export function parseStateSetting(value: string | undefined): StateSetting {
  if (value === undefined || value === "" || value === "memory") return { kind: "memory" };
  const sqlite = /^sqlite:(.+)$/.exec(value);
  if (sqlite) return { kind: "sqlite", path: sqlite[1]! };
  throw new Error('PAIRWIRE_RELAY_STATE must be "memory" or "sqlite:<path>", for example sqlite:/data/relay.db');
}

/** The few node:sqlite types the store uses; @types/node 20 has none (ADR-022). */
interface Statement {
  run(...params: (string | number)[]): unknown;
  all(...params: (string | number)[]): unknown[];
  get(...params: (string | number)[]): unknown;
}
interface Database {
  exec(sql: string): void;
  prepare(sql: string): Statement;
  close(): void;
}
export interface SqliteModule {
  DatabaseSync: new (path: string) => Database;
}

/** Node 22.13+ (and 23.4+) have node:sqlite unflagged; older versions return undefined. */
function builtinSqlite(): SqliteModule | undefined {
  if (typeof process.getBuiltinModule !== "function") return undefined;
  return process.getBuiltinModule("node:sqlite") as SqliteModule | undefined;
}

const SCHEMA_VERSION = 1;

export function openSqliteStore(path: string, loadSqlite: () => SqliteModule | undefined = builtinSqlite): RoomStore {
  const sqlite = loadSqlite();
  if (!sqlite) {
    throw new Error(
      `PAIRWIRE_RELAY_STATE=sqlite:... needs the built-in node:sqlite module, which Node ${process.version} doesn't have. ` +
        "Run the relay on Node 22.13 or later (the Docker image has it), or unset PAIRWIRE_RELAY_STATE to keep state in memory.",
    );
  }
  // The file holds member tokens: create it owner-only. SQLite gives -wal and -shm the same mode.
  if (path !== ":memory:") closeSync(openSync(path, "a", 0o600));
  const db = new sqlite.DatabaseSync(path);
  try {
    // FULL: a returned write survives power loss too; writes are rare enough to afford it.
    db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
    const version = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    if (version === 0) {
      db.exec(`CREATE TABLE rooms (room_id TEXT PRIMARY KEY, state TEXT NOT NULL) STRICT; PRAGMA user_version = ${SCHEMA_VERSION};`);
    } else if (version !== SCHEMA_VERSION) {
      throw new Error(`${path} has relay state schema ${version}; this relay understands ${SCHEMA_VERSION}`);
    }
  } catch (err) {
    db.close();
    throw err;
  }
  const upsert = db.prepare("INSERT INTO rooms (room_id, state) VALUES (?, ?) ON CONFLICT (room_id) DO UPDATE SET state = excluded.state");
  const remove = db.prepare("DELETE FROM rooms WHERE room_id = ?");

  return {
    load() {
      const rooms = new Map<string, RoomState>();
      let dropped = 0;
      for (const row of db.prepare("SELECT room_id, state FROM rooms").all() as { room_id: string; state: string }[]) {
        try {
          rooms.set(row.room_id, decodeRoomState(row.state));
        } catch {
          remove.run(row.room_id);
          dropped++;
        }
      }
      return { rooms, dropped };
    },
    save: (roomId, state) => void upsert.run(roomId, encodeRoomState(state)),
    delete: (roomId) => void remove.run(roomId),
    close: () => db.close(),
  };
}
