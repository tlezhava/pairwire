export interface PermissionProblem {
    path: string;
    problem: "group_or_world_access" | "symlink" | "other_owner";
}
export declare class StatePermissionError extends Error {
    readonly home: string;
    readonly problems: PermissionProblem[];
    readonly name = "StatePermissionError";
    constructor(home: string, problems: PermissionProblem[]);
}
/**
 * Checks the state directory, `bindings/`, `rooms/`, each room directory, every file in it,
 * and each room's control socket if it lives elsewhere. Empty on Windows (M7).
 */
export declare function checkStatePermissions(home: string, platform?: NodeJS.Platform, uid?: number | undefined): PermissionProblem[];
/** Throws StatePermissionError when checkStatePermissions finds anything. */
export declare function assertStatePrivate(home: string): void;
//# sourceMappingURL=permissions.d.ts.map