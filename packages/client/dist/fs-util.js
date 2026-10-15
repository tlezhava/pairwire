// Private directories, atomic writes and mkdir locks for the local state (04 §3, INV-9).
// Synchronous on purpose: hooks are short-lived processes and every file is small.
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
export const PRIVATE_DIR_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;
/** A lock directory older than this is assumed to belong to a crashed process (04 §3). */
export const LOCK_STALE_MS = 5000;
const LOCK_TIMEOUT_MS = 2 * LOCK_STALE_MS;
export class LockTimeoutError extends Error {
    file;
    name = "LockTimeoutError";
    constructor(file) {
        super(`Timed out waiting for the lock on ${file}.`);
        this.file = file;
    }
}
export function errorCode(e) {
    return typeof e === "object" && e !== null && "code" in e ? String(e.code) : undefined;
}
/** Creates `path` and any missing parents as 0700 (subject to the umask, which only removes bits). */
export function ensurePrivateDir(path) {
    mkdirSync(path, { recursive: true, mode: PRIVATE_DIR_MODE });
}
let tmpSeq = 0;
/** Write a temp file next to `path` with `mode`, fsync it, then rename it over `path`. */
export function writeFileAtomic(path, data, mode = PRIVATE_FILE_MODE) {
    const tmp = `${path}.${process.pid}.${tmpSeq++}.tmp`;
    const fd = openSync(tmp, "wx", mode);
    try {
        try {
            writeFileSync(fd, data);
            fsyncSync(fd);
        }
        finally {
            closeSync(fd);
        }
        renameSync(tmp, path);
    }
    catch (e) {
        removeFile(tmp);
        throw e;
    }
    fsyncDir(dirname(path));
}
/** Best effort: makes the rename itself durable where the platform allows it. */
function fsyncDir(dir) {
    try {
        const fd = openSync(dir, "r");
        try {
            fsyncSync(fd);
        }
        finally {
            closeSync(fd);
        }
    }
    catch {
        // not supported on every platform; the rename is still atomic
    }
}
/** Deletes a file; a missing file is not an error. */
export function removeFile(path) {
    try {
        unlinkSync(path);
    }
    catch (e) {
        if (errorCode(e) !== "ENOENT")
            throw e;
    }
}
function sleepSync(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
/**
 * Runs `fn` while holding `<file>.lock` (a directory, created atomically by mkdir). A lock
 * older than LOCK_STALE_MS is broken.
 */
export function withLock(file, fn) {
    const lock = `${file}.lock`;
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    for (;;) {
        try {
            mkdirSync(lock, { mode: PRIVATE_DIR_MODE });
            break;
        }
        catch (e) {
            if (errorCode(e) !== "EEXIST")
                throw e;
        }
        try {
            if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) {
                rmdirSync(lock);
                continue;
            }
        }
        catch {
            continue; // released between our mkdir and stat
        }
        if (Date.now() > deadline)
            throw new LockTimeoutError(file);
        sleepSync(10);
    }
    try {
        return fn();
    }
    finally {
        try {
            rmdirSync(lock);
        }
        catch {
            // already broken as stale by another process
        }
    }
}
//# sourceMappingURL=fs-util.js.map