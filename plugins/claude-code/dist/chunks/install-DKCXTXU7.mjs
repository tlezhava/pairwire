import { createRequire as __pwCreateRequire } from "node:module";
const require = __pwCreateRequire(import.meta.url);
import {
  findDistDir
} from "./chunk-HDMYU3UC.mjs";
import {
  HARNESSES
} from "./chunk-UDXCX3FP.mjs";
import "./chunk-KARZWXGF.mjs";

// packages/client/src/install.ts
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
var MARK_BEGIN = "# >>> pairwire >>>";
var MARK_END = "# <<< pairwire <<<";
var SKILL_MARK = "Generated from specs/06-agent-guide.md";
var CODEX_HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop"];
var EVENT_ARG = {
  SessionStart: "session-start",
  UserPromptSubmit: "user-prompt-submit",
  PostToolUse: "post-tool-use",
  Stop: "stop"
};
var ENV_VARS = ["PAIRWIRE_HOME", "PAIRWIRE_RELAY", "PAIRWIRE_NAME", "PAIRWIRE_DELIVERY", "PAIRWIRE_LOG", "PAIRWIRE_HOLD"];
var InstallError = class extends Error {
  name = "InstallError";
};
function runningPluginRoot() {
  const dist = findDistDir(dirname(fileURLToPath(import.meta.url)), (root) => existsSync(join(root, "hooks", "run.sh")));
  return dist && dirname(dist);
}
function defaultInstallOptions(env, out, pairwireHome) {
  const sourceRoot = runningPluginRoot();
  if (!sourceRoot) return null;
  const userHome = env.HOME || homedir();
  return { sourceRoot, pairwireHome, userHome, codexHome: env.CODEX_HOME || join(userHome, ".codex"), out };
}
function shellQuote(s) {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}
function tomlPath(s) {
  return s.includes("'") ? `"${s.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"` : `'${s}'`;
}
function pathProblem(p) {
  for (let i = 0; i < p.length; i++) {
    const c = p.charCodeAt(i);
    if (c <= 31 || c >= 127 && c <= 159) return "a control character";
    if (c >= 55296 && c <= 56319) {
      const next = p.charCodeAt(i + 1);
      if (next >= 56320 && next <= 57343) {
        i++;
        continue;
      }
      return "an unpaired UTF-16 surrogate";
    }
    if (c >= 56320 && c <= 57343) return "an unpaired UTF-16 surrogate";
  }
  return null;
}
function assertUsablePath(p, what) {
  const problem = pathProblem(p);
  if (problem) {
    throw new InstallError(`The ${what} path ${JSON.stringify(p)} contains ${problem}, which Codex's config.toml can't hold. Set PAIRWIRE_HOME to a path without it.`);
  }
}
function codexToml(bundle) {
  assertUsablePath(bundle, "pairwire bundle");
  return [
    "[mcp_servers.pairwire]",
    'command = "node"',
    `args = [${tomlPath(bundle)}, "mcp"]`,
    'env = { PAIRWIRE_HARNESS = "codex" }',
    `env_vars = [${ENV_VARS.map((v) => JSON.stringify(v)).join(", ")}]`,
    "startup_timeout_sec = 20"
  ].join("\n");
}
function stripBlock(text) {
  const start = text.indexOf(MARK_BEGIN);
  if (start < 0) return text;
  const end = text.indexOf(MARK_END, start);
  if (end < 0) throw new InstallError(`config.toml has "${MARK_BEGIN}" without "${MARK_END}"; fix it by hand first.`);
  return (text.slice(0, start).trimEnd() + "\n" + text.slice(end + MARK_END.length).replace(/^\n+/, "")).replace(/^\n+$/, "");
}
function isOurs(command, runSh) {
  return typeof command === "string" && [runSh, JSON.stringify(runSh), shellQuote(runSh)].some((form) => command.includes(form));
}
function withoutPairwire(file, runSh) {
  const hooks = {};
  for (const [event, groups] of Object.entries(file.hooks ?? {})) {
    const kept = groups.map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !isOurs(h.command, runSh)) })).filter((g) => g.hooks.length > 0);
    if (kept.length > 0) hooks[event] = kept;
  }
  return { ...file, hooks };
}
var Installer = class {
  #o;
  #stamp;
  constructor(options) {
    this.#o = options;
    this.#stamp = (options.now ?? (() => /* @__PURE__ */ new Date()))().toISOString().replace(/[:.]/g, "-");
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
  #say(text) {
    this.#o.out.write(`${text}
`);
  }
  /** Writes `text` to `path`, first copying an existing file to `<path>.pairwire-backup-<stamp>`. */
  #write(path, text) {
    if (existsSync(path)) {
      if (readFileSync(path, "utf8") === text) return;
      copyFileSync(path, `${path}.pairwire-backup-${this.#stamp}`);
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
  installCodex() {
    const src = this.#o.sourceRoot;
    for (const p of ["dist/pairwire.mjs", "hooks/run.sh", "skills/pairwire/SKILL.md"]) {
      if (!existsSync(join(src, p))) throw new InstallError(`The pairwire bundle at ${src} is incomplete (missing ${p}).`);
    }
    assertUsablePath(this.#o.pairwireHome, "pairwire state directory");
    assertUsablePath(this.bundle, "pairwire bundle");
    assertUsablePath(this.runSh, "hook script");
    const config = existsSync(this.configPath) ? readFileSync(this.configPath, "utf8") : "";
    const outside = stripBlock(config);
    if (/^\s*\[mcp_servers\.pairwire\]/m.test(outside) || /^\s*\[mcp_servers\.["']pairwire["']\]/m.test(outside)) {
      throw new InstallError(`${this.configPath} already defines [mcp_servers.pairwire] outside pairwire's markers. Remove it, then run this again.`);
    }
    let hooksFile = {};
    if (existsSync(this.hooksPath)) {
      try {
        hooksFile = JSON.parse(readFileSync(this.hooksPath, "utf8"));
      } catch {
        throw new InstallError(`${this.hooksPath} is not valid JSON; fix it first.`);
      }
    }
    if (this.#o.sourceRoot !== this.binDir) {
      rmSync(join(this.binDir, "dist"), { recursive: true, force: true });
      mkdirSync(join(this.binDir, "hooks"), { recursive: true, mode: 448 });
      cpSync(join(src, "dist"), join(this.binDir, "dist"), { recursive: true });
      copyFileSync(join(src, "hooks", "run.sh"), this.runSh);
    }
    chmodSync(this.runSh, 493);
    this.#say(`installed the client in ${this.binDir}`);
    const block = `${MARK_BEGIN}
${codexToml(this.bundle)}
${MARK_END}
`;
    this.#write(this.configPath, (outside.trimEnd() ? `${outside.trimEnd()}

` : "") + block);
    this.#say(`registered the pairwire MCP server in ${this.configPath}`);
    const next = withoutPairwire(hooksFile, this.runSh);
    for (const event of CODEX_HOOK_EVENTS) {
      const group = {
        ...event === "PostToolUse" ? { matcher: "*" } : {},
        hooks: [{ type: "command", command: `sh ${shellQuote(this.runSh)} ${EVENT_ARG[event]}`, timeout: 10 }]
      };
      next.hooks[event] = [...next.hooks[event] ?? [], group];
    }
    this.#write(this.hooksPath, JSON.stringify(next, null, 2) + "\n");
    this.#say(`added pairwire hooks to ${this.hooksPath}`);
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
        `Keep Codex's approval prompt for the pairwire send tool on: don't choose "always allow" for it.`
      ].join("\n")
    );
  }
  uninstallCodex() {
    if (existsSync(this.configPath)) {
      const text = readFileSync(this.configPath, "utf8");
      const stripped = stripBlock(text);
      if (stripped !== text) {
        this.#write(this.configPath, stripped.trimEnd() ? `${stripped.trimEnd()}
` : "");
        this.#say(`removed the pairwire MCP server from ${this.configPath}`);
      }
    }
    if (existsSync(this.hooksPath)) {
      const file = JSON.parse(readFileSync(this.hooksPath, "utf8"));
      this.#write(this.hooksPath, JSON.stringify(withoutPairwire(file, this.runSh), null, 2) + "\n");
      this.#say(`removed pairwire hooks from ${this.hooksPath}`);
    }
    if (existsSync(this.skillPath) && readFileSync(this.skillPath, "utf8").includes(SKILL_MARK)) {
      rmSync(dirname(this.skillPath), { recursive: true, force: true });
      this.#say(`removed the pairwire skill`);
    }
    this.#say(`left ${this.#o.pairwireHome} in place; \`pairwire purge --all\` deletes it.`);
  }
};
function printConfig(harness, sourceRoot, out) {
  if (!HARNESSES.includes(harness) || harness === "other") {
    throw new InstallError(`Unknown harness "${harness}". Use one of: ${HARNESSES.filter((h) => h !== "other").join(", ")}.`);
  }
  const bundle = join(sourceRoot, "dist", "pairwire.mjs");
  const entry = harness === "codex" ? codexToml(bundle) : JSON.stringify({ mcpServers: { pairwire: { command: "node", args: [bundle, "mcp"], env: { PAIRWIRE_HARNESS: harness } } } }, null, 2);
  const skill = readFileSync(join(sourceRoot, "skills", "pairwire", "SKILL.md"), "utf8").replace(/^---\n[\s\S]*?\n---\n/, "").replace(/<!-- Generated from [^\n]*-->\n/, "").trim();
  out.write(
    [
      `# MCP server entry for ${harness} (adapt to where your harness keeps MCP servers):`,
      "",
      entry,
      "",
      "# Agent guide: add this to your harness's instructions (for example AGENTS.md):",
      "",
      skill,
      ""
    ].join("\n")
  );
}
export {
  InstallError,
  Installer,
  MARK_BEGIN,
  MARK_END,
  defaultInstallOptions,
  pathProblem,
  printConfig,
  runningPluginRoot,
  shellQuote,
  tomlPath
};
