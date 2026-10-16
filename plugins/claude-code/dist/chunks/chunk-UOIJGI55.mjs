import { createRequire as __pwCreateRequire } from "node:module";
const require = __pwCreateRequire(import.meta.url);
import {
  ROOM_ID_PATTERN,
  activeFlagPath,
  chooseCtlPath,
  configPath,
  roomDir,
  roomFile,
  roomsDir
} from "./chunk-GVGSGJLD.mjs";
import {
  ANONYMOUS,
  RELAY_LIMITS,
  SECRET_BYTES,
  base32Encode,
  external_exports,
  formatRelayAddress,
  parseRelayAddress
} from "./chunk-JC2XR7LP.mjs";
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

// packages/client/src/config.ts
import { spawnSync } from "node:child_process";
import { readFileSync as readFileSync2 } from "node:fs";
var DEFAULT_CONFIG = {
  name: null,
  relay: null,
  autoContinue: true,
  hopBudget: 8,
  delivery: "auto",
  hold: false,
  channels: false
};
var fileSchema = external_exports.object({
  name: external_exports.string().trim().min(1).max(200).optional(),
  relay: external_exports.string().optional(),
  auto_continue: external_exports.boolean().optional(),
  hop_budget: external_exports.number().int().min(1).max(1e3).optional(),
  delivery: external_exports.enum(["auto", "pull"]).optional(),
  hold: external_exports.boolean().optional(),
  channels: external_exports.boolean().optional()
});
var KNOWN_KEYS = new Set(Object.keys(fileSchema.shape));
var ConfigError = class extends Error {
  name = "ConfigError";
};
function loadConfig(home, env = process.env) {
  const path = configPath(home);
  const warnings = [];
  let raw = {};
  try {
    raw = JSON.parse(readFileSync2(path, "utf8"));
  } catch (e) {
    if (errorCode(e) !== "ENOENT") {
      throw new ConfigError(e instanceof SyntaxError ? `${path} is not valid JSON.` : `Cannot read ${path}.`);
    }
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new ConfigError(`${path} must contain a JSON object.`);
  for (const key of Object.keys(raw)) if (!KNOWN_KEYS.has(key)) warnings.push(`${path}: unknown key "${key}" ignored.`);
  const parsed = fileSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ConfigError(`${path}: "${issue.path.join(".")}" ${issue.message.toLowerCase()}.`);
  }
  const file = parsed.data;
  const config = {
    name: env.PAIRWIRE_NAME?.trim() || file.name || null,
    relay: normalizeRelay(env.PAIRWIRE_RELAY || file.relay, env.PAIRWIRE_RELAY ? "PAIRWIRE_RELAY" : `${path}: "relay"`),
    autoContinue: file.auto_continue ?? DEFAULT_CONFIG.autoContinue,
    hopBudget: file.hop_budget ?? DEFAULT_CONFIG.hopBudget,
    delivery: env.PAIRWIRE_DELIVERY ? parseDelivery(env.PAIRWIRE_DELIVERY) : file.delivery ?? DEFAULT_CONFIG.delivery,
    hold: env.PAIRWIRE_HOLD ? parseFlag(env.PAIRWIRE_HOLD, "PAIRWIRE_HOLD") : file.hold ?? DEFAULT_CONFIG.hold,
    channels: env.PAIRWIRE_CHANNELS ? parseFlag(env.PAIRWIRE_CHANNELS, "PAIRWIRE_CHANNELS") : file.channels ?? DEFAULT_CONFIG.channels
  };
  return { config, warnings };
}
function holdMode(home, env = process.env) {
  try {
    return loadConfig(home, env).config.hold;
  } catch {
    return true;
  }
}
function normalizeRelay(value, where) {
  if (!value?.trim()) return null;
  try {
    return formatRelayAddress(parseRelayAddress(value));
  } catch (e) {
    throw new ConfigError(`${where}: ${e.message}`);
  }
}
function parseDelivery(value) {
  const v = value.trim().toLowerCase();
  if (v === "auto" || v === "pull") return v;
  throw new ConfigError('PAIRWIRE_DELIVERY must be "auto" or "pull".');
}
function parseFlag(value, name) {
  const v = value.trim().toLowerCase();
  if (v === "1" || v === "true") return true;
  if (v === "0" || v === "false") return false;
  throw new ConfigError(`${name} must be 1, 0, true or false.`);
}
function resolveDisplayName(config, cwd, env = process.env) {
  if (config.name) return config.name;
  try {
    const git = spawnSync("git", ["config", "user.name"], { cwd, env, encoding: "utf8", timeout: 2e3, stdio: ["ignore", "pipe", "ignore"] });
    const name = git.status === 0 ? git.stdout.trim() : "";
    if (name) return name;
  } catch {
  }
  return env.USER?.trim() || env.USERNAME?.trim() || ANONYMOUS;
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
  refreshActiveFlag,
  DEFAULT_CONFIG,
  loadConfig,
  holdMode,
  resolveDisplayName
};
