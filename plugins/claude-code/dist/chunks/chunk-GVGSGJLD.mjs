import { createRequire as __pwCreateRequire } from "node:module";
const require = __pwCreateRequire(import.meta.url);
import {
  bytesToHex,
  randomBytes,
  sha256,
  utf8ToBytes
} from "./chunk-KARZWXGF.mjs";

// packages/client/src/paths.ts
import { homedir } from "node:os";
import { join, resolve } from "node:path";
var ROOM_ID_PATTERN = /^[a-z2-7]{26}$/;
function pairwireHome(env = process.env) {
  return env.PAIRWIRE_HOME ? resolve(env.PAIRWIRE_HOME) : join(homedir(), ".pairwire");
}
var configPath = (home) => join(home, "config.json");
var activeFlagPath = (home) => join(home, "active");
var hookErrorsPath = (home) => join(home, "hook-errors.log");
var bindingsDir = (home) => join(home, "bindings");
var roomsDir = (home) => join(home, "rooms");
function assertRoomId(roomId) {
  if (!ROOM_ID_PATTERN.test(roomId)) throw new Error("Invalid room id.");
}
function roomDir(home, roomId) {
  assertRoomId(roomId);
  return join(roomsDir(home), roomId);
}
function roomFile(home, roomId, file) {
  return join(roomDir(home, roomId), file);
}
var MAX_SOCKET_PATH_BYTES = 100;
function chooseCtlPath(home, roomId, env = process.env, uid = process.getuid?.() ?? 0, platform = process.platform, nonce = () => randomBytes(16)) {
  const tag = bytesToHex(sha256(utf8ToBytes(`${home}
${roomId}`))).slice(0, 16);
  if (platform === "win32") {
    assertRoomId(roomId);
    return `${PIPE_PREFIX}pairwire-${tag}-${bytesToHex(nonce())}`;
  }
  const inRoom = join(roomDir(home, roomId), "ctl.sock");
  if (Buffer.byteLength(inRoom) < MAX_SOCKET_PATH_BYTES) return inRoom;
  if (env.XDG_RUNTIME_DIR) return join(env.XDG_RUNTIME_DIR, `pairwire-${tag}.sock`);
  return join("/tmp", `pairwire-${uid}`, `${tag}.sock`);
}
var PIPE_PREFIX = "\\\\.\\pipe\\";
function isNamedPipePath(path) {
  return /^[\\/]{2}[.?][\\/]pipe[\\/]/i.test(path);
}

export {
  ROOM_ID_PATTERN,
  pairwireHome,
  configPath,
  activeFlagPath,
  hookErrorsPath,
  bindingsDir,
  roomsDir,
  roomDir,
  roomFile,
  chooseCtlPath,
  isNamedPipePath
};
