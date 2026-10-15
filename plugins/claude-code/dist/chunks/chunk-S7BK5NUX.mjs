import { createRequire as __pwCreateRequire } from "node:module";
const require = __pwCreateRequire(import.meta.url);
import {
  ensurePrivateDir,
  errorCode,
  external_exports,
  isOpen,
  readState,
  removeFile,
  withLock,
  writeFileAtomic
} from "./chunk-H4ULF7HQ.mjs";
import {
  ROOM_ID_PATTERN,
  bindingsDir,
  bytesToHex,
  sha256,
  utf8ToBytes
} from "./chunk-A6UKVX6D.mjs";

// packages/client/src/project.ts
import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
var usable = (value) => !!value && !value.includes("${");
function resolveProjectDir(env, cwd) {
  if (usable(env.PAIRWIRE_PROJECT_DIR)) return canonical(env.PAIRWIRE_PROJECT_DIR);
  if (usable(env.CLAUDE_PROJECT_DIR)) return canonical(env.CLAUDE_PROJECT_DIR);
  const start = canonical(cwd);
  return gitRoot(start) ?? start;
}
function gitRoot(dir) {
  for (let d = dir; ; d = dirname(d)) {
    if (existsSync(join(d, ".git"))) return d;
    if (dirname(d) === d) return null;
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
  updated_at: external_exports.number().int().min(0)
});
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
    writeBinding(path, { ...binding, owner_pid: me.pid, owner_session: me.session, updated_at: me.now });
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
    const binding = { project_dir: projectDir, room_id: roomId, owner_pid: me.pid, owner_session: me.session, updated_at: me.now };
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

export {
  resolveProjectDir,
  PassiveSessionError,
  isProcessAlive,
  readBinding,
  claimProject,
  bindProject,
  removeBindingFor,
  sessionOwnsBinding
};
