import { createRequire as __pwCreateRequire } from "node:module";
const require = __pwCreateRequire(import.meta.url);
import {
  errorCode,
  listRooms,
  readState
} from "./chunk-4WTSVBRV.mjs";
import {
  bindingsDir,
  roomsDir
} from "./chunk-AOSSRO7Z.mjs";

// packages/client/src/permissions.ts
import { lstatSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
var StatePermissionError = class extends Error {
  constructor(home, problems) {
    const list = problems.map((p) => `${p.path} (${describe(p.problem)})`).join(", ");
    super(
      `pairwire refuses to start: its state must be private to you, but ${list}. Fix with: chmod -R go-rwx '${home}'` + (problems.some((p) => p.problem !== "group_or_world_access") ? `, and remove anything there you didn't create.` : ".")
    );
    this.home = home;
    this.problems = problems;
  }
  home;
  problems;
  name = "StatePermissionError";
};
function describe(problem) {
  if (problem === "symlink") return "is a symbolic link";
  if (problem === "other_owner") return "is owned by another user";
  return "is accessible to other users";
}
function stat(path, follow) {
  try {
    return follow ? statSync(path) : lstatSync(path);
  } catch (e) {
    if (errorCode(e) === "ENOENT") return null;
    throw e;
  }
}
function checkStatePermissions(home, platform = process.platform, uid = process.getuid?.()) {
  if (platform === "win32") return [];
  const problems = [];
  const check = (path, follow = false) => {
    const st = stat(path, follow);
    if (!st) return;
    if (st.isSymbolicLink()) problems.push({ path, problem: "symlink" });
    else if (uid !== void 0 && st.uid !== uid) problems.push({ path, problem: "other_owner" });
    else if ((st.mode & 63) !== 0) problems.push({ path, problem: "group_or_world_access" });
  };
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
    }
  }
  return problems;
}
function assertStatePrivate(home) {
  const problems = checkStatePermissions(home);
  if (problems.length > 0) throw new StatePermissionError(home, problems);
}

export {
  StatePermissionError,
  checkStatePermissions,
  assertStatePrivate
};
