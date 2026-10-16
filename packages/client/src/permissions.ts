// INV-9: local state is private. The client refuses to start when the state directory or any
// room file is accessible to other users, and says how to fix it.
import { lstatSync, readdirSync, statSync, type Stats } from "node:fs";
import { join } from "node:path";
import { errorCode } from "./fs-util.js";
import { bindingsDir, roomsDir } from "./paths.js";
import { listRooms, readState } from "./state.js";

export interface PermissionProblem {
  path: string;
  problem: "group_or_world_access" | "symlink" | "other_owner";
}

export class StatePermissionError extends Error {
  override readonly name = "StatePermissionError";
  constructor(
    readonly home: string,
    readonly problems: PermissionProblem[],
  ) {
    const list = problems.map((p) => `${p.path} (${describe(p.problem)})`).join(", ");
    super(
      `pairwire refuses to start: its state must be private to you, but ${list}. ` +
        `Fix with: chmod -R go-rwx '${home}'` +
        (problems.some((p) => p.problem !== "group_or_world_access") ? `, and remove anything there you didn't create.` : "."),
    );
  }
}

function describe(problem: PermissionProblem["problem"]): string {
  if (problem === "symlink") return "is a symbolic link";
  if (problem === "other_owner") return "is owned by another user";
  return "is accessible to other users";
}

function stat(path: string, follow: boolean): Stats | null {
  try {
    return follow ? statSync(path) : lstatSync(path);
  } catch (e) {
    if (errorCode(e) === "ENOENT") return null;
    throw e;
  }
}

/**
 * Checks the state directory, `bindings/`, `rooms/`, each room directory, every file in it,
 * and each room's control socket if it lives elsewhere. Empty on Windows, which has no mode bits:
 * there the state relies on the ACL it inherits from the user profile, and `doctor` warns when
 * it lives outside the profile (04 §3, ADR-024).
 */
export function checkStatePermissions(home: string, platform: NodeJS.Platform = process.platform, uid = process.getuid?.()): PermissionProblem[] {
  if (platform === "win32") return [];
  const problems: PermissionProblem[] = [];
  const check = (path: string, follow = false) => {
    const st = stat(path, follow);
    if (!st) return;
    if (st.isSymbolicLink()) problems.push({ path, problem: "symlink" });
    else if (uid !== undefined && st.uid !== uid) problems.push({ path, problem: "other_owner" });
    else if ((st.mode & 0o077) !== 0) problems.push({ path, problem: "group_or_world_access" });
  };

  // The state directory itself may be a symlink (for example to another disk); its target is checked.
  check(home, true);
  check(bindingsDir(home));
  check(roomsDir(home));
  for (const roomId of listRooms(home)) {
    const dir = join(roomsDir(home), roomId);
    check(dir);
    for (const name of readdirSync(dir).sort()) check(join(dir, name));
    try {
      const ctl = readState(home, roomId)?.ctl_path;
      if (ctl && !ctl.startsWith(dir)) check(ctl);
    } catch {
      // an unreadable state file is reported when the room is used
    }
  }
  return problems;
}

/** Throws StatePermissionError when checkStatePermissions finds anything. */
export function assertStatePrivate(home: string): void {
  const problems = checkStatePermissions(home);
  if (problems.length > 0) throw new StatePermissionError(home, problems);
}
