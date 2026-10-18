// Private directories, atomic writes and mkdir locks for the local state (04 §3, INV-9).
// Synchronous on purpose: hooks are short-lived processes and every file is small.
import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const PRIVATE_DIR_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;
/** A lock directory older than this is assumed to belong to a crashed process (04 §3). */
export const LOCK_STALE_MS = 5000;
const LOCK_TIMEOUT_MS = 2 * LOCK_STALE_MS;

export class LockTimeoutError extends Error {
  override readonly name = "LockTimeoutError";
  constructor(readonly file: string) {
    super(`Timed out waiting for the lock on ${file}.`);
  }
}

export function errorCode(e: unknown): string | undefined {
  return typeof e === "object" && e !== null && "code" in e ? String((e as { code: unknown }).code) : undefined;
}

/** Creates `path` and any missing parents as 0700 (subject to the umask, which only removes bits). */
export function ensurePrivateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: PRIVATE_DIR_MODE });
}

let tmpSeq = 0;

/** Write a temp file next to `path` with `mode`, fsync it, then rename it over `path`. */
export function writeFileAtomic(path: string, data: string | Uint8Array, mode = PRIVATE_FILE_MODE): void {
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

/** Best effort: makes the rename itself durable where the platform allows it. */
function fsyncDir(dir: string): void {
  try {
    const fd = openSync(dir, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // not supported on every platform; the rename is still atomic
  }
}

/** Deletes a file; a missing file is not an error. */
export function removeFile(path: string): void {
  try {
    unlinkSync(path);
  } catch (e) {
    if (errorCode(e) !== "ENOENT") throw e;
  }
}

function isContention(e: unknown, platform: NodeJS.Platform = process.platform): boolean {
  const code = errorCode(e);
  return code === "EEXIST" || (platform === "win32" && code === "EPERM");
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** True if this process created `path` now; false if it exists (or is being removed, on Windows). */
function tryMkdir(path: string): boolean {
  try {
    mkdirSync(path, { mode: PRIVATE_DIR_MODE });
    return true;
  } catch (e) {
    // Windows answers EPERM while another process is still removing the directory.
    if (!isContention(e)) throw e;
    return false;
  }
}

/**
 * Which directory is at `path`: device, inode and birth time. Lock directories stay empty
 * (0.1.x and 0.2.0 break stale locks with a plain rmdir), so this identity is the owner
 * token (04 §3, ADR-031).
 */
export function lockIdentity(path: string): string {
  const s = statSync(path, { bigint: true });
  return `${s.dev}:${s.ino}:${s.birthtimeNs}`;
}

export type LockInspection = { state: "gone" } | { state: "fresh" } | { state: "stale"; id: string };

/** Whether the lock directory at `lock` exists and, if so, whether it is past LOCK_STALE_MS. */
export function inspectLock(lock: string): LockInspection {
  try {
    const s = statSync(lock, { bigint: true });
    if (Date.now() - Number(s.mtimeMs) <= LOCK_STALE_MS) return { state: "fresh" };
    return { state: "stale", id: `${s.dev}:${s.ino}:${s.birthtimeNs}` };
  } catch {
    return { state: "gone" };
  }
}

/**
 * Removes the directory at `path` only if it is still the one with identity `id`: it is
 * renamed to a unique name first (only one rename of a directory can win), checked, and
 * put back if it turns out to be another one. Returns whether it removed it.
 */
function removeIfSame(path: string, id: string): boolean {
  const aside = `${path}.${randomBytes(8).toString("hex")}.gone`;
  try {
    renameSync(path, aside);
  } catch (e) {
    if (errorCode(e) === "ENOENT") return false;
    // Windows can refuse to rename a directory another process is looking at: check in place.
    try {
      if (lockIdentity(path) !== id) return false;
      rmdirSync(path);
      return true;
    } catch {
      return false;
    }
  }
  let same: boolean;
  try {
    same = lockIdentity(aside) === id;
  } catch {
    return false;
  }
  if (!same) {
    try {
      renameSync(aside, path);
      return false;
    } catch {
      // Someone took the path meanwhile; the directory we moved can't go back.
    }
  }
  try {
    rmdirSync(aside);
  } catch {
    // not empty or already gone: an older client's or a newer holder's business
  }
  return same;
}

/**
 * Breaks the stale lock `lock` whose identity was `judged` when it was found stale. Breakers
 * take `<lock>.break` first, so two processes that judged the same stale lock can't both
 * break it, and the second one never removes the lock the first then created (ADR-031).
 * Returns whether the stale lock is gone.
 */
export function breakStaleLock(lock: string, judged: string): boolean {
  const breaker = `${lock}.break`;
  if (!tryMkdir(breaker)) {
    const stuck = inspectLock(breaker);
    if (stuck.state === "stale") removeIfSame(breaker, stuck.id); // a breaker that died mid-break
    return false;
  }
  let breakerId: string | null = null;
  try {
    breakerId = lockIdentity(breaker);
    const now = inspectLock(lock);
    if (now.state === "gone") return true;
    return now.state === "stale" && now.id === judged && removeIfSame(lock, judged);
  } finally {
    if (breakerId !== null) removeIfSame(breaker, breakerId);
    else rmdirSafe(breaker);
  }
}

function rmdirSafe(path: string): void {
  try {
    rmdirSync(path);
  } catch {
    // gone already
  }
}

/**
 * Runs `fn` while holding `<file>.lock` (a directory, created atomically by mkdir). A lock
 * older than LOCK_STALE_MS is broken; breaking and releasing check the directory's identity,
 * so neither ever removes another holder's lock (04 §3).
 */
export function withLock<T>(file: string, fn: () => T): T {
  const lock = `${file}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let id: string;
  for (;;) {
    if (tryMkdir(lock)) {
      try {
        id = lockIdentity(lock);
        break;
      } catch {
        continue; // removed under us before we could look: try again
      }
    }
    const seen = inspectLock(lock);
    if (seen.state === "gone") continue; // released between our mkdir and stat
    if (seen.state === "stale" && breakStaleLock(lock, seen.id)) continue;
    if (Date.now() > deadline) throw new LockTimeoutError(file);
    sleepSync(10);
  }
  try {
    return fn();
  } finally {
    removeIfSame(lock, id);
  }
}
