// `pairwire install --codex [--uninstall]` and `pairwire install --print-config <harness>`
// (04 §10). Edits only what it owns: a marked block in config.toml, its own hooks.json
// entries, its skill; it backs up every file before changing it.
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { HARNESSES } from "@pairwire/core";
import { findDistDir } from "./platform.js";

export const MARK_BEGIN = "# >>> pairwire >>>";
export const MARK_END = "# <<< pairwire <<<";
const SKILL_MARK = "Generated from specs/06-agent-guide.md";
const CODEX_HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop"] as const;
const EVENT_ARG: Record<(typeof CODEX_HOOK_EVENTS)[number], string> = {
  SessionStart: "session-start",
  UserPromptSubmit: "user-prompt-submit",
  PostToolUse: "post-tool-use",
  Stop: "stop",
};
/** Passed by name: Codex starts MCP servers with a cleared environment (04 §10). */
const ENV_VARS = ["PAIRWIRE_HOME", "PAIRWIRE_RELAY", "PAIRWIRE_NAME", "PAIRWIRE_DELIVERY", "PAIRWIRE_LOG", "PAIRWIRE_HOLD"];

export interface InstallOptions {
  /** The plugin layout to install from: contains dist/, hooks/run.sh, skills/. */
  sourceRoot: string;
  pairwireHome: string;
  /** The user's home directory (for ~/.agents/skills). */
  userHome: string;
  codexHome: string;
  out: Writable;
  now?: () => Date;
}

export class InstallError extends Error {
  override readonly name = "InstallError";
}

/** The plugin root this code runs from: `<root>/dist/pairwire.mjs` or a chunk under `dist/chunks/`. */
export function runningPluginRoot(): string | null {
  const dist = findDistDir(dirname(fileURLToPath(import.meta.url)), (root) => existsSync(join(root, "hooks", "run.sh")));
  return dist && dirname(dist);
}

export function defaultInstallOptions(env: NodeJS.ProcessEnv, out: Writable, pairwireHome: string): InstallOptions | null {
  const sourceRoot = runningPluginRoot();
  if (!sourceRoot) return null;
  const userHome = env.HOME || homedir();
  return { sourceRoot, pairwireHome, userHome, codexHome: env.CODEX_HOME || join(userHome, ".codex"), out };
}

/** A POSIX shell word for `s`: single quotes keep `$`, backticks and backslashes literal. */
export function shellQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

/**
 * A TOML string for a path (04 §10): a literal string, so Windows backslashes stay as they
 * are, or a basic string with `\` and `"` escaped when the path holds a `'`. Callers refuse
 * paths with control characters or lone surrogates first (pathProblem), which TOML can't hold.
 */
export function tomlPath(s: string): string {
  return s.includes("'") ? `"${s.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"` : `'${s}'`;
}

/** Why `p` can't be written into a shell command and config.toml, or null (ADR-031). */
export function pathProblem(p: string): string | null {
  for (let i = 0; i < p.length; i++) {
    const c = p.charCodeAt(i);
    if (c <= 0x1f || (c >= 0x7f && c <= 0x9f)) return "a control character";
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = p.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        i++;
        continue;
      }
      return "an unpaired UTF-16 surrogate";
    }
    if (c >= 0xdc00 && c <= 0xdfff) return "an unpaired UTF-16 surrogate";
  }
  return null;
}

function assertUsablePath(p: string, what: string): void {
  const problem = pathProblem(p);
  if (problem) {
    throw new InstallError(`The ${what} path ${JSON.stringify(p)} contains ${problem}, which Codex's config.toml can't hold. Set PAIRWIRE_HOME to a path without it.`);
  }
}

function codexToml(bundle: string): string {
  assertUsablePath(bundle, "pairwire bundle");
  return [
    "[mcp_servers.pairwire]",
    'command = "node"',
    `args = [${tomlPath(bundle)}, "mcp"]`,
    'env = { PAIRWIRE_HARNESS = "codex" }',
    `env_vars = [${ENV_VARS.map((v) => JSON.stringify(v)).join(", ")}]`,
    "startup_timeout_sec = 20",
  ].join("\n");
}

function stripBlock(text: string): string {
  const start = text.indexOf(MARK_BEGIN);
  if (start < 0) return text;
  const end = text.indexOf(MARK_END, start);
  if (end < 0) throw new InstallError(`config.toml has "${MARK_BEGIN}" without "${MARK_END}"; fix it by hand first.`);
  return (text.slice(0, start).trimEnd() + "\n" + text.slice(end + MARK_END.length).replace(/^\n+/, "")).replace(/^\n+$/, "");
}

