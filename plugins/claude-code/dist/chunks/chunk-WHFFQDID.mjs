import { createRequire as __pwCreateRequire } from "node:module";
const require = __pwCreateRequire(import.meta.url);
import {
  ROOM_ID_PATTERN,
  activeFlagPath,
  chooseCtlPath,
  roomDir,
  roomFile,
  roomsDir
} from "./chunk-AOSSRO7Z.mjs";
import {
  RELAY_LIMITS,
  SECRET_BYTES,
  base32Encode,
  external_exports
} from "./chunk-5TF4YXFP.mjs";
import {
  randomBytes
} from "./chunk-KARZWXGF.mjs";

// packages/client/src/state.ts
import { mkdirSync as mkdirSync2, readdirSync, readFileSync, writeFileSync as writeFileSync2 } from "node:fs";

// packages/client/src/fs-util.ts
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
var PRIVATE_DIR_MODE = 448;
var PRIVATE_FILE_MODE = 384;
var LOCK_STALE_MS = 5e3;
var LOCK_TIMEOUT_MS = 2 * LOCK_STALE_MS;
var LockTimeoutError = class extends Error {
  constructor(file) {
    super(`Timed out waiting for the lock on ${file}.`);
    this.file = file;
  }
  file;
  name = "LockTimeoutError";
};
function errorCode(e) {
  return typeof e === "object" && e !== null && "code" in e ? String(e.code) : void 0;
}
function ensurePrivateDir(path) {
  mkdirSync(path, { recursive: true, mode: PRIVATE_DIR_MODE });
}
var tmpSeq = 0;
function writeFileAtomic(path, data, mode = PRIVATE_FILE_MODE) {
  const tmp = `${path}.${process.pid}.${tmpSeq++}.tmp`;
  const fd = openSync(tmp, "wx", mode);
  try {
    try {
      writeFileSync(fd, data);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  } catch (e) {
    removeFile(tmp);
    throw e;
  }
  fsyncDir(dirname(path));
}
function fsyncDir(dir) {
  try {
    const fd = openSync(dir, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
  }
}
function removeFile(path) {
  try {
    unlinkSync(path);
  } catch (e) {
    if (errorCode(e) !== "ENOENT") throw e;
  }
}
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
function withLock(file, fn) {
  const lock = `${file}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (; ; ) {
    try {
      mkdirSync(lock, { mode: PRIVATE_DIR_MODE });
      break;
    } catch (e) {
      if (errorCode(e) !== "EEXIST") throw e;
    }
    try {
      if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) {
        rmdirSync(lock);
        continue;
      }
    } catch {
      continue;
    }
    if (Date.now() > deadline) throw new LockTimeoutError(file);
    sleepSync(10);
  }
  try {
    return fn();
  } finally {
    try {
      rmdirSync(lock);
    } catch {
    }
  }
}

// packages/client/src/state.ts
var hex = external_exports.string().regex(/^(?:[0-9a-f]{2})+$/);
var counter = external_exports.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
var millis = external_exports.number().int().min(0);
var sessionSchema = external_exports.strictObject({ sid: hex, send_key: hex, recv_key: hex });
var ROOM_STATUSES = ["waiting", "active", "left", "ended"];
var roomStateSchema = external_exports.strictObject({
  relay: external_exports.string().nullable(),
  instance: external_exports.string().regex(ROOM_ID_PATTERN),
  name: external_exports.string(),
  member: external_exports.enum(["a", "b"]).nullable(),
  token: external_exports.string().nullable(),
  epoch: counter.nullable(),
  sessions: external_exports.strictObject({ current: sessionSchema.nullable(), previous: sessionSchema.nullable() }),
  my_seq: counter,
  peer_max_seq: counter,
  peer: external_exports.strictObject({ name: external_exports.string(), harness: external_exports.string(), instance: external_exports.string() }).nullable(),
  hop_count: counter,
  status: external_exports.enum(ROOM_STATUSES),
  created_at: millis,
  expires_at: millis.nullable(),
  ctl_path: external_exports.string(),
  error: external_exports.string().nullable(),
  bypass_warned_sessions: external_exports.array(external_exports.string())
});
var StateError = class extends Error {
  name = "StateError";
};
function createRoom(home, room, env = process.env) {
  if (room.secret.length !== SECRET_BYTES) throw new StateError("Room secret has the wrong length.");
  ensurePrivateDir(roomsDir(home));
  try {
    mkdirSync2(roomDir(home, room.roomId), { mode: PRIVATE_DIR_MODE });
  } catch (e) {
    if (errorCode(e) === "EEXIST") throw new StateError("This room is already stored on this machine.");
    throw e;
  }
  writeFileAtomic(roomFile(home, room.roomId, "secret"), room.secret);
  const state = {
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
    bypass_warned_sessions: []
  };
  writeState(home, room.roomId, state);
  refreshActiveFlag(home);
  return state;
}
function writeState(home, roomId, state) {
  writeFileAtomic(roomFile(home, roomId, "state.json"), JSON.stringify(roomStateSchema.parse(state), null, 2) + "\n");
}
function readState(home, roomId) {
  let text;
  try {
    text = readFileSync(roomFile(home, roomId, "state.json"), "utf8");
  } catch (e) {
    if (errorCode(e) === "ENOENT") return null;
    throw e;
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new StateError(`The state file of room ${roomId.slice(0, 6)}\u2026 is not valid JSON.`);
  }
  const parsed = roomStateSchema.safeParse(json);
  if (!parsed.success) throw new StateError(`The state file of room ${roomId.slice(0, 6)}\u2026 is invalid.`);
  return parsed.data;
}
function updateState(home, roomId, change) {
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
function readSecret(home, roomId) {
  let bytes;
  try {
    bytes = readFileSync(roomFile(home, roomId, "secret"));
  } catch (e) {
    if (errorCode(e) === "ENOENT") return null;
    throw e;
  }
  if (bytes.length !== SECRET_BYTES) throw new StateError("The stored room secret is corrupt.");
  return new Uint8Array(bytes);
}
function listRooms(home) {
  try {
    return readdirSync(roomsDir(home)).filter((name) => ROOM_ID_PATTERN.test(name)).sort();
  } catch (e) {
    if (errorCode(e) === "ENOENT") return [];
    throw e;
  }
}
function expiresAt(state) {
  return state.expires_at ?? state.created_at + RELAY_LIMITS.maxAgeMs;
}
var isOpen = (state) => state.status === "waiting" || state.status === "active";
function refreshActiveFlag(home) {
  const open = listRooms(home).some((id) => {
    try {
      const s = readState(home, id);
      return s !== null && isOpen(s);
    } catch {
      return true;
    }
  });
  const flag = activeFlagPath(home);
  if (open) writeFileSync2(flag, "", { mode: PRIVATE_FILE_MODE });
  else removeFile(flag);
  return open;
}

export {
  PRIVATE_FILE_MODE,
  errorCode,
  ensurePrivateDir,
  writeFileAtomic,
  removeFile,
  withLock,
  createRoom,
  readState,
  updateState,
  readSecret,
  listRooms,
  expiresAt,
  isOpen,
  refreshActiveFlag
};
