export declare const PRIVATE_DIR_MODE = 448;
export declare const PRIVATE_FILE_MODE = 384;
/** A lock directory older than this is assumed to belong to a crashed process (04 §3). */
export declare const LOCK_STALE_MS = 5000;
export declare class LockTimeoutError extends Error {
    readonly file: string;
    readonly name = "LockTimeoutError";
    constructor(file: string);
}
export declare function errorCode(e: unknown): string | undefined;
/** Creates `path` and any missing parents as 0700 (subject to the umask, which only removes bits). */
export declare function ensurePrivateDir(path: string): void;
/** Write a temp file next to `path` with `mode`, fsync it, then rename it over `path`. */
export declare function writeFileAtomic(path: string, data: string | Uint8Array, mode?: number): void;
/** Deletes a file; a missing file is not an error. */
export declare function removeFile(path: string): void;
/**
 * Runs `fn` while holding `<file>.lock` (a directory, created atomically by mkdir). A lock
 * older than LOCK_STALE_MS is broken.
 */
export declare function withLock<T>(file: string, fn: () => T): T;
//# sourceMappingURL=fs-util.d.ts.map