interface HookEntry {
  type?: string;
  command?: string;
  [k: string]: unknown;
}
interface HookGroup {
  matcher?: string;
  hooks?: HookEntry[];
  [k: string]: unknown;
}
type HooksFile = { hooks?: Record<string, HookGroup[]>; [k: string]: unknown };

/**
 * Our hook commands: the run.sh path single-quoted (ADR-031), or, as 0.2.0 wrote them, quoted
 * with JSON.stringify, which doubles Windows backslashes. Match the raw path and both forms,
 * so a reinstall over 0.2.0 replaces its entries.
 */
function isOurs(command: unknown, runSh: string): boolean {
  return typeof command === "string" && [runSh, JSON.stringify(runSh), shellQuote(runSh)].some((form) => command.includes(form));
}

function withoutPairwire(file: HooksFile, runSh: string): HooksFile {
  const hooks: Record<string, HookGroup[]> = {};
  for (const [event, groups] of Object.entries(file.hooks ?? {})) {
    const kept = groups
      .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !isOurs(h.command, runSh)) }))
      .filter((g) => g.hooks.length > 0);
    if (kept.length > 0) hooks[event] = kept;
  }
  return { ...file, hooks };
}

export class Installer {
  readonly #o: InstallOptions;
  readonly #stamp: string;

  constructor(options: InstallOptions) {
    this.#o = options;
    this.#stamp = (options.now ?? (() => new Date()))().toISOString().replace(/[:.]/g, "-");
  }

