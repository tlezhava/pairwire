import { createRequire as __pwCreateRequire } from "node:module";
const require = __pwCreateRequire(import.meta.url);
import {
  PRIVATE_FILE_MODE,
  ensurePrivateDir,
  errorCode,
  isOpen,
  readState,
  removeFile,
  withLock,
  writeFileAtomic
} from "./chunk-YNXENSKT.mjs";
import {
  ROOM_ID_PATTERN,
  bindingsDir,
  hookErrorsPath
} from "./chunk-GVGSGJLD.mjs";
import {
  external_exports,
  redact
} from "./chunk-F4RFDSWT.mjs";
import {
  bytesToHex,
  sha256,
  utf8ToBytes
} from "./chunk-KARZWXGF.mjs";

// packages/client/src/log.ts
import { appendFileSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";
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
      ensurePrivateDir(dirname(path));
      try {
        if (statSync(path).size > maxBytes) renameSync(path, `${path}.1`);
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
import { dirname as dirname2, join, resolve } from "node:path";
var usable = (value) => !!value && !value.includes("${");
function resolveProjectDir(env, cwd) {
  if (usable(env.PAIRWIRE_PROJECT_DIR)) return canonical(env.PAIRWIRE_PROJECT_DIR);
  if (usable(env.CLAUDE_PROJECT_DIR)) return canonical(env.CLAUDE_PROJECT_DIR);
  const start = canonical(cwd);
  return gitRoot(start) ?? start;
}
function gitRoot(dir) {
  for (let d = dir; ; d = dirname2(d)) {
    if (existsSync(join(d, ".git"))) return d;
    if (dirname2(d) === d) return null;
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

// packages/client/src/binding.ts
import { readdirSync, readFileSync } from "node:fs";
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
    text = readFileSync(path, "utf8");
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
function removeBindingFor(home, roomId) {
  let names;
  try {
    names = readdirSync(bindingsDir(home)).filter((n) => /^[0-9a-f]{16}\.json$/.test(n));
  } catch (e) {
    if (errorCode(e) === "ENOENT") return;
    throw e;
  }
  for (const name of names) {
    const path = join2(bindingsDir(home), name);
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

export {
  roomTag,
  createLogger,
  fileSink,
  hookErrorLogger,
  resolveProjectDir,
  PassiveSessionError,
  isProcessAlive,
  readBinding,
  claimProject,
  bindProject,
  removeBindingFor,
  sessionOwnsBinding,
  adoptOwnerSession
};
