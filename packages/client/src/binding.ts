// Memberships per project directory (04 §3, ADR-036): each binding file says which room (by
// its local room key) one MCP server in a folder is in, and which server (pid and harness
// session) owns it. A folder has its 0.3.x-era `bindings/<hash>.json`, if any, and one
// `bindings/<hash>.<room_key>.json` per membership bound since 0.4.0.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { ensurePrivateDir, errorCode, removeFile, withLock, writeFileAtomic } from "./fs-util.js";
import { bindingsDir, ROOM_ID_PATTERN } from "./paths.js";
import { projectHash } from "./project.js";
import { isOpen, readState } from "./state.js";

export const bindingSchema = z.strictObject({
  project_dir: z.string(),
  /** The room key: the room's directory under rooms/ (ADR-036). */
  room_id: z.string().regex(ROOM_ID_PATTERN),
  owner_pid: z.number().int().positive(),
  owner_session: z.string().nullable(),
  /** The owning server's PAIRWIRE_HARNESS; absent in bindings written before M5. */
  owner_harness: z.string().optional(),
  updated_at: z.number().int().min(0),
});
export type Binding = z.infer<typeof bindingSchema>;

/** A binding and the file it lives in. */
export interface BindingFile {
  path: string;
  binding: Binding;
}

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

export type Ownership = { kind: "idle" } | { kind: "owner"; roomId: string; tookOver: boolean };

/** Another live membership in the folder, for `status` and the footer (04 §3). */
export interface OtherMembership {
  harness: string | null;
  pid: number;
}

const LEGACY_NAME = /^([0-9a-f]{16})\.json$/;
const KEYED_NAME = /^([0-9a-f]{16})\.([a-z2-7]{26})\.json$/;

/** The legacy (0.3.x) binding path of a folder. */
const legacyPath = (home: string, projectDir: string) => join(bindingsDir(home), `${projectHash(projectDir)}.json`);

/** Where `start`/`join` bind room key `roomKey` in `projectDir` (ADR-036). */
export const keyedBindingPath = (home: string, projectDir: string, roomKey: string) => join(bindingsDir(home), `${projectHash(projectDir)}.${roomKey}.json`);

/**
 * The file of the folder's most recently updated binding, else the legacy path (where 0.3.x
 * would bind). For callers that expect a folder with one membership, such as tests.
 */
export function bindingPath(home: string, projectDir: string): string {
  return newestFirst(folderBindings(home, projectDir))[0]?.path ?? legacyPath(home, projectDir);
}

/**
 * `<binding>.harness-pid` (04 §3, §10, ADR-033): the owning server's parent, for hooks to
 * find their session by while the binding has no `owner_session`. A sidecar, because 0.1.x and
 * 0.2.x read bindings with a strict schema; it names the owner pid because those versions
 * don't know the file and may leave a stale one behind when they take a binding over.
 */
export const harnessPidSchema = z.strictObject({
  owner_pid: z.number().int().positive(),
  harness_pid: z.number().int().min(2),
});
const sidecarPath = (path: string) => path.replace(/\.json$/, ".harness-pid");
/** The sidecar of the folder's binding as `bindingPath()` picks it. */
export const harnessPidPath = (home: string, projectDir: string) => sidecarPath(bindingPath(home, projectDir));

/** The harness pid recorded for `binding`'s owner, or null (none, unreadable, or stale). */
export function readHarnessPid(home: string, projectDir: string, binding: Binding): number | null {
  const file = folderBindings(home, projectDir).find((f) => f.binding.room_id === binding.room_id);
  return file ? readSidecar(file) : null;
}

