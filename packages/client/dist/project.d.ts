/**
 * `PAIRWIRE_PROJECT_DIR`, else `CLAUDE_PROJECT_DIR`, else the git root of `cwd`, else `cwd`.
 * Hooks pass the hook input's `cwd`.
 */
export declare function resolveProjectDir(env: NodeJS.ProcessEnv, cwd: string): string;
/** Walks up from `dir` to the nearest directory containing `.git` (a directory or a worktree file). */
export declare function gitRoot(dir: string): string | null;
/** First 16 hex characters of SHA-256(realpath(project_dir)). */
export declare function projectHash(projectDir: string): string;
//# sourceMappingURL=project.d.ts.map