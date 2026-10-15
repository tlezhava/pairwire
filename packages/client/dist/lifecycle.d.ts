import { type RoomState } from "./state.js";
/**
 * Removes a room locally: status `left` or `ended`, secret, session keys and member token
 * deleted, binding removed. `transcript.md` and `inbox.jsonl` stay until `pairwire purge`.
 */
export declare function closeRoomLocally(home: string, roomId: string, status: "left" | "ended", error?: string | null): RoomState;
//# sourceMappingURL=lifecycle.d.ts.map