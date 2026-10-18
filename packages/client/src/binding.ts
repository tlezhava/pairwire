// One room per project directory (04 §3, ADR-007): bindings/<project_hash>.json says which
// room a project has and which MCP server (pid and harness session) owns it.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { ensurePrivateDir, errorCode, removeFile, withLock, writeFileAtomic } from "./fs-util.js";
import { bindingsDir, ROOM_ID_PATTERN } from "./paths.js";
import { projectHash } from "./project.js";
import { isOpen, readState } from "./state.js";

export const bindingSchema = z.strictObject({
  project_dir: z.string(),
  room_id: z.string().regex(ROOM_ID_PATTERN),
  owner_pid: z.number().int().positive(),
  owner_session: z.string().nullable(),
  /** The owning server's PAIRWIRE_HARNESS; absent in bindings written before M5. */
  owner_harness: z.string().optional(),
  updated_at: z.number().int().min(0),
});
export type Binding = z.infer<typeof bindingSchema>;

/** The MCP server asking: its own pid and the harness session id it was given, if any. */
export interface Claimant {
  pid: number;
  /** `CLAUDE_CODE_SESSION_ID` in Claude Code (S2); null in harnesses without one. */
  session: string | null;
  /** The harness it runs in (PAIRWIRE_HARNESS), so `ctl` can name the human's commands (04 §3). */
  harness?: string;
  /** Its parent process, the harness, for the harness-pid sidecar when `session` is null (04 §10). */
  harnessPid?: number;
  now: number;
}

/** The binding fields that say who owns the room. */
function owner(me: Claimant): Pick<Binding, "owner_pid" | "owner_session" | "owner_harness" | "updated_at"> {
  return { owner_pid: me.pid, owner_session: me.session, ...(me.harness !== undefined ? { owner_harness: me.harness } : {}), updated_at: me.now };
}

export type Ownership =
  | { kind: "idle" }
  | { kind: "passive"; ownerPid: number; roomId: string }
  | { kind: "owner"; roomId: string; tookOver: boolean };

export class PassiveSessionError extends Error {
  override readonly name = "PassiveSessionError";
  constructor(readonly ownerPid: number) {
    super(`Another session in this project (pid ${ownerPid}) owns the pairwire room.`);
  }
}

export const bindingPath = (home: string, projectDir: string) => join(bindingsDir(home), `${projectHash(projectDir)}.json`);

/**
 * `bindings/<hash>.harness-pid` (04 §3, §10, ADR-033): the owning server's parent, for hooks to
 * find their session by while the binding has no `owner_session`. A sidecar, because 0.1.x and
 * 0.2.x read bindings with a strict schema; it names the owner pid because those versions
 * don't know the file and may leave a stale one behind when they take a binding over.
 */
export const harnessPidSchema = z.strictObject({
  owner_pid: z.number().int().positive(),
  harness_pid: z.number().int().min(2),
});
const sidecarPath = (path: string) => path.replace(/\.json$/, ".harness-pid");
export const harnessPidPath = (home: string, projectDir: string) => sidecarPath(bindingPath(home, projectDir));

