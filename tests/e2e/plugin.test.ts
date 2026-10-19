// The Claude Code plugin as shipped (04 §6, §8, §9): files, hooks/run.sh and the bundle.
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { extractSkill } from "../../scripts/build-plugin.js";
import { onWindows, person, runExecHook, SHARE, startRelay, tempDir, until, type Person } from "./harness.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const PLUGIN = join(ROOT, "plugins/claude-code");
const BUNDLE = join(PLUGIN, "dist/pairwire.mjs");
const RUN_SH = join(PLUGIN, "hooks/run.sh");
const read = (p: string) => readFileSync(join(PLUGIN, p), "utf8");

type HookEntry = Record<string, unknown> & { event: string; command: string; args: string[] };
function hookEntries(): HookEntry[] {
  const hooks = JSON.parse(read("hooks/hooks.json")) as { hooks: Record<string, { hooks: Record<string, unknown>[] }[]> };
  return Object.entries(hooks.hooks).flatMap(([event, groups]) => groups.flatMap((g) => g.hooks.map((h) => ({ event, ...h }) as HookEntry)));
}
const hookEntry = (event: string) => hookEntries().find((e) => e.args[1] === event)!;

function frontmatter(md: string): Record<string, string> {
  const m = md.match(/^---\n([\s\S]*?)\n---\n/);
  return Object.fromEntries((m?.[1] ?? "").split("\n").map((l) => [l.slice(0, l.indexOf(":")), l.slice(l.indexOf(":") + 1).trim()]));
}

describe("plugin files", () => {
  it("REQ-SAFE-2 INV-4 ship no permission rule that pre-approves send", () => {
    const all = readdirSync(PLUGIN, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile() && !/[\\/]dist([\\/]|$)/.test(e.parentPath))
      .map((e) => readFileSync(join(e.parentPath, e.name), "utf8"))
      .join("\n");
    expect(all).not.toMatch(/mcp__plugin_pairwire_pairwire__send|"permissions"|"allow"\s*:/);
    for (const f of readdirSync(join(PLUGIN, "commands"))) {
      const tools = frontmatter(read(`commands/${f}`))["allowed-tools"];
      if (tools) expect(tools).toMatch(/^Bash\(node "\$\{CLAUDE_PLUGIN_ROOT\}\/dist\/pairwire\.mjs" ctl (say|continue|log|accept):\*\)$/);
      if (tools) expect(tools).toContain(`ctl ${f.replace(/\.md$/, "")}:*`); // each command allows only its own subcommand
    }
  });

  it("REQ-SAFE-6 has the eight commands; human-only ones hide from the model and pass text through a heredoc (S8)", () => {
    expect(readdirSync(join(PLUGIN, "commands")).sort()).toEqual(["accept.md", "continue.md", "join.md", "leave.md", "log.md", "say.md", "start.md", "status.md"]);
    for (const f of ["say.md", "continue.md", "accept.md"]) expect(frontmatter(read(`commands/${f}`))["disable-model-invocation"]).toBe("true");
    for (const f of ["say.md", "log.md", "accept.md"]) {
      const md = read(`commands/${f}`);
      expect(md).toContain("<<'PAIRWIRE_SAY_END_b7e1c94d'\n$ARGUMENTS\nPAIRWIRE_SAY_END_b7e1c94d\n");
      expect(md).not.toMatch(/"\$ARGUMENTS"/);
    }
  });

  it("wires every hook through run.sh in exec form, with the D3 waiter async", () => {
    // Exec form is what S1 and S3 verified on macOS; Windows wiring is unverified (ADR-024).
    const entries = hookEntries();
    expect(entries.map((e) => e.args[1])).toEqual(["session-start", "user-prompt-submit", "post-tool-use", "stop", "stop-wait"]);
    for (const e of entries) expect(e).toMatchObject({ type: "command", command: "sh", args: ["${CLAUDE_PLUGIN_ROOT}/hooks/run.sh", expect.any(String)] });
    expect(entries.at(-1)).toMatchObject({ async: true, asyncRewake: true, timeout: 86400 });
    expect(JSON.parse(read(".mcp.json")).mcpServers.pairwire.env).toEqual({ PAIRWIRE_HARNESS: "claude-code", PAIRWIRE_PROJECT_DIR: "${CLAUDE_PROJECT_DIR}" });
  });

  it("the repo root is a marketplace whose one plugin is plugins/claude-code", () => {
    const market = JSON.parse(readFileSync(join(ROOT, ".claude-plugin/marketplace.json"), "utf8")) as { name: string; plugins: { name: string; source: string }[] };
    const manifest = JSON.parse(read(".claude-plugin/plugin.json")) as { name: string; version: string };
    expect(market.plugins).toEqual([expect.objectContaining({ name: manifest.name, source: "./plugins/claude-code" })]);
    expect(market.name).toBe("pairwire"); // install: /plugin install pairwire@pairwire (REQ-INST-1)
  });

  it("SKILL.md is section 2 of the agent guide", () => {
    const skill = extractSkill(readFileSync(join(ROOT, "specs/06-agent-guide.md"), "utf8"));
    expect(read("skills/pairwire/SKILL.md").replace(/\n<!-- Generated from [^\n]*-->\n/, "")).toBe(skill);
  });
});

