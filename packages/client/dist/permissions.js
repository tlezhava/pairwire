// INV-9: local state is private. The client refuses to start when the state directory or any
// room file is accessible to other users, and says how to fix it.
import { lstatSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { errorCode } from "./fs-util.js";
import { bindingsDir, roomsDir } from "./paths.js";
import { listRooms, readState } from "./state.js";
export class StatePermissionError extends Error {
    home;
    problems;
    name = "StatePermissionError";
    constructor(home, problems) {
        const list = problems.map((p) => `${p.path} (${describe(p.problem)})`).join(", ");
        super(`pairwire refuses to start: its state must be private to you, but ${list}. ` +
            `Fix with: chmod -R go-rwx '${home}'` +
            (problems.some((p) => p.problem !== "group_or_world_access") ? `, and remove anything there you didn't create.` : "."));
        this.home = home;
        this.problems = problems;
    }
}
function describe(problem) {
    if (problem === "symlink")
        return "is a symbolic link";
    if (problem === "other_owner")
        return "is owned by another user";
    return "is accessible to other users";
}
function stat(path, follow) {
    try {
        return follow ? statSync(path) : lstatSync(path);
    }
    catch (e) {
        if (errorCode(e) === "ENOENT")
            return null;
        throw e;
    }
}
/**
 * Checks the state directory, `bindings/`, `rooms/`, each room directory, every file in it,
 * and each room's control socket if it lives elsewhere. Empty on Windows (M7).
 */
export function checkStatePermissions(home, platform = process.platform, uid = process.getuid?.()) {
    if (platform === "win32")
        return [];
    const problems = [];
    const check = (path, follow = false) => {
        const st = stat(path, follow);
        if (!st)
            return;
        if (st.isSymbolicLink())
            problems.push({ path, problem: "symlink" });
        else if (uid !== undefined && st.uid !== uid)
            problems.push({ path, problem: "other_owner" });
        else if ((st.mode & 0o077) !== 0)
            problems.push({ path, problem: "group_or_world_access" });
    };
    // The state directory itself may be a symlink (for example to another disk); its target is checked.
    check(home, true);
    check(bindingsDir(home));
    check(roomsDir(home));
    for (const roomId of listRooms(home)) {
        const dir = join(roomsDir(home), roomId);
        check(dir);
        for (const name of readdirSync(dir).sort())
            check(join(dir, name));
        try {
            const ctl = readState(home, roomId)?.ctl_path;
            if (ctl && !ctl.startsWith(dir))
                check(ctl);
        }
        catch {
            // an unreadable state file is reported when the room is used
        }
    }
    return problems;
}
/** Throws StatePermissionError when checkStatePermissions finds anything. */
export function assertStatePrivate(home) {
    const problems = checkStatePermissions(home);
    if (problems.length > 0)
        throw new StatePermissionError(home, problems);
}
//# sourceMappingURL=permissions.js.map