  get binDir() {
    return join(this.#o.pairwireHome, "bin");
  }
  get bundle() {
    return join(this.binDir, "dist", "pairwire.mjs");
  }
  get runSh() {
    return join(this.binDir, "hooks", "run.sh");
  }
  get configPath() {
    return join(this.#o.codexHome, "config.toml");
  }
  get hooksPath() {
    return join(this.#o.codexHome, "hooks.json");
  }
  get skillPath() {
    return join(this.#o.userHome, ".agents", "skills", "pairwire", "SKILL.md");
  }

  #say(text: string) {
    this.#o.out.write(`${text}\n`);
  }

  /** Writes `text` to `path`, first copying an existing file to `<path>.pairwire-backup-<stamp>`. */
  #write(path: string, text: string) {
    if (existsSync(path)) {
      if (readFileSync(path, "utf8") === text) return;
      copyFileSync(path, `${path}.pairwire-backup-${this.#stamp}`);
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }

  installCodex(): void {
    const src = this.#o.sourceRoot;
    for (const p of ["dist/pairwire.mjs", "hooks/run.sh", "skills/pairwire/SKILL.md"]) {
      if (!existsSync(join(src, p))) throw new InstallError(`The pairwire bundle at ${src} is incomplete (missing ${p}).`);
    }
    // Check the paths and config.toml before touching anything.
    assertUsablePath(this.#o.pairwireHome, "pairwire state directory");
    assertUsablePath(this.bundle, "pairwire bundle");
    assertUsablePath(this.runSh, "hook script");
    const config = existsSync(this.configPath) ? readFileSync(this.configPath, "utf8") : "";
    const outside = stripBlock(config);
    if (/^\s*\[mcp_servers\.pairwire\]/m.test(outside) || /^\s*\[mcp_servers\.["']pairwire["']\]/m.test(outside)) {
      throw new InstallError(`${this.configPath} already defines [mcp_servers.pairwire] outside pairwire's markers. Remove it, then run this again.`);
    }
    let hooksFile: HooksFile = {};
    if (existsSync(this.hooksPath)) {
      try {
        hooksFile = JSON.parse(readFileSync(this.hooksPath, "utf8")) as HooksFile;
      } catch {
        throw new InstallError(`${this.hooksPath} is not valid JSON; fix it first.`);
      }
    }

    // 1. Files
    if (this.#o.sourceRoot !== this.binDir) {
      rmSync(join(this.binDir, "dist"), { recursive: true, force: true });
      mkdirSync(join(this.binDir, "hooks"), { recursive: true, mode: 0o700 });
      cpSync(join(src, "dist"), join(this.binDir, "dist"), { recursive: true });
      copyFileSync(join(src, "hooks", "run.sh"), this.runSh);
    }
    chmodSync(this.runSh, 0o755);
    this.#say(`installed the client in ${this.binDir}`);

    // 2. MCP server
    const block = `${MARK_BEGIN}\n${codexToml(this.bundle)}\n${MARK_END}\n`;
    this.#write(this.configPath, (outside.trimEnd() ? `${outside.trimEnd()}\n\n` : "") + block);
    this.#say(`registered the pairwire MCP server in ${this.configPath}`);

    // 3. Hooks
    const next = withoutPairwire(hooksFile, this.runSh);
    for (const event of CODEX_HOOK_EVENTS) {
      const group: HookGroup = {
        ...(event === "PostToolUse" ? { matcher: "*" } : {}),
        hooks: [{ type: "command", command: `sh ${shellQuote(this.runSh)} ${EVENT_ARG[event]}`, timeout: 10 }],
      };
      next.hooks![event] = [...(next.hooks![event] ?? []), group];
    }
    this.#write(this.hooksPath, JSON.stringify(next, null, 2) + "\n");
    this.#say(`added pairwire hooks to ${this.hooksPath}`);

    // 4. Skill
    this.#write(this.skillPath, readFileSync(join(src, "skills", "pairwire", "SKILL.md"), "utf8"));
    this.#say(`installed the pairwire skill in ${dirname(this.skillPath)}`);

    this.#say(
      [
        "",
        "Next:",
        "  1. Restart Codex.",
        "  2. Run /hooks in Codex and trust the four pairwire hooks (Codex runs no hook until you do).",
        "  3. Ask Codex to start or join a pairwire room. To send your own words or let the agent continue",
        `     after the hop budget, run in a terminal: node ${JSON.stringify(this.bundle)} ctl say|continue|log`,
        `     In hold mode, release held messages with: node ${JSON.stringify(this.bundle)} ctl accept [drop]`,
        "Keep Codex's approval prompt for the pairwire send tool on: don't choose \"always allow\" for it.",
      ].join("\n"),
    );
  }

  uninstallCodex(): void {
    if (existsSync(this.configPath)) {
      const text = readFileSync(this.configPath, "utf8");
      const stripped = stripBlock(text);
      if (stripped !== text) {
        this.#write(this.configPath, stripped.trimEnd() ? `${stripped.trimEnd()}\n` : "");
        this.#say(`removed the pairwire MCP server from ${this.configPath}`);
      }
    }
    if (existsSync(this.hooksPath)) {
      const file = JSON.parse(readFileSync(this.hooksPath, "utf8")) as HooksFile;
      this.#write(this.hooksPath, JSON.stringify(withoutPairwire(file, this.runSh), null, 2) + "\n");
      this.#say(`removed pairwire hooks from ${this.hooksPath}`);
    }
    if (existsSync(this.skillPath) && readFileSync(this.skillPath, "utf8").includes(SKILL_MARK)) {
      rmSync(dirname(this.skillPath), { recursive: true, force: true });
      this.#say(`removed the pairwire skill`);
    }
    this.#say(`left ${this.#o.pairwireHome} in place; \`pairwire purge --all\` deletes it.`);
  }
}

/** `--print-config <harness>`: the MCP entry and the agent guide to paste (04 §10). */
export function printConfig(harness: string, sourceRoot: string, out: Writable): void {
  if (!(HARNESSES as readonly string[]).includes(harness) || harness === "other") {
    throw new InstallError(`Unknown harness "${harness}". Use one of: ${HARNESSES.filter((h) => h !== "other").join(", ")}.`);
  }
  const bundle = join(sourceRoot, "dist", "pairwire.mjs");
  const entry =
    harness === "codex"
      ? codexToml(bundle)
      : JSON.stringify({ mcpServers: { pairwire: { command: "node", args: [bundle, "mcp"], env: { PAIRWIRE_HARNESS: harness } } } }, null, 2);
  const skill = readFileSync(join(sourceRoot, "skills", "pairwire", "SKILL.md"), "utf8")
    .replace(/^---\n[\s\S]*?\n---\n/, "")
    .replace(/<!-- Generated from [^\n]*-->\n/, "")
    .trim();
  out.write(
    [
      `# MCP server entry for ${harness} (adapt to where your harness keeps MCP servers):`,
      "",
      entry,
      "",
      "# Agent guide: add this to your harness's instructions (for example AGENTS.md):",
      "",
      skill,
      "",
    ].join("\n"),
  );
}
