// Project directory and its hash, shared by the MCP server and every hook (04 §3).
import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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

function canonical(dir: string): string {
  try {
    return realpathSync(dir);
  } catch {
    return resolve(dir);
  }
}

/** First 16 hex characters of SHA-256(realpath(project_dir)). */
export function projectHash(projectDir: string): string {
  return bytesToHex(sha256(utf8ToBytes(canonical(projectDir)))).slice(0, 16);
}