// These run run.sh against a fake `node` shell script on a ':'-separated PATH, which Windows
// cannot execute; "the bundle" below runs the real wrapper through Git's sh there.
describe.skipIf(onWindows)("hooks/run.sh", () => {
  /** A PATH whose `node` prints `version` and records its arguments. */
  function fakeNode(version: string | null) {
    const bin = tempDir();
    const log = join(bin, "calls");
    if (version !== null) {
      writeFileSync(join(bin, "node"), `#!/bin/sh\nif [ "$1" = "--version" ]; then echo --version >> "${log}.version"; echo ${version}; exit 0; fi\necho "$@" >> "${log}"\n`);
      chmodSync(join(bin, "node"), 0o755);
    }
    const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: tempDir() };
    const count = (p: string) => (existsSync(p) ? readFileSync(p, "utf8").split("\n").filter(Boolean).length : 0);
    return { env, bin, calls: () => (existsSync(log) ? readFileSync(log, "utf8") : ""), versionChecks: () => count(`${log}.version`) };
  }
  const run = (event: string, env: Record<string, string>) => spawnSync("sh", [RUN_SH, event], { env, input: "{}", encoding: "utf8" });

  it("exits 0 at once without starting Node when there is no room", () => {
    const n = fakeNode("v22.0.0");
    const home = join(tempDir(), "pw");
    const r = run("post-tool-use", { ...n.env, PAIRWIRE_HOME: home });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    expect(n.calls()).toBe("");
  });

  it("REQ-INST-4 tells the human once when Node is missing or too old, and never fails", () => {
    for (const version of [null, "v18.19.0"]) {
      const n = fakeNode(version);
      const home = tempDir();
      writeFileSync(join(home, "active"), "");
      expect(run("session-start", { ...n.env, PAIRWIRE_HOME: home }).stdout).toBe("");
      const first = run("post-tool-use", { ...n.env, PAIRWIRE_HOME: home });
      expect(first.status).toBe(0);
      const msg = JSON.parse(first.stdout) as { systemMessage: string };
      expect(msg.systemMessage).toContain(version ? `Node ${version} is installed` : "Node.js was not found");
      expect(msg.systemMessage).toContain("needs Node 20 or newer");
      expect(run("stop", { ...n.env, PAIRWIRE_HOME: home }).stdout).toBe("");
    }
  });

  it("prints no Node notice in the cursor dialect, which has no systemMessage (04 §10)", () => {
    const n = fakeNode(null);
    const home = tempDir();
    writeFileSync(join(home, "active"), "");
    const r = run("user-prompt-submit", { ...n.env, PAIRWIRE_HOME: home, PAIRWIRE_HOOK_DIALECT: "cursor" });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    expect(existsSync(join(home, "hook-node-warned"))).toBe(false);
  });

  it("execs the bundled client with the event when Node is recent", () => {
    const n = fakeNode("v20.11.1");
    const home = tempDir();
    writeFileSync(join(home, "active"), "");
    expect(run("stop", { ...n.env, PAIRWIRE_HOME: home }).status).toBe(0);
    expect(n.calls()).toBe(`${BUNDLE} hook stop\n`);
  });

  it("passes its parent, the harness, to the client as PAIRWIRE_HOOK_PPID (ADR-033)", () => {
    const n = fakeNode("v20.11.1");
    writeFileSync(join(n.bin, "node"), `#!/bin/sh\nif [ "$1" = "--version" ]; then echo v20.11.1; exit 0; fi\necho "ppid=$PAIRWIRE_HOOK_PPID" >> "${join(n.bin, "calls")}"\n`);
    const home = tempDir();
    writeFileSync(join(home, "active"), "");
    expect(run("post-tool-use", { ...n.env, PAIRWIRE_HOME: home, PAIRWIRE_HOOK_PPID: "1" }).status).toBe(0);
    expect(n.calls()).toBe(`ppid=${process.pid}\n`);
  });

  it("remembers a Node that passed the version check, and checks again when that binary changes", () => {
    const n = fakeNode("v22.1.0");
    const home = tempDir();
    writeFileSync(join(home, "active"), "");
    for (let i = 0; i < 3; i++) expect(run("post-tool-use", { ...n.env, PAIRWIRE_HOME: home }).status).toBe(0);
    expect(n.versionChecks()).toBe(1);
    expect(readFileSync(join(home, "node-ok"), "utf8")).toBe(`${join(n.bin, "node")}\n`);
    // An upgraded or replaced node binary is newer than the cache: check it again.
    const later = new Date(Date.now() + 5000);
    utimesSync(join(n.bin, "node"), later, later);
    expect(run("post-tool-use", { ...n.env, PAIRWIRE_HOME: home }).status).toBe(0);
    expect(n.versionChecks()).toBe(2);
    expect(n.calls().split("\n").filter(Boolean)).toHaveLength(4);
  });

  it("does not remember a Node that is too old", () => {
    const n = fakeNode("v18.20.0");
    const home = tempDir();
    writeFileSync(join(home, "active"), "");
    run("post-tool-use", { ...n.env, PAIRWIRE_HOME: home });
    expect(existsSync(join(home, "node-ok"))).toBe(false);
  });

  it("with OS=Windows_NT (Git Bash) looks for the state directory under USERPROFILE, as Node does there", () => {
    const n = fakeNode("v22.0.0"); // its HOME has no .pairwire
    const profile = tempDir();
    mkdirSync(join(profile, ".pairwire"));
    writeFileSync(join(profile, ".pairwire", "active"), "");
    expect(run("stop", { ...n.env, USERPROFILE: profile }).status).toBe(0);
    expect(n.calls()).toBe(""); // not Windows: HOME decides
    expect(run("stop", { ...n.env, OS: "Windows_NT", USERPROFILE: profile }).status).toBe(0);
    expect(n.calls()).toBe(`${BUNDLE} hook stop\n`);
  });
});