/** The harness pid recorded for `binding`'s owner, or null (none, unreadable, or stale). */
export function readHarnessPid(home: string, projectDir: string, binding: Binding): number | null {
  let text: string;
  try {
    text = readFileSync(harnessPidPath(home, projectDir), "utf8");
  } catch {
    return null;
  }
  const parsed = harnessPidSchema.safeParse(safeJson(text));
  return parsed.success && parsed.data.owner_pid === binding.owner_pid ? parsed.data.harness_pid : null;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** Removes a binding file and its sidecar. */
function removeBindingFile(path: string): void {
  removeFile(path);
  removeFile(sidecarPath(path));
}

/** A pid that exists, even if owned by another user (EPERM), counts as alive. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return errorCode(e) === "EPERM";
  }
}

function readBindingFile(path: string): Binding | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if (errorCode(e) === "ENOENT") return null;
    throw e;
  }
  try {
    return bindingSchema.parse(JSON.parse(text));
  } catch {
    return null; // a corrupt binding is treated as none; the next write replaces it
  }
}

export function readBinding(home: string, projectDir: string): Binding | null {
  return readBindingFile(bindingPath(home, projectDir));
}

/** A binding whose room is gone, left or ended no longer binds anything. */
function roomIsOpen(home: string, roomId: string): boolean {
  try {
    const state = readState(home, roomId);
    return state !== null && isOpen(state);
  } catch {
    return true; // unreadable state is reported elsewhere; don't silently drop the binding
  }
}

/**
 * What the MCP server starting in `projectDir` should do (04 §3): no binding → idle; a live
 * owner that isn't us → passive; a dead owner → take over (REQ-ROOM-6). Done under the
 * binding's lock, so two servers starting together can't both take over (ADR-018).
 */
export function claimProject(home: string, projectDir: string, me: Claimant, alive: (pid: number) => boolean = isProcessAlive): Ownership {
  const path = bindingPath(home, projectDir);
  ensurePrivateDir(bindingsDir(home));
  return withLock(path, () => {
    const binding = readBindingFile(path);
    if (!binding) return { kind: "idle" };
    if (!roomIsOpen(home, binding.room_id)) {
      removeBindingFile(path);
      return { kind: "idle" };
    }
    if (binding.owner_pid === me.pid) return { kind: "owner", roomId: binding.room_id, tookOver: false };
    if (alive(binding.owner_pid)) return { kind: "passive", ownerPid: binding.owner_pid, roomId: binding.room_id };
    const { owner_harness: _previous, ...rest } = binding;
    writeBinding(path, { ...rest, ...owner(me) }, me.harnessPid);
    return { kind: "owner", roomId: binding.room_id, tookOver: true };
  });
}

/**
 * Binds `roomId` to the project for `start`/`join`. Refuses with PassiveSessionError when a
 * live session other than `me` holds an open room here.
 */
export function bindProject(home: string, projectDir: string, roomId: string, me: Claimant, alive: (pid: number) => boolean = isProcessAlive): Binding {
  const path = bindingPath(home, projectDir);
  ensurePrivateDir(bindingsDir(home));
  return withLock(path, () => {
    const existing = readBindingFile(path);
    if (existing && existing.owner_pid !== me.pid && roomIsOpen(home, existing.room_id) && alive(existing.owner_pid)) {
      throw new PassiveSessionError(existing.owner_pid);
    }
    const binding: Binding = { project_dir: projectDir, room_id: roomId, ...owner(me) };
    writeBinding(path, binding, me.harnessPid);
    return binding;
  });
}

/**
 * Writes the binding, and its harness-pid sidecar while it has no `owner_session` (04 §10); a
 * binding with a session, or a server without a usable parent, has none.
 */
function writeBinding(path: string, binding: Binding, harnessPid?: number): void {
  writeFileAtomic(path, JSON.stringify(bindingSchema.parse(binding), null, 2) + "\n");
  const side = sidecarPath(path);
  const record = harnessPidSchema.safeParse({ owner_pid: binding.owner_pid, harness_pid: harnessPid });
  if (binding.owner_session === null && record.success) writeFileAtomic(side, JSON.stringify(record.data) + "\n");
  else removeFile(side);
}

function bindingFiles(home: string): string[] {
  try {
    return readdirSync(bindingsDir(home))
      .filter((n) => /^[0-9a-f]{16}\.json$/.test(n))
      .map((n) => join(bindingsDir(home), n));
  } catch (e) {
    if (errorCode(e) === "ENOENT") return [];
    throw e;
  }
}

/** The bindings that point at `roomId` (normally at most one). */
export function bindingsForRoom(home: string, roomId: string): Binding[] {
  return bindingFiles(home).flatMap((path) => {
    const b = readBindingFile(path);
    return b?.room_id === roomId ? [b] : [];
  });
}

/** Removes every binding that points at `roomId` (on leave, end or expiry). */
export function removeBindingFor(home: string, roomId: string): void {
  for (const path of bindingFiles(home)) {
    withLock(path, () => {
      if (readBindingFile(path)?.room_id === roomId) removeBindingFile(path);
    });
  }
}

/**
 * Hooks deliver only for the owning session (04 §3): the hook input's `session_id` must equal
 * the binding's `owner_session`. Without a session id the room relies on pull (D1).
 */
export function sessionOwnsBinding(binding: Binding | null, sessionId: string | undefined): boolean {
  return binding !== null && binding.owner_session !== null && binding.owner_session === sessionId;
}

/**
 * Records the harness session that owns the room when the binding has none yet: Codex gives
 * the MCP server no session variable, only `_meta.sessionId` on each tool call, and in other
 * harnesses the first hook that matches the harness pid records its own (04 §10). Removes the
 * harness-pid sidecar with that write.
 */
export function adoptOwnerSession(home: string, projectDir: string, roomId: string, pid: number, session: string): boolean {
  const path = bindingPath(home, projectDir);
  return withLock(path, () => {
    const b = readBindingFile(path);
    if (!b || b.room_id !== roomId || b.owner_pid !== pid || b.owner_session !== null) return false;
    writeBinding(path, { ...b, owner_session: session });
    return true;
  });
}
