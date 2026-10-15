// Leaving and ending rooms locally (04 §3).
import { removeBindingFor } from "./binding.js";
import { removeFile } from "./fs-util.js";
import { roomFile } from "./paths.js";
import { updateState } from "./state.js";
/**
 * Removes a room locally: status `left` or `ended`, secret, session keys and member token
 * deleted, binding removed. `transcript.md` and `inbox.jsonl` stay until `pairwire purge`.
 */
export function closeRoomLocally(home, roomId, status, error = null) {
    removeFile(roomFile(home, roomId, "secret"));
    const state = updateState(home, roomId, (s) => ({
        ...s,
        status,
        token: null,
        sessions: { current: null, previous: null },
        error: error ?? s.error,
    }));
    removeBindingFor(home, roomId);
    return state;
}
//# sourceMappingURL=lifecycle.js.map