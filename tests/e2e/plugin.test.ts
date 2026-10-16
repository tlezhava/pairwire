// The Claude Code plugin as shipped (04 §6, §8, §9): files, hooks/run.sh and the bundle.
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { extractSkill } from "../../scripts/build-plugin.js";
import { onWindows, person, runShellCommand, SHARE, startRelay, tempDir, until } from "./harness.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const PLUGIN = join(ROOT, "plugins/claude-code");
const BUNDLE = join(PLUGIN, "dist/pairwire.mjs");
const RUN_SH = join(PLUGIN, "hooks/run.sh");
const read = (p: string) => readFileSync(join(PLUGIN, p), "utf8");

type HookEntry = Record<string, unknown> & { event: string; command: string };
function hookEntries(): HookEntry[] {
  const hooks = JSON.parse(read("hooks/hooks.json")) as { hooks: Record<string, { hooks: Record<string, unknown>[] }[]> };
  return Object.entries(hooks.hooks).flatMap(([event, groups]) => groups.flatMap((g) => g.hooks.map((h) => ({ event, ...h }) as HookEntry)));
}
const hookCommand = (event: string) => hookEntries().find((e) => e.command.endsWith(` ${event}`))!.command;

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
      if (tools) expect(tools).toMatch(/^Bash\(node "\$\{CLAUDE_PLUGIN_ROOT\}\/dist\/pairwire\.mjs" ctl (say|continue|log):\*\)$/);
    }
  });

  it("has the seven commands; human-only ones hide from the model and pass text through a heredoc (S8)", () => {
    expect(readdirSync(join(PLUGIN, "commands")).sort()).toEqual(["continue.md", "join.md", "leave.md", "log.md", "say.md", "start.md", "status.md"]);
    for (const f of ["say.md", "continue.md"]) expect(frontmatter(read(`commands/${f}`))["disable-model-invocation"]).toBe("true");
    for (const f of ["say.md", "log.md"]) {
      const md = read(`commands/${f}`);
      expect(md).toContain("<<'PAIRWIRE_SAY_END_b7e1c94d'\n$ARGUMENTS\nPAIRWIRE_SAY_END_b7e1c94d\n");
      expect(md).not.toMatch(/"\$ARGUMENTS"/);
    }
  });

  it("wires every hook through run.sh in shell form, so Windows runs it with Git Bash, with the D3 waiter async", () => {
    const entries = hookEntries();
    const events = ["session-start", "user-prompt-submit", "post-tool-use", "stop", "stop-wait"];
    expect(entries.map((e) => e.command)).toEqual(events.map((ev) => `sh "\${CLAUDE_PLUGIN_ROOT}/hooks/run.sh" ${ev}`));
    for (const e of entries) {
      expect(e.type).toBe("command");
      // Exec form would look `sh` up on PATH, where Windows usually lacks it (ADR-021).
      expect(e).not.toHaveProperty("args");
      expect(e).not.toHaveProperty("shell");
    }
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
// cannot execute; "the bundle" below runs the real wrapper through Git Bash there.
describe.skipIf(onWindows)("hooks/run.sh", () => {
  /** A PATH whose `node` prints `version` and records its arguments. */
  function fakeNode(version: string | null) {
    const bin = tempDir();
    const log = join(bin, "calls");
    if (version !== null) {
      writeFileSync(join(bin, "node"), `#!/bin/sh\nif [ "$1" = "--version" ]; then echo ${version}; exit 0; fi\necho "$@" >> "${log}"\n`);
      chmodSync(join(bin, "node"), 0o755);
    }
    const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: tempDir() };
    return { env, calls: () => (existsSync(log) ? readFileSync(log, "utf8") : "") };
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

  it("execs the bundled client with the event when Node is recent", () => {
    const n = fakeNode("v20.11.1");
    const home = tempDir();
    writeFileSync(join(home, "active"), "");
    expect(run("stop", { ...n.env, PAIRWIRE_HOME: home }).status).toBe(0);
    expect(n.calls()).toBe(`${BUNDLE} hook stop\n`);
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
  it("pairs, injects through run.sh, and reports doctor ok, all from plugins/claude-code/dist", async () => {
    const relay = await startRelay();
    const a = person("Tazo", relay.host, "claude-code", BUNDLE);
    const b = person("Nika", relay.host, "codex", BUNDLE);
    await a.open("sess-a");
    const share = (await a.call("start")).match(SHARE)![0];
    await b.open("sess-b");
    expect(await b.call("join", { share })).toContain("Paired with Tazo (claude-code)");
    await b.call("send", { kind: "chat", body: "hello through the bundle" });
    const input = JSON.stringify({ session_id: "sess-a", cwd: a.project, permission_mode: "default", hook_event_name: "PostToolUse" });
    let out = "";
    await until(() => {
      // The command from hooks.json, run as Claude Code runs a shell-form hook.
      out = runShellCommand(hookCommand("post-tool-use"), { env: { ...a.env, CLAUDE_PROJECT_DIR: a.project, CLAUDE_PLUGIN_ROOT: PLUGIN }, input });
      return out.includes("hello through the bundle");
    }, 10_000, "hook delivery");
    expect(JSON.parse(out).hookSpecificOutput.hookEventName).toBe("PostToolUse");
    // Async: the relay runs in this process and must keep answering while doctor checks it.
    const doctor = { stdout: (await promisify(execFile)(process.execPath, [BUNDLE, "doctor"], { env: a.env, encoding: "utf8" })).stdout };
    expect(doctor.stdout).toContain(`ok    relay ${relay.host} answers /health`);
    expect(doctor.stdout).toContain("ok    plugin hooks wired at");
  });
});
