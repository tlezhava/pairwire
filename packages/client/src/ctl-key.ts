// The control channel's proof key, rooms/<room_id>/ctl.key (04 §3, §8; ADR-029): 32 random
// bytes, 0600, created by the owning MCP server before it listens, deleted with `secret`.
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, openSync, readSync, renameSync, writeSync } from "node:fs";
import { bytesToHex, randomBytes } from "@noble/hashes/utils.js";
import { CTL_KEY_BYTES } from "@pairwire/core";
import { errorCode, PRIVATE_FILE_MODE, removeFile } from "./fs-util.js";
import { roomFile } from "./paths.js";

/** Why ctl.key can't be used: `corrupt` is a regular file of the wrong length. */
export type CtlKeyProblem = "unreadable" | "corrupt" | "not_private";

export class CtlKeyError extends Error {
  override readonly name = "CtlKeyError";
  constructor(readonly problem: CtlKeyProblem) {
    super(
      problem === "corrupt"
        ? "The control channel key is corrupt."
        : problem === "not_private"
          ? "The control channel key is not private."
          : "The control channel key can't be read.",
    );
  }
}

/**
 * Makes sure `ctl.key` holds a key. The new key is written and fsynced under a temporary name
 * and then published under `ctl.key`, so no reader ever sees part of one:
 *
 * - no `ctl.key`: published with a hard link, which fails rather than replace a key another
 *   process published first (that one is kept);
 * - a regular file of the wrong length (a crash while an earlier build wrote it): replaced
 *   with a rename, which never leaves `ctl.key` missing. No client can have used it, since
 *   clients refuse a key that isn't exactly 32 bytes (ADR-029);
 * - anything else, a valid key included, is left alone: never rotated, and a key the
 *   client refuses (a symlink, not private) fails closed rather than being overwritten.
 */
export function ensureCtlKey(home: string, roomId: string): void {
  const path = roomFile(home, roomId, "ctl.key");
  let replace = false;
  try {
    const st = lstatSync(path);
    if (!st.isFile() || st.size === CTL_KEY_BYTES) return;
    replace = true;
  } catch (e) {
    if (errorCode(e) !== "ENOENT") throw e;
  }
  const tmp = `${path}.${process.pid}.${bytesToHex(randomBytes(8))}.tmp`;
  try {
    const fd = openSync(tmp, "wx", PRIVATE_FILE_MODE);
    try {
      const key = randomBytes(CTL_KEY_BYTES);
      let off = 0;
      while (off < key.length) off += writeSync(fd, key, off, key.length - off);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (replace) renameSync(tmp, path);
    else {
      try {
        linkSync(tmp, path);
      } catch (e) {
        if (errorCode(e) !== "EEXIST") throw e;
      }
    }
  } finally {
    removeFile(tmp);
  }
}

const posix = process.platform !== "win32";

/**
 * The room's proof key, or null when the room has none (a room only 0.1.x servers opened,
 * where clients talk as before). Anything else that isn't a usable key throws CtlKeyError,
 * and the caller fails closed (04 §8, Failure): a file that isn't exactly 32 bytes, and on
 * POSIX a symlink, or a file that isn't regular, ours and 0600 or stricter. The hooks don't
 * run INV-9's check, so the key's privacy, which INV-10 rests on, is checked here.
 */
export function readCtlKey(home: string, roomId: string): Uint8Array | null {
  let fd: number;
  try {
    fd = openSync(roomFile(home, roomId, "ctl.key"), posix ? constants.O_RDONLY | constants.O_NOFOLLOW : "r");
  } catch (e) {
    if (errorCode(e) === "ENOENT") return null;
    throw new CtlKeyError("unreadable");
  }
  try {
    let st;
    try {
      st = fstatSync(fd);
    } catch {
      throw new CtlKeyError("unreadable");
    }
    if (!st.isFile()) throw new CtlKeyError("unreadable");
    if (posix && (st.uid !== process.getuid?.() || (st.mode & 0o077) !== 0)) throw new CtlKeyError("not_private");
    if (st.size !== CTL_KEY_BYTES) throw new CtlKeyError("corrupt");
    const key = new Uint8Array(CTL_KEY_BYTES + 1);
    let n = 0;
    try {
      while (n < key.length) {
        const r = readSync(fd, key, n, key.length - n, null);
        if (r === 0) break;
        n += r;
      }
    } catch {
      throw new CtlKeyError("unreadable");
    }
    if (n !== CTL_KEY_BYTES) throw new CtlKeyError("corrupt");
    return key.slice(0, CTL_KEY_BYTES);
  } finally {
    closeSync(fd);
  }
}
