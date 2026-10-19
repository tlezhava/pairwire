// Layout of the local state directory (04 §3).
import { homedir } from "node:os";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, randomBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { join, resolve } from "node:path";

export const ROOM_ID_PATTERN = /^[a-z2-7]{26}$/;

export type RoomFile = "secret" | "ctl.key" | "state.json" | "caps.json" | "inbox.jsonl" | "delivered.json" | "outbox.jsonl" | "coord-sent.jsonl" | "transcript.md" | "wake-prompted.json";

/** `PAIRWIRE_HOME`, else `~/.pairwire`. */
export function pairwireHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.PAIRWIRE_HOME ? resolve(env.PAIRWIRE_HOME) : join(homedir(), ".pairwire");
}

export const configPath = (home: string) => join(home, "config.json");
export const activeFlagPath = (home: string) => join(home, "active");
export const hookErrorsPath = (home: string) => join(home, "hook-errors.log");
/** The folder of the last Cursor hook that found no room (ADR-034), for diagnosis. */
export const cursorMissPath = (home: string) => join(home, "hook-cursor-miss.json");
export const bindingsDir = (home: string) => join(home, "bindings");
export const roomsDir = (home: string) => join(home, "rooms");

export function assertRoomId(roomId: string): void {
  if (!ROOM_ID_PATTERN.test(roomId)) throw new Error("Invalid room id.");
}

export function roomDir(home: string, roomId: string): string {
  assertRoomId(roomId);
  return join(roomsDir(home), roomId);
}

export function roomFile(home: string, roomId: string, file: RoomFile): string {
  return join(roomDir(home, roomId), file);
}

/** Unix socket paths must stay short: macOS allows 104 bytes (04 §3, Control socket path). */
const MAX_SOCKET_PATH_BYTES = 100;

/**
 * `rooms/<id>/ctl.sock` if that is under 100 bytes, else `$XDG_RUNTIME_DIR/pairwire-<tag>.sock`,
 * else `/tmp/pairwire-<uid>/<tag>.sock` (created 0700 by the listener). The tag hashes the state
 * directory with the room id: two members of one room may share a machine.
 *
 * On Windows always a named pipe, `\\.\pipe\pairwire-<tag>-<nonce>`, with a random nonce on every
 * call: pipe names are machine-wide and listable, so a fixed name could be held by another user
 * while the server is down (04 §8, ADR-024).
 */
export function chooseCtlPath(
  home: string,
  roomId: string,
  env: NodeJS.ProcessEnv = process.env,
  uid = process.getuid?.() ?? 0,
  platform: NodeJS.Platform = process.platform,
  nonce: () => Uint8Array = () => randomBytes(16),
): string {
  const tag = bytesToHex(sha256(utf8ToBytes(`${home}\n${roomId}`))).slice(0, 16);
  if (platform === "win32") {
    assertRoomId(roomId);
    return `${PIPE_PREFIX}pairwire-${tag}-${bytesToHex(nonce())}`;
  }
  const inRoom = join(roomDir(home, roomId), "ctl.sock");
  if (Buffer.byteLength(inRoom) < MAX_SOCKET_PATH_BYTES) return inRoom;
  if (env.XDG_RUNTIME_DIR) return join(env.XDG_RUNTIME_DIR, `pairwire-${tag}.sock`);
  return join("/tmp", `pairwire-${uid}`, `${tag}.sock`);
}

const PIPE_PREFIX = "\\\\.\\pipe\\";

/** A Windows named pipe path (`\\.\pipe\…` or `\\?\pipe\…`): no file, mode or directory to manage. */
export function isNamedPipePath(path: string): boolean {
  return /^[\\/]{2}[.?][\\/]pipe[\\/]/i.test(path);
}
