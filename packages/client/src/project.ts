// Project directory and its hash, shared by the MCP server and every hook (04 §3).
import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve, win32 } from "node:path";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

/** A value such as "${CLAUDE_PROJECT_DIR}" means the harness didn't expand it. */
const usable = (value: string | undefined): value is string => !!value && !value.includes("${");

/**
 * `PAIRWIRE_PROJECT_DIR`, else `CLAUDE_PROJECT_DIR`, else the git root of `cwd`, else `cwd`.
 * Hooks pass the hook input's `cwd`.
 */
export function resolveProjectDir(env: NodeJS.ProcessEnv, cwd: string): string {
  if (usable(env.PAIRWIRE_PROJECT_DIR)) return canonical(env.PAIRWIRE_PROJECT_DIR);
  if (usable(env.CLAUDE_PROJECT_DIR)) return canonical(env.CLAUDE_PROJECT_DIR);
  const start = canonical(cwd);
  return gitRoot(start) ?? start;
}

/** Walks up from `dir` to the nearest directory containing `.git` (a directory or a worktree file). */
export function gitRoot(dir: string): string | null {
  for (let d = dir; ; d = dirname(d)) {
    if (existsSync(join(d, ".git"))) return d;
    if (dirname(d) === d) return null;
  }
}

function canonical(dir: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== "win32") {
    try {
      return realpathSync(dir);
    } catch {
      return resolve(dir);
    }
  }
  const d = windowsPath(dir);
  try {
    return windowsPath(realpathSync(d));
  } catch {
    return d;
  }
}

/**
 * One spelling of a Windows folder (ADR-034): harnesses write the same one as `C:\x`, `c:/x/`
 * or, from a file URI, `/c:/x`. Becomes `C:\x`: no leading slash, backslashes, no trailing
 * separator, upper-case drive letter.
 */
export function windowsPath(dir: string): string {
  const p = win32.resolve(/^\/[A-Za-z]:([\\/]|$)/.test(dir) ? dir.slice(1) : dir);
  return /^[a-z]:/.test(p) ? p.charAt(0).toUpperCase() + p.slice(1) : p;
}

/** First 16 hex characters of SHA-256(realpath(project_dir)). */
export function projectHash(projectDir: string, platform: NodeJS.Platform = process.platform): string {
  return bytesToHex(sha256(utf8ToBytes(canonical(projectDir, platform)))).slice(0, 16);
}
