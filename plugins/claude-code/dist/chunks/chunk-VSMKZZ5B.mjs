import { createRequire as __pwCreateRequire } from "node:module";
const require = __pwCreateRequire(import.meta.url);
import {
  ROOM_ID_PATTERN,
  activeFlagPath,
  bindingsDir,
  chooseCtlPath,
  configPath,
  hookErrorsPath,
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
  parseRelayAddress,
  redact
} from "./chunk-CPUICV65.mjs";
import {
  bytesToHex,
  randomBytes,
  sha256,
  utf8ToBytes
} from "./chunk-KARZWXGF.mjs";

// packages/client/src/log.ts
import { appendFileSync, renameSync as renameSync2, statSync as statSync2 } from "node:fs";
import { dirname as dirname2 } from "node:path";

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
function isContention(e, platform = process.platform) {
  const code = errorCode(e);
  return code === "EEXIST" || platform === "win32" && code === "EPERM";
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
      if (!isContention(e)) throw e;
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

// packages/client/src/log.ts
var LOG_LEVELS = ["debug", "info", "warn", "error"];
var SENSITIVE_NAME = /secret|token|key|psk|share|password/i;
var RESERVED = /* @__PURE__ */ new Set(["t", "level", "event"]);
var HOOK_LOG_MAX_BYTES = 1024 * 1024;
function parseLogLevel(value) {
  const v = value?.trim().toLowerCase();
  return LOG_LEVELS.includes(v ?? "") ? v : "info";
}
function roomTag(roomId) {
  return bytesToHex(sha256(utf8ToBytes(roomId))).slice(0, 4);
}
function clean(name, value) {
  if (SENSITIVE_NAME.test(name)) return "[redacted]";
  if (typeof value === "string") return redact(value);
  if (value === null || value === void 0 || typeof value === "number" || typeof value === "boolean") return value;
  return "[unsupported]";
}
function errorFields(err) {
  if (err === void 0) return {};
  if (!(err instanceof Error)) return { error_message: String(err) };
  const code = err.code;
  return {
    error_name: err.name,
    error_code: typeof code === "string" || typeof code === "number" ? code : void 0,
    error_message: err.message,
    error_stack: err.stack
  };
}
var stderrSink = (line) => {
  process.stderr.write(line + "\n");
};
function createLogger(options = {}) {
  const sink = options.sink ?? stderrSink;
  const min = LOG_LEVELS.indexOf(options.level ?? parseLogLevel(process.env.PAIRWIRE_LOG));
  const now = options.now ?? (() => /* @__PURE__ */ new Date());
  const write = (level, event, fields = {}) => {
    if (LOG_LEVELS.indexOf(level) < min) return;
    try {
      const line = { t: now().toISOString(), level, event: redact(event) };
      for (const [name, value] of Object.entries(fields)) {
        if (!RESERVED.has(name) && value !== void 0) line[name] = clean(name, value);
      }
      sink(JSON.stringify(line));
    } catch {
    }
  };
  return {
    debug: (event, fields) => write("debug", event, fields),
    info: (event, fields) => write("info", event, fields),
    warn: (event, fields) => write("warn", event, fields),
    error: (event, err, fields) => write("error", event, { ...fields, ...errorFields(err) })
  };
}
function fileSink(path, maxBytes = HOOK_LOG_MAX_BYTES) {
  return (line) => {
    try {
      ensurePrivateDir(dirname2(path));
      try {
        if (statSync2(path).size > maxBytes) renameSync2(path, `${path}.1`);
      } catch {
      }
      appendFileSync(path, line + "\n", { mode: PRIVATE_FILE_MODE });
    } catch {
    }
  };
}
function hookErrorLogger(home) {
  return createLogger({ sink: fileSink(hookErrorsPath(home)), level: "error" });
}

// packages/client/src/project.ts
import { existsSync, realpathSync } from "node:fs";
import { dirname as dirname3, join, resolve } from "node:path";
var usable = (value) => !!value && !value.includes("${");
function resolveProjectDir(env, cwd) {
  if (usable(env.PAIRWIRE_PROJECT_DIR)) return canonical(env.PAIRWIRE_PROJECT_DIR);
  if (usable(env.CLAUDE_PROJECT_DIR)) return canonical(env.CLAUDE_PROJECT_DIR);
  const start = canonical(cwd);
  return gitRoot(start) ?? start;
}
function gitRoot(dir) {
  for (let d = dir; ; d = dirname3(d)) {
    if (existsSync(join(d, ".git"))) return d;
    if (dirname3(d) === d) return null;
  }
}
function canonical(dir) {
  try {
    return realpathSync(dir);
  } catch {
    return resolve(dir);
  }
}
function projectHash(projectDir) {
  return bytesToHex(sha256(utf8ToBytes(canonical(projectDir)))).slice(0, 16);
}

// packages/client/src/state.ts
import { mkdirSync as mkdirSync2, readdirSync, readFileSync, writeFileSync as writeFileSync2 } from "node:fs";
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
var MAX_CAPS = 16;
var MAX_CAP_CHARS = 32;
var capsFileSchema = external_exports.record(hex, external_exports.array(external_exports.string().max(MAX_CAP_CHARS)).max(MAX_CAPS));
function readSessionCaps(home, roomId) {
  try {
    const parsed = capsFileSchema.safeParse(JSON.parse(readFileSync(roomFile(home, roomId, "caps.json"), "utf8")));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}
function writeSessionCaps(home, roomId, sid, caps, keep) {
  const path = roomFile(home, roomId, "caps.json");
  withLock(path, () => {
    const current = readSessionCaps(home, roomId);
    const next = {};
    for (const s of keep) if (current[s]) next[s] = current[s];
    next[sid] = [...new Set(caps.filter((c) => c.length <= MAX_CAP_CHARS))].slice(0, MAX_CAPS);
    writeFileAtomic(path, JSON.stringify(next) + "\n");
  });
}
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

// packages/client/src/binding.ts
import { readdirSync as readdirSync2, readFileSync as readFileSync2 } from "node:fs";
import { join as join2 } from "node:path";
var bindingSchema = external_exports.strictObject({
  project_dir: external_exports.string(),
  room_id: external_exports.string().regex(ROOM_ID_PATTERN),
  owner_pid: external_exports.number().int().positive(),
  owner_session: external_exports.string().nullable(),
  /** The owning server's PAIRWIRE_HARNESS; absent in bindings written before M5. */
  owner_harness: external_exports.string().optional(),
  updated_at: external_exports.number().int().min(0)
});
function owner(me) {
  return { owner_pid: me.pid, owner_session: me.session, ...me.harness !== void 0 ? { owner_harness: me.harness } : {}, updated_at: me.now };
}
var PassiveSessionError = class extends Error {
  constructor(ownerPid) {
    super(`Another session in this project (pid ${ownerPid}) owns the pairwire room.`);
    this.ownerPid = ownerPid;
  }
  ownerPid;
  name = "PassiveSessionError";
};
var bindingPath = (home, projectDir) => join2(bindingsDir(home), `${projectHash(projectDir)}.json`);
function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return errorCode(e) === "EPERM";
  }
}
function readBindingFile(path) {
  let text;
  try {
    text = readFileSync2(path, "utf8");
  } catch (e) {
    if (errorCode(e) === "ENOENT") return null;
    throw e;
  }
  try {
    return bindingSchema.parse(JSON.parse(text));
  } catch {
    return null;
  }
}
function readBinding(home, projectDir) {
  return readBindingFile(bindingPath(home, projectDir));
}
function roomIsOpen(home, roomId) {
  try {
    const state = readState(home, roomId);
    return state !== null && isOpen(state);
  } catch {
    return true;
  }
}
function claimProject(home, projectDir, me, alive = isProcessAlive) {
  const path = bindingPath(home, projectDir);
  ensurePrivateDir(bindingsDir(home));
  return withLock(path, () => {
    const binding = readBindingFile(path);
    if (!binding) return { kind: "idle" };
    if (!roomIsOpen(home, binding.room_id)) {
      removeFile(path);
      return { kind: "idle" };
    }
    if (binding.owner_pid === me.pid) return { kind: "owner", roomId: binding.room_id, tookOver: false };
    if (alive(binding.owner_pid)) return { kind: "passive", ownerPid: binding.owner_pid, roomId: binding.room_id };
    const { owner_harness: _previous, ...rest } = binding;
    writeBinding(path, { ...rest, ...owner(me) });
    return { kind: "owner", roomId: binding.room_id, tookOver: true };
  });
}
function bindProject(home, projectDir, roomId, me, alive = isProcessAlive) {
  const path = bindingPath(home, projectDir);
  ensurePrivateDir(bindingsDir(home));
  return withLock(path, () => {
    const existing = readBindingFile(path);
    if (existing && existing.owner_pid !== me.pid && roomIsOpen(home, existing.room_id) && alive(existing.owner_pid)) {
      throw new PassiveSessionError(existing.owner_pid);
    }
    const binding = { project_dir: projectDir, room_id: roomId, ...owner(me) };
    writeBinding(path, binding);
    return binding;
  });
}
function writeBinding(path, binding) {
  writeFileAtomic(path, JSON.stringify(bindingSchema.parse(binding), null, 2) + "\n");
}
function bindingFiles(home) {
  try {
    return readdirSync2(bindingsDir(home)).filter((n) => /^[0-9a-f]{16}\.json$/.test(n)).map((n) => join2(bindingsDir(home), n));
  } catch (e) {
    if (errorCode(e) === "ENOENT") return [];
    throw e;
  }
}
function bindingsForRoom(home, roomId) {
  return bindingFiles(home).flatMap((path) => {
    const b = readBindingFile(path);
    return b?.room_id === roomId ? [b] : [];
  });
}
function removeBindingFor(home, roomId) {
  for (const path of bindingFiles(home)) {
    withLock(path, () => {
      if (readBindingFile(path)?.room_id === roomId) removeFile(path);
    });
  }
}
function sessionOwnsBinding(binding, sessionId) {
  return binding !== null && binding.owner_session !== null && binding.owner_session === sessionId;
}
function adoptOwnerSession(home, projectDir, roomId, pid, session) {
  const path = bindingPath(home, projectDir);
  return withLock(path, () => {
    const b = readBindingFile(path);
    if (!b || b.room_id !== roomId || b.owner_pid !== pid || b.owner_session !== null) return false;
    writeBinding(path, { ...b, owner_session: session });
    return true;
  });
}

// packages/client/src/config.ts
import { spawnSync } from "node:child_process";
import { readFileSync as readFileSync3 } from "node:fs";
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
    raw = JSON.parse(readFileSync3(path, "utf8"));
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
  roomTag,
  createLogger,
  fileSink,
  hookErrorLogger,
  resolveProjectDir,
  createRoom,
  readState,
  updateState,
  readSecret,
  listRooms,
  expiresAt,
  isOpen,
  readSessionCaps,
  writeSessionCaps,
  refreshActiveFlag,
  PassiveSessionError,
  isProcessAlive,
  readBinding,
  claimProject,
  bindProject,
  bindingsForRoom,
  removeBindingFor,
  sessionOwnsBinding,
  adoptOwnerSession,
  DEFAULT_CONFIG,
  loadConfig,
  holdMode,
  resolveDisplayName
};
