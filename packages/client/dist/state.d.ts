import { z } from "zod";
declare const sessionSchema: z.ZodObject<{
    sid: z.ZodString;
    send_key: z.ZodString;
    recv_key: z.ZodString;
}, z.core.$strict>;
export type StoredSession = z.infer<typeof sessionSchema>;
export declare const ROOM_STATUSES: readonly ["waiting", "active", "left", "ended"];
export type RoomStatus = (typeof ROOM_STATUSES)[number];
export declare const roomStateSchema: z.ZodObject<{
    relay: z.ZodNullable<z.ZodString>;
    member: z.ZodNullable<z.ZodEnum<{
        a: "a";
        b: "b";
    }>>;
    token: z.ZodNullable<z.ZodString>;
    epoch: z.ZodNullable<z.ZodNumber>;
    sessions: z.ZodObject<{
        current: z.ZodNullable<z.ZodObject<{
            sid: z.ZodString;
            send_key: z.ZodString;
            recv_key: z.ZodString;
        }, z.core.$strict>>;
        previous: z.ZodNullable<z.ZodObject<{
            sid: z.ZodString;
            send_key: z.ZodString;
            recv_key: z.ZodString;
        }, z.core.$strict>>;
    }, z.core.$strict>;
    my_seq: z.ZodNumber;
    peer_max_seq: z.ZodNumber;
    peer: z.ZodNullable<z.ZodObject<{
        name: z.ZodString;
        harness: z.ZodString;
        instance: z.ZodString;
    }, z.core.$strict>>;
    hop_count: z.ZodNumber;
    status: z.ZodEnum<{
        active: "active";
        waiting: "waiting";
        left: "left";
        ended: "ended";
    }>;
    created_at: z.ZodNumber;
    expires_at: z.ZodNullable<z.ZodNumber>;
    ctl_path: z.ZodString;
    error: z.ZodNullable<z.ZodString>;
    bypass_warned_sessions: z.ZodArray<z.ZodString>;
}, z.core.$strict>;
export type RoomState = z.infer<typeof roomStateSchema>;
export declare class StateError extends Error {
    readonly name = "StateError";
}
export interface NewRoom {
    roomId: string;
    secret: Uint8Array;
    /** host[:port], or null for the built-in default relay. */
    relay: string | null;
    now: number;
}
/** Creates rooms/<id>/ with the secret and a `waiting` state. Fails if the room already exists. */
export declare function createRoom(home: string, room: NewRoom, env?: NodeJS.ProcessEnv): RoomState;
/** The room's state, or null if this machine has no such room. */
export declare function readState(home: string, roomId: string): RoomState | null;
/** Read-modify-write of state.json under its lock. Returns the new state. */
export declare function updateState(home: string, roomId: string, change: (state: RoomState) => RoomState): RoomState;
/** The 32-byte room secret, or null once it has been deleted (left or ended rooms). */
export declare function readSecret(home: string, roomId: string): Uint8Array | null;
/** All room ids stored on this machine. */
export declare function listRooms(home: string): string[];
/** The relay's `expires_at`, or created_at + 7 days before the first `joined` (04 §3). */
export declare function expiresAt(state: RoomState): number;
export declare const isOpen: (state: RoomState) => boolean;
/** The `active` flag exists iff some room on this machine is waiting or active (04 §6, run.sh). */
export declare function refreshActiveFlag(home: string): boolean;
export {};
//# sourceMappingURL=state.d.ts.map