describe("the bundle", () => {
  /** A Claude Code user (A) paired with a Codex user (B), both running the bundle; B has sent A a chat. */
  async function pairedThroughBundle(home?: string) {
    const relay = await startRelay();
    const a = person("Tazo", relay.host, "claude-code", BUNDLE, home);
    const b = person("Nika", relay.host, "codex", BUNDLE);
    await a.open("sess-a");
    const share = (await a.call("start")).match(SHARE)![0];
    await b.open("sess-b");
    expect(await b.call("join", { share })).toContain("Paired with Tazo (claude-code)");
    await b.call("send", { kind: "chat", body: "hello through the bundle" });
    return { relay, a, b };
  }

  /** Runs A's PostToolUse hook from hooks.json, as Claude Code does, until it delivers B's chat. */
  async function postToolUseDelivers(a: Person, env: Record<string, string>): Promise<string> {
    const input = JSON.stringify({ session_id: "sess-a", cwd: a.project, permission_mode: "default", hook_event_name: "PostToolUse" });
    let out = "";
    await until(() => {
      out = runExecHook(hookEntry("post-tool-use"), { env: { ...env, CLAUDE_PROJECT_DIR: a.project, CLAUDE_PLUGIN_ROOT: PLUGIN }, input, pluginRoot: PLUGIN });
      return out.includes("hello through the bundle");
    }, 10_000, "hook delivery");
    return out;
  }

  it("pairs, injects through run.sh, and reports doctor ok, all from plugins/claude-code/dist", async () => {
    const { relay, a } = await pairedThroughBundle();
    const out = await postToolUseDelivers(a, a.env);
    expect(JSON.parse(out).hookSpecificOutput.hookEventName).toBe("PostToolUse");
    // Async: the relay runs in this process and must keep answering while doctor checks it.
    const doctor = { stdout: (await promisify(execFile)(process.execPath, [BUNDLE, "doctor"], { env: a.env, encoding: "utf8" })).stdout };
    expect(doctor.stdout).toContain(`ok    relay ${relay.host} answers /health`);
    expect(doctor.stdout).toContain("ok    plugin hooks wired at");
  });

  // run.sh's Windows branch (04 §6): with no PAIRWIRE_HOME the wrapper and Node must agree that
  // the state directory is under USERPROFILE, whatever HOME says.
  it.runIf(onWindows)("on Windows the hook finds the state directory under USERPROFILE when PAIRWIRE_HOME is unset", async () => {
    const profile = tempDir();
    const { a } = await pairedThroughBundle(join(profile, ".pairwire"));
    const env: Record<string, string> = { ...a.env, USERPROFILE: profile, HOME: tempDir() };
    delete env.PAIRWIRE_HOME;
    const out = await postToolUseDelivers(a, env);
    expect(JSON.parse(out).hookSpecificOutput.hookEventName).toBe("PostToolUse");
  });
});
