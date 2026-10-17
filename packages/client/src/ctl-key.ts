// The control channel's proof key, rooms/<room_id>/ctl.key (04 §3, §8; ADR-029): 32 random
// bytes, 0600, created by the owning MCP server before it listens, deleted with `secret`.
import { closeSync, fsyncSync, openSync, readFileSync, writeSync } from "node:fs";
import { randomBytes } from "@noble/hashes/utils.js";
import { CTL_KEY_BYTES } from "@pairwire/core";
import { errorCode, PRIVATE_FILE_MODE, removeFile } from "./fs-util.js";
import { roomFile } from "./paths.js";

export class CtlKeyError extends Error {
  override readonly name = "CtlKeyError";
}

/**
 * Creates `ctl.key` with an exclusive create unless it exists. Never replaces an existing key:
 * clients may already hold it. A half-written file is removed before the error propagates.
 */
export function ensureCtlKey(home: string, roomId: string): void {
  const path = roomFile(home, roomId, "ctl.key");
  let fd: number;
  try {
    fd = openSync(path, "wx", PRIVATE_FILE_MODE);
  } catch (e) {
    if (errorCode(e) === "EEXIST") return;
    throw e;
  }
  try {
    try {
      const key = randomBytes(CTL_KEY_BYTES);
      let off = 0;
      while (off < key.length) off += writeSync(fd, key, off, key.length - off);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch (e) {
    removeFile(path);
    throw e;
  }
}

/**
 * The room's proof key, or null when the room has none (a room only 0.1.x servers opened,
 * where clients talk as before). A file that exists but isn't exactly 32 bytes throws: the
 * caller fails closed (04 §8, Failure).
 */
export function readCtlKey(home: string, roomId: string): Uint8Array | null {
  let bytes: Buffer;
  try {
    bytes = readFileSync(roomFile(home, roomId, "ctl.key"));
  } catch (e) {
    if (errorCode(e) === "ENOENT") return null;
    throw new CtlKeyError("The control channel key can't be read.");
  }
  if (bytes.length !== CTL_KEY_BYTES) throw new CtlKeyError("The control channel key is corrupt.");
  return new Uint8Array(bytes);
}
