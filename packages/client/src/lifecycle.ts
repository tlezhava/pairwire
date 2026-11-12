// Leaving and ending rooms locally (04 §3).
import { removeBindingFor } from "./binding.js";
import { removeFile } from "./fs-util.js";
import { wipeGroupSessions } from "./group-files.js";
import { roomFile } from "./paths.js";
import { type RoomState, updateState } from "./state.js";

/**
 * Removes a room locally: status `left` or `ended`, secret, ctl.key, session keys and member
 * token deleted, binding removed. `transcript.md` and `inbox.jsonl` stay until `pairwire purge`.
 */
export function closeRoomLocally(home: string, roomId: string, status: "left" | "ended", error: string | null = null): RoomState {
  removeFile(roomFile(home, roomId, "secret"));
  removeFile(roomFile(home, roomId, "ctl.key")); // deleted with the secret (ADR-029)
  const state = updateState(home, roomId, (s) => ({
    ...s,
    status,
    token: null,
    sessions: { current: null, previous: null },
    error: error ?? s.error,
  }));
  removeFile(roomFile(home, roomId, "caps.json")); // the sessions it describes are gone
  wipeGroupSessions(home, roomId); // a group room's per-peer keys (04 §4, Group rooms)
  removeBindingFor(home, roomId);
  return state;
}
