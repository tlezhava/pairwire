// Per-room local state (04 §3): rooms/<room_id>/{secret, state.json}, plus the `active` flag.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "@noble/hashes/utils.js";
import { base32Encode, RELAY_LIMITS, SECRET_BYTES } from "@pairwire/core";
import { z } from "zod";
import { ensurePrivateDir, errorCode, PRIVATE_DIR_MODE, PRIVATE_FILE_MODE, removeFile, withLock, writeFileAtomic } from "./fs-util.js";
import { activeFlagPath, chooseCtlPath, ROOM_ID_PATTERN, roomDir, roomFile, roomsDir } from "./paths.js";

const hex = z.string().regex(/^(?:[0-9a-f]{2})+$/);
const counter = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const millis = z.number().int().min(0);

const sessionSchema = z.strictObject({ sid: hex, send_key: hex, recv_key: hex });
export type StoredSession = z.infer<typeof sessionSchema>;

export const ROOM_STATUSES = ["waiting", "active", "left", "ended"] as const;
export type RoomStatus = (typeof ROOM_STATUSES)[number];

export const roomStateSchema = z.strictObject({
  relay: z.string().nullable(),
  instance: z.string().regex(ROOM_ID_PATTERN),
  name: z.string(),
  member: z.enum(["a", "b"]).nullable(),
  token: z.string().nullable(),
  epoch: counter.nullable(),
  sessions: z.strictObject({ current: sessionSchema.nullable(), previous: sessionSchema.nullable() }),
  my_seq: counter,
  peer_max_seq: counter,
  peer: z.strictObject({ name: z.string(), harness: z.string(), instance: z.string() }).nullable(),
  hop_count: counter,
  status: z.enum(ROOM_STATUSES),
  created_at: millis,
  expires_at: millis.nullable(),
  ctl_path: z.string(),
  error: z.string().nullable(),
  bypass_warned_sessions: z.array(z.string()),
});
export type RoomState = z.infer<typeof roomStateSchema>;

export class StateError extends Error {
  override readonly name = "StateError";
}

export interface NewRoom {
  roomId: string;
  secret: Uint8Array;
  /** host[:port], or null for the built-in default relay. */
  relay: string | null;
  /** Our display name for this room (HELLO). */
  name: string;
  now: number;
}

/** Creates rooms/<id>/ with the secret and a `waiting` state. Fails if the room already exists. */
export function createRoom(home: string, room: NewRoom, env: NodeJS.ProcessEnv = process.env): RoomState {
  if (room.secret.length !== SECRET_BYTES) throw new StateError("Room secret has the wrong length.");
  ensurePrivateDir(roomsDir(home));
  try {
    // Not recursive: an existing directory means the room is already stored here.
    mkdirSync(roomDir(home, room.roomId), { mode: PRIVATE_DIR_MODE });
  } catch (e) {
    if (errorCode(e) === "EEXIST") throw new StateError("This room is already stored on this machine.");
    throw e;
  }
  writeFileAtomic(roomFile(home, room.roomId, "secret"), room.secret);
  const state: RoomState = {
    relay: room.relay,
    instance: base32Encode(randomBytes(16)),
    name: room.name,
    member: null,
    token: null,
    epoch: null,
    sessions: { current: null, previous: null },
    my_seq: 0,
    peer_max_seq: 0,
    peer: null,
    hop_count: 0,
    status: "waiting",
    created_at: room.now,
    expires_at: null,
    ctl_path: chooseCtlPath(home, room.roomId, env),
    error: null,
    bypass_warned_sessions: [],
  };
  writeState(home, room.roomId, state);
  refreshActiveFlag(home);
  return state;
}

function writeState(home: string, roomId: string, state: RoomState): void {
  writeFileAtomic(roomFile(home, roomId, "state.json"), JSON.stringify(roomStateSchema.parse(state), null, 2) + "\n");
}

/** The room's state, or null if this machine has no such room. */
export function readState(home: string, roomId: string): RoomState | null {
  let text: string;
  try {
    text = readFileSync(roomFile(home, roomId, "state.json"), "utf8");
  } catch (e) {
    if (errorCode(e) === "ENOENT") return null;
    throw e;
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new StateError(`The state file of room ${roomId.slice(0, 6)}… is not valid JSON.`);
  }
  const parsed = roomStateSchema.safeParse(json);
  if (!parsed.success) throw new StateError(`The state file of room ${roomId.slice(0, 6)}… is invalid.`);
  return parsed.data;
}

/** Read-modify-write of state.json under its lock. Returns the new state. */
export function updateState(home: string, roomId: string, change: (state: RoomState) => RoomState): RoomState {
  const file = roomFile(home, roomId, "state.json");
  const next = withLock(file, () => {
    const current = readState(home, roomId);
    if (!current) throw new StateError("This room is not stored on this machine.");
    const updated = change(structuredClone(current));
    writeState(home, roomId, updated);
    return updated;
  });
  refreshActiveFlag(home);
  return next;
}

/** The 32-byte room secret, or null once it has been deleted (left or ended rooms). */
export function readSecret(home: string, roomId: string): Uint8Array | null {
  let bytes: Buffer;
  try {
    bytes = readFileSync(roomFile(home, roomId, "secret"));
  } catch (e) {
    if (errorCode(e) === "ENOENT") return null;
    throw e;
  }
  if (bytes.length !== SECRET_BYTES) throw new StateError("The stored room secret is corrupt.");
  return new Uint8Array(bytes);
}

/** All room ids stored on this machine. */
export function listRooms(home: string): string[] {
  try {
    return readdirSync(roomsDir(home)).filter((name) => ROOM_ID_PATTERN.test(name)).sort();
  } catch (e) {
    if (errorCode(e) === "ENOENT") return [];
    throw e;
  }
}

/** The relay's `expires_at`, or created_at + 7 days before the first `joined` (04 §3). */
export function expiresAt(state: RoomState): number {
  return state.expires_at ?? state.created_at + RELAY_LIMITS.maxAgeMs;
}

export const isOpen = (state: RoomState) => state.status === "waiting" || state.status === "active";

/** The `active` flag exists iff some room on this machine is waiting or active (04 §6, run.sh). */
export function refreshActiveFlag(home: string): boolean {
  const open = listRooms(home).some((id) => {
    try {
      const s = readState(home, id);
      return s !== null && isOpen(s);
    } catch {
      return true; // unreadable state: keep hooks running so they can report it
    }
  });
  const flag = activeFlagPath(home);
  if (open) writeFileSync(flag, "", { mode: PRIVATE_FILE_MODE });
  else removeFile(flag);
  return open;
}