function readSidecar(file: BindingFile): number | null {
  let text: string;
  try {
    text = readFileSync(sidecarPath(file.path), "utf8");
  } catch {
    return null;
  }
  const parsed = harnessPidSchema.safeParse(safeJson(text));
  return parsed.success && parsed.data.owner_pid === file.binding.owner_pid ? parsed.data.harness_pid : null;
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

function bindingNames(home: string): string[] {
  try {
    return readdirSync(bindingsDir(home)).sort();
  } catch (e) {
    if (errorCode(e) === "ENOENT") return [];
    throw e;
  }
}

/** Every binding file path, both forms. */
function bindingFiles(home: string): string[] {
  return bindingNames(home)
    .filter((n) => LEGACY_NAME.test(n) || KEYED_NAME.test(n))
    .map((n) => join(bindingsDir(home), n));
}

/** The folder's binding file paths: the legacy one first, then the keyed ones. */
function folderPaths(home: string, projectDir: string): string[] {
  const hash = projectHash(projectDir);
  return bindingNames(home)
    .filter((n) => n === `${hash}.json` || KEYED_NAME.exec(n)?.[1] === hash)
    .map((n) => join(bindingsDir(home), n));
}

/** The folder's readable bindings (ADR-036). */
export function folderBindings(home: string, projectDir: string): BindingFile[] {
  return folderPaths(home, projectDir).flatMap((path) => {
    const binding = readBindingFile(path);
    return binding ? [{ path, binding }] : [];
  });
}

/** The folder's bindings; in a folder with one membership, that one. */
export function readBindings(home: string, projectDir: string): Binding[] {
  return folderBindings(home, projectDir).map((f) => f.binding);
}

/** The folder's most recently updated binding, or null (for folders with one membership). */
export function readBinding(home: string, projectDir: string): Binding | null {
  return newestFirst(folderBindings(home, projectDir))[0]?.binding ?? null;
}

function newestFirst(files: BindingFile[]): BindingFile[] {
  return [...files].sort((a, b) => b.binding.updated_at - a.binding.updated_at);
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
 * Whether a server may take over `b` once its owner is dead (04 §3): same harness, or a
 * binding from before M5 that names none. A restarted harness usually has a new session id,
 * so the session only ranks candidates (claimProject).
 */
function isOwnKind(b: Binding, me: Claimant): boolean {
  return b.owner_harness === undefined || me.harness === undefined || b.owner_harness === me.harness;
}

/**
 * What the MCP server in `projectDir` owns (04 §3): the binding it already owns; else a dead
 * owner's binding of its own kind, taken over (REQ-ROOM-6); else nothing (idle). Each takeover
 * happens under that binding's lock, so two servers starting together can't both take one
 * (ADR-018). Bindings of rooms no longer open are removed on the way.
 */
export function claimProject(home: string, projectDir: string, me: Claimant, alive: (pid: number) => boolean = isProcessAlive): Ownership {
  ensurePrivateDir(bindingsDir(home));
  const files = folderBindings(home, projectDir);
  const live: BindingFile[] = [];
  for (const f of files) {
    if (roomIsOpen(home, f.binding.room_id)) live.push(f);
    else withLock(f.path, () => (readBindingFile(f.path)?.room_id === f.binding.room_id ? removeBindingFile(f.path) : undefined));
  }
  const mine = live.find((f) => f.binding.owner_pid === me.pid);
  if (mine) return { kind: "owner", roomId: mine.binding.room_id, tookOver: false };
  const candidates = newestFirst(live.filter((f) => isOwnKind(f.binding, me))).sort(
    (a, b) => Number(me.session !== null && b.binding.owner_session === me.session) - Number(me.session !== null && a.binding.owner_session === me.session),
  );
  for (const f of candidates) {
    const taken = withLock(f.path, () => {
      const b = readBindingFile(f.path);
      if (!b || b.room_id !== f.binding.room_id || b.owner_pid === me.pid || alive(b.owner_pid) || !isOwnKind(b, me)) return false;
      const { owner_harness: _previous, ...rest } = b;
      writeBinding(f.path, { ...rest, ...owner(me) }, me.harnessPid);
      return true;
    });
    if (taken) return { kind: "owner", roomId: f.binding.room_id, tookOver: true };
  }
  return { kind: "idle" };
}

/** The folder's other live memberships, owned by servers other than `pid` (04 §3). */
export function otherMemberships(home: string, projectDir: string, pid: number, alive: (pid: number) => boolean = isProcessAlive): OtherMembership[] {
  return folderBindings(home, projectDir)
    .filter((f) => f.binding.owner_pid !== pid && alive(f.binding.owner_pid) && roomIsOpen(home, f.binding.room_id))
    .map((f) => ({ harness: f.binding.owner_harness ?? null, pid: f.binding.owner_pid }));
}

/**
 * Binds room key `roomKey` to the project for `start`/`join`, in its own keyed file (ADR-036).
 * Other bindings this server still owns in the folder (rooms it no longer uses) are removed.
 */
export function bindProject(home: string, projectDir: string, roomKey: string, me: Claimant): Binding {
  ensurePrivateDir(bindingsDir(home));
  for (const f of folderBindings(home, projectDir)) {
    if (f.binding.owner_pid !== me.pid || f.binding.room_id === roomKey) continue;
    withLock(f.path, () => (readBindingFile(f.path)?.owner_pid === me.pid ? removeBindingFile(f.path) : undefined));
  }
  const path = keyedBindingPath(home, projectDir, roomKey);
  return withLock(path, () => {
    const binding: Binding = { project_dir: projectDir, room_id: roomKey, ...owner(me) };
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

/** The bindings that point at room key `roomId` (normally at most one). */
export function bindingsForRoom(home: string, roomId: string): Binding[] {
  return bindingFiles(home).flatMap((path) => {
    const b = readBindingFile(path);
    return b?.room_id === roomId ? [b] : [];
  });
}

/** Removes every binding that points at room key `roomId` (on leave, end or expiry). */
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

/** The folder's binding whose `owner_session` is `sessionId`, if any (hooks, waiter, ctl). */
export function bindingOfSession(home: string, projectDir: string, sessionId: string | undefined): Binding | null {
  if (!sessionId) return null;
  return newestFirst(folderBindings(home, projectDir)).find((f) => sessionOwnsBinding(f.binding, sessionId))?.binding ?? null;
}

/**
 * Records the harness session that owns the room when the binding has none yet: Codex gives
 * the MCP server no session variable, only `_meta.sessionId` on each tool call, and in other
 * harnesses the first hook that matches the harness pid records its own (04 §10). Removes the
 * harness-pid sidecar with that write.
 */
export function adoptOwnerSession(home: string, projectDir: string, roomId: string, pid: number, session: string): boolean {
  const file = folderBindings(home, projectDir).find((f) => f.binding.room_id === roomId);
  if (!file) return false;
  return withLock(file.path, () => {
    const b = readBindingFile(file.path);
    if (!b || b.room_id !== roomId || b.owner_pid !== pid || b.owner_session !== null) return false;
    writeBinding(file.path, { ...b, owner_session: session });
    return true;
  });
}
