import { z } from "zod";
export declare const bindingSchema: z.ZodObject<{
    project_dir: z.ZodString;
    room_id: z.ZodString;
    owner_pid: z.ZodNumber;
    owner_session: z.ZodNullable<z.ZodString>;
    updated_at: z.ZodNumber;
}, z.core.$strict>;
export type Binding = z.infer<typeof bindingSchema>;
/** The MCP server asking: its own pid and the harness session id it was given, if any. */
export interface Claimant {
    pid: number;
    /** `CLAUDE_CODE_SESSION_ID` in Claude Code (S2); null in harnesses without one. */
    session: string | null;
    now: number;
}
export type Ownership = {
    kind: "idle";
} | {
    kind: "passive";
    ownerPid: number;
    roomId: string;
} | {
    kind: "owner";
    roomId: string;
    tookOver: boolean;
};
export declare class PassiveSessionError extends Error {
    readonly ownerPid: number;
    readonly name = "PassiveSessionError";
    constructor(ownerPid: number);
}
export declare const bindingPath: (home: string, projectDir: string) => string;
/** A pid that exists, even if owned by another user (EPERM), counts as alive. */
export declare function isProcessAlive(pid: number): boolean;
export declare function readBinding(home: string, projectDir: string): Binding | null;
/**
 * What the MCP server starting in `projectDir` should do (04 §3): no binding → idle; a live
 * owner that isn't us → passive; a dead owner → take over (REQ-ROOM-6). Done under the
 * binding's lock, so two servers starting together can't both take over (ADR-018).
 */
export declare function claimProject(home: string, projectDir: string, me: Claimant, alive?: (pid: number) => boolean): Ownership;
/**
 * Binds `roomId` to the project for `start`/`join`. Refuses with PassiveSessionError when a
 * live session other than `me` holds an open room here.
 */
export declare function bindProject(home: string, projectDir: string, roomId: string, me: Claimant, alive?: (pid: number) => boolean): Binding;
/** Removes every binding that points at `roomId` (on leave, end or expiry). */
export declare function removeBindingFor(home: string, roomId: string): void;
/**
 * Hooks deliver only for the owning session (04 §3): the hook input's `session_id` must equal
 * the binding's `owner_session`. Without a session id the room relies on pull (D1).
 */
export declare function sessionOwnsBinding(binding: Binding | null, sessionId: string | undefined): boolean;
//# sourceMappingURL=binding.d.ts.map