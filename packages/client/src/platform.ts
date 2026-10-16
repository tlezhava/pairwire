// Platform differences (04 §1, §3, §6; ADR-021). Each helper takes its path module or file
// check as a parameter, so the Windows branches are unit-tested on every OS.
import { existsSync } from "node:fs";
import * as path from "node:path";
import type { PlatformPath } from "node:path";

/** An environment variable by name, ignoring case (Windows variables are case-insensitive). */
export function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const upper = name.toUpperCase();
  const key = Object.keys(env).find((k) => k.toUpperCase() === upper);
  const value = key === undefined ? undefined : env[key];
  return value === "" ? undefined : value;
}

/**
 * The bundle's `dist/` directory when `here` is it or a directory inside it (`dist/chunks/`),
 * and `isRoot` accepts its parent as a plugin root; else null.
 */
export function findDistDir(here: string, isRoot: (root: string) => boolean, p: PlatformPath = path): string | null {
  for (const dir of [here, p.dirname(here)]) {
    if (p.basename(dir) === "dist" && isRoot(p.dirname(dir))) return dir;
  }
  return null;
}

/** Whether `child` is `parent` or inside it, by Windows rules (case-insensitive). */
export function isInsideDir(child: string, parent: string, p: PlatformPath = path.win32): boolean {
  const rel = p.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !p.isAbsolute(rel));
}

/**
 * Where Git Bash is on Windows, which pairwire's hooks need (04 §6): `CLAUDE_CODE_GIT_BASH_PATH`,
 * else `bin\bash.exe` of the Git install that a `git.exe` on PATH belongs to (`<Git>\cmd` or
 * `<Git>\mingw64\bin`), else the usual install directories. Null if none exists.
 */
export function findGitBash(env: NodeJS.ProcessEnv, exists: (path: string) => boolean = existsSync): string | null {
  const w = path.win32;
  const configured = envValue(env, "CLAUDE_CODE_GIT_BASH_PATH");
  if (configured) return exists(configured) ? configured : null;
  const candidates: string[] = [];
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
