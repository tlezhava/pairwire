import { createRequire as __pwCreateRequire } from "node:module";
const require = __pwCreateRequire(import.meta.url);
import {
  InstallError,
  cursorServer,
  pathProblem,
  runningPluginRoot,
  shellQuote
} from "./chunk-YU46EIYE.mjs";
import "./chunk-H5DVJTAM.mjs";
import "./chunk-HDMYU3UC.mjs";
import {
  external_exports
} from "./chunk-O5I4E6QX.mjs";
import "./chunk-KARZWXGF.mjs";

// packages/client/src/install-cursor.ts
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
var SKILL_MARK = "Generated from specs/06-agent-guide.md";
var CURSOR_HOOK_EVENTS = {
  sessionStart: "session-start",
  beforeSubmitPrompt: "user-prompt-submit",
  postToolUse: "post-tool-use",
  stop: "stop"
};
function defaultCursorOptions(env, out, pairwireHome) {
  const sourceRoot = runningPluginRoot();
  if (!sourceRoot) return null;
  const userHome = env.HOME || homedir();
  const pinHome = !!env.PAIRWIRE_HOME && resolve(env.PAIRWIRE_HOME) !== join(homedir(), ".pairwire");
  return { sourceRoot, pairwireHome, userHome, pinHome, out };
}
var mcpFileSchema = external_exports.looseObject({ mcpServers: external_exports.record(external_exports.string(), external_exports.unknown()).optional() });
var hookEntrySchema = external_exports.looseObject({ command: external_exports.unknown().optional() });
var hooksFileSchema = external_exports.looseObject({ hooks: external_exports.record(external_exports.string(), external_exports.array(hookEntrySchema)).optional() });
function parseCursorFile(path, text, schema, shape) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new InstallError(
      `${path} is not valid JSON (comments and trailing commas count), so pairwire won't edit it. Fix it, then run this again. Nothing was changed.`
    );
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success || typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new InstallError(`${path} doesn't have the shape Cursor documents (${shape}), so pairwire won't edit it. Fix it, then run this again. Nothing was changed.`);
  }
  return parsed.data;
}
function isOurServer(entry, bundle) {
  if (typeof entry !== "object" || entry === null) return false;
  const args = entry.args;
  return Array.isArray(args) && args.some((a) => typeof a === "string" && a.includes(bundle));
}
function isOurHook(entry, runSh) {
  const c = entry.command;
  return typeof c === "string" && (c.includes(shellQuote(runSh)) || c.includes(runSh));
}
function withOurServer(file, server, bundle, path) {
  const servers = { ...file.mcpServers ?? {} };
  if ("pairwire" in servers && !isOurServer(servers.pairwire, bundle)) {
    throw new InstallError(`${path} already has an mcpServers.pairwire entry that pairwire didn't install (it doesn't run ${bundle}). Remove it, then run this again.`);
  }
  servers.pairwire = server;
  return { ...file, mcpServers: servers };
}
function withoutOurServer(file, bundle) {
  if (!file.mcpServers || !isOurServer(file.mcpServers.pairwire, bundle)) return file;
  const { pairwire: _ours, ...rest } = file.mcpServers;
  return { ...file, mcpServers: rest };
}
function withoutOurHooks(file, runSh) {
  if (!file.hooks) return file;
  const hooks = {};
  for (const [event, entries] of Object.entries(file.hooks)) {
    const kept = entries.filter((e) => !isOurHook(e, runSh));
    if (kept.length > 0) hooks[event] = kept;
  }
  return { ...file, hooks };
}
function withOurHooks(file, commands, runSh) {
  const next = withoutOurHooks(file, runSh);
  const hooks = { ...next.hooks ?? {} };
  for (const [event, command] of Object.entries(commands)) hooks[event] = [...hooks[event] ?? [], { command, timeout: 10 }];
  return { version: 1, ...next, hooks };
}
var CursorInstaller = class {
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
  get cursorDir() {
    return join(this.#o.userHome, ".cursor");
  }
  get mcpPath() {
    return join(this.cursorDir, "mcp.json");
  }
  get hooksPath() {
    return join(this.cursorDir, "hooks.json");
  }
  get skillPath() {
    return join(this.cursorDir, "skills", "pairwire", "SKILL.md");
  }
  /** The `mcpServers.pairwire` entry (04 §10). */
  server() {
    return cursorServer(this.bundle, this.#o.pinHome ? this.#o.pairwireHome : void 0);
  }
  /** Cursor event → the shell command for it. The dialect is run.sh's second argument, which
   * works in any shell Cursor uses (04 §10); only a non-default state directory needs a prefix. */
  hookCommands() {
    const home = this.#o.pinHome ? `PAIRWIRE_HOME=${shellQuote(this.#o.pairwireHome)} ` : "";
    return Object.fromEntries(
      Object.entries(CURSOR_HOOK_EVENTS).map(([event, arg]) => [event, `${home}sh ${shellQuote(this.runSh)} ${arg} cursor`])
    );
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
  #read(path, schema, shape) {
    return existsSync(path) ? parseCursorFile(path, readFileSync(path, "utf8"), schema, shape) : null;
  }
  #readMcp() {
    return this.#read(this.mcpPath, mcpFileSchema, '{"mcpServers": {...}}');
  }
  #readHooks() {
    return this.#read(this.hooksPath, hooksFileSchema, '{"version": 1, "hooks": {"<event>": [{"command": ...}]}}');
  }
  install() {
    const src = this.#o.sourceRoot;
    for (const p of ["dist/pairwire.mjs", "hooks/run.sh", "skills/pairwire/SKILL.md"]) {
      if (!existsSync(join(src, p))) throw new InstallError(`The pairwire bundle at ${src} is incomplete (missing ${p}).`);
    }
    for (const [p, what] of [
      [this.#o.pairwireHome, "pairwire state directory"],
      [this.bundle, "pairwire bundle"],
      [this.runSh, "hook script"]
    ]) {
      const problem = pathProblem(p);
      if (problem) throw new InstallError(`The ${what} path ${JSON.stringify(p)} contains ${problem}, which can't go into Cursor's hook commands. Set PAIRWIRE_HOME to a path without it.`);
    }
    const mcp = withOurServer(this.#readMcp() ?? {}, this.server(), this.bundle, this.mcpPath);
    const hooks = withOurHooks(this.#readHooks() ?? {}, this.hookCommands(), this.runSh);
    if (src !== this.binDir) {
      rmSync(join(this.binDir, "dist"), { recursive: true, force: true });
      mkdirSync(join(this.binDir, "hooks"), { recursive: true, mode: 448 });
      cpSync(join(src, "dist"), join(this.binDir, "dist"), { recursive: true });
      copyFileSync(join(src, "hooks", "run.sh"), this.runSh);
    }
    chmodSync(this.runSh, 493);
    this.#say(`installed the client in ${this.binDir}`);
    this.#write(this.mcpPath, JSON.stringify(mcp, null, 2) + "\n");
    this.#say(`registered the pairwire MCP server in ${this.mcpPath}`);
    this.#write(this.hooksPath, JSON.stringify(hooks, null, 2) + "\n");
    this.#say(`added pairwire hooks to ${this.hooksPath}`);
    this.#write(this.skillPath, readFileSync(join(src, "skills", "pairwire", "SKILL.md"), "utf8"));
    this.#say(`installed the pairwire skill in ${dirname(this.skillPath)}`);
    const ctl = `node ${JSON.stringify(this.bundle)} ctl`;
    this.#say(
      [
        "",
        "Next:",
        '  1. Restart Cursor (or run "Developer: Reload Window").',
        "  2. In Cursor Settings > MCP, enable the pairwire server if Cursor lists it as disabled.",
        "  3. Ask the agent to start or join a pairwire room. To send your own words or let the agent continue",
        `     after the hop budget, run in a terminal: ${ctl} say|continue|log`,
        `     In hold mode, release held messages with: ${ctl} accept [drop]`,
        "Keep Cursor's approval prompt for the pairwire send tool: don't add it to an auto-run allowlist.",
        "Messages reach the agent through Cursor's hooks, which have been unreliable in some Cursor releases;",
        "if they don't show up on their own, ask the agent to check its pairwire inbox."
      ].join("\n")
    );
  }
  uninstall() {
    const mcp = this.#readMcp();
    const hooks = this.#readHooks();
    if (mcp) {
      const next = withoutOurServer(mcp, this.bundle);
      if (next !== mcp) {
        this.#write(this.mcpPath, JSON.stringify(next, null, 2) + "\n");
        this.#say(`removed the pairwire MCP server from ${this.mcpPath}`);
      }
    }
    if (hooks) {
      const next = withoutOurHooks(hooks, this.runSh);
      const text = JSON.stringify(next, null, 2) + "\n";
      if (text !== JSON.stringify(hooks, null, 2) + "\n") {
        this.#write(this.hooksPath, text);
        this.#say(`removed pairwire hooks from ${this.hooksPath}`);
      }
    }
    if (existsSync(this.skillPath) && readFileSync(this.skillPath, "utf8").includes(SKILL_MARK)) {
      rmSync(dirname(this.skillPath), { recursive: true, force: true });
      this.#say("removed the pairwire skill");
    }
    this.#say(`left ${this.#o.pairwireHome} in place; \`pairwire purge --all\` deletes it.`);
  }
};
export {
  CURSOR_HOOK_EVENTS,
  CursorInstaller,
  defaultCursorOptions,
  isOurHook,
  isOurServer,
  parseCursorFile,
  withOurHooks,
  withOurServer,
  withoutOurHooks,
  withoutOurServer
};
