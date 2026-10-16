import { createRequire as __pwCreateRequire } from "node:module";
const require = __pwCreateRequire(import.meta.url);

// packages/client/src/platform.ts
import { existsSync } from "node:fs";
import * as path from "node:path";
function envValue(env, name) {
  const upper = name.toUpperCase();
  const key = Object.keys(env).find((k) => k.toUpperCase() === upper);
  const value = key === void 0 ? void 0 : env[key];
  return value === "" ? void 0 : value;
}
function findDistDir(here, isRoot, p = path) {
  for (const dir of [here, p.dirname(here)]) {
    if (p.basename(dir) === "dist" && isRoot(p.dirname(dir))) return dir;
  }
  return null;
}
function isInsideDir(child, parent, p = path.win32) {
  const rel = p.relative(parent, child);
  return rel === "" || !rel.startsWith("..") && !p.isAbsolute(rel);
}
function findGitBash(env, exists = existsSync) {
  const w = path.win32;
  const configured = envValue(env, "CLAUDE_CODE_GIT_BASH_PATH");
  if (configured) return exists(configured) ? configured : null;
  const candidates = [];
  for (const entry of (envValue(env, "PATH") ?? "").split(";")) {
    const dir = entry.trim().replace(/^"(.*)"$/, "$1");
    if (dir === "" || !exists(w.join(dir, "git.exe"))) continue;
    candidates.push(w.join(dir, "..", "bin", "bash.exe"), w.join(dir, "..", "..", "bin", "bash.exe"));
  }
  const localPrograms = envValue(env, "LOCALAPPDATA");
  for (const base of [envValue(env, "ProgramFiles"), envValue(env, "ProgramFiles(x86)"), localPrograms && w.join(localPrograms, "Programs")]) {
    if (base) candidates.push(w.join(base, "Git", "bin", "bash.exe"));
  }
  return candidates.find((c) => exists(c)) ?? null;
}

export {
  envValue,
  findDistDir,
  isInsideDir,
  findGitBash
};
