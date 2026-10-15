// Layout of the local state directory (04 §3).
import { homedir } from "node:os";
import { join, resolve } from "node:path";
export const ROOM_ID_PATTERN = /^[a-z2-7]{26}$/;
/** `PAIRWIRE_HOME`, else `~/.pairwire`. */
export function pairwireHome(env = process.env) {
    return env.PAIRWIRE_HOME ? resolve(env.PAIRWIRE_HOME) : join(homedir(), ".pairwire");
}
export const configPath = (home) => join(home, "config.json");
export const activeFlagPath = (home) => join(home, "active");
export const hookErrorsPath = (home) => join(home, "hook-errors.log");
export const bindingsDir = (home) => join(home, "bindings");
export const roomsDir = (home) => join(home, "rooms");
export function assertRoomId(roomId) {
    if (!ROOM_ID_PATTERN.test(roomId))
        throw new Error("Invalid room id.");
}
export function roomDir(home, roomId) {
    assertRoomId(roomId);
    return join(roomsDir(home), roomId);
}
export function roomFile(home, roomId, file) {
    return join(roomDir(home, roomId), file);
}
/** Unix socket paths must stay short: macOS allows 104 bytes (04 §3, Control socket path). */
const MAX_SOCKET_PATH_BYTES = 100;
/**
 * `rooms/<id>/ctl.sock` if that is under 100 bytes, else `$XDG_RUNTIME_DIR/pairwire-<id12>.sock`,
 * else `/tmp/pairwire-<uid>/<id12>.sock` (the caller creates that directory as 0700).
 */
export function chooseCtlPath(home, roomId, env = process.env, uid = process.getuid?.() ?? 0) {
    const inRoom = join(roomDir(home, roomId), "ctl.sock");
    if (Buffer.byteLength(inRoom) < MAX_SOCKET_PATH_BYTES)
        return inRoom;
    const short = roomId.slice(0, 12);
    if (env.XDG_RUNTIME_DIR)
        return join(env.XDG_RUNTIME_DIR, `pairwire-${short}.sock`);
    return join("/tmp", `pairwire-${uid}`, `${short}.sock`);
}
//# sourceMappingURL=paths.js.map