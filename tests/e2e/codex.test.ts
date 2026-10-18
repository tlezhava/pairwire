// Codex wiring (04 §10): `pairwire install --codex` from the bundle, and a Claude Code ↔ Codex
// pairing in which the Codex side is launched exactly as the installed config.toml says,
// with Codex's cleared MCP environment and session ids only in tool-call _meta.
import { execFile, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";
import { onWindows, person, platformEnv, runShellCommand, SHARE, startRelay, tempDir, until } from "./harness.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const BUNDLE = join(ROOT, "plugins/claude-code/dist/pairwire.mjs");

function machine() {
  const home = tempDir();
  const env = { ...platformEnv(home), PATH: process.env.PATH ?? "", HOME: home, CODEX_HOME: join(home, ".codex"), PAIRWIRE_HOME: join(home, ".pairwire") };
  const install = (...args: string[]) => spawnSync(process.execPath, [BUNDLE, "install", ...args], { env, encoding: "utf8" });
  return { home, env, install, codex: (f: string) => join(home, ".codex", f) };
}

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
});

describe("pairwire install --codex", () => {
  it("installs the client, MCP server, hooks and skill, keeping what the user had", () => {
    const m = machine();
    mkdirSync(join(m.home, ".codex"));
    writeFileSync(m.codex("config.toml"), 'model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "other"\n');
    writeFileSync(m.codex("hooks.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "echo mine" }] }] } }));
    const r = m.install("--codex");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Run /hooks in Codex and trust the four pairwire hooks");

    const bin = join(m.home, ".pairwire", "bin");
    expect(r.stdout).toContain(`In hold mode, release held messages with: node ${JSON.stringify(join(bin, "dist", "pairwire.mjs"))} ctl accept [drop]`);
    expect(existsSync(join(bin, "dist", "pairwire.mjs"))).toBe(true);
    if (!onWindows) expect(statSync(join(bin, "hooks", "run.sh")).mode & 0o111).not.toBe(0); // no mode bits on Windows
    const toml = readFileSync(m.codex("config.toml"), "utf8");
    expect(toml).toContain('model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "other"\n');
    expect(toml).toContain(
      [
        "# >>> pairwire >>>",
        "[mcp_servers.pairwire]",
        'command = "node"',
        `args = ['${join(bin, "dist", "pairwire.mjs")}', "mcp"]`,
        'env = { PAIRWIRE_HARNESS = "codex" }',
        'env_vars = ["PAIRWIRE_HOME", "PAIRWIRE_RELAY", "PAIRWIRE_NAME", "PAIRWIRE_DELIVERY", "PAIRWIRE_LOG", "PAIRWIRE_HOLD"]',
        "startup_timeout_sec = 20",
        "# <<< pairwire <<<",
      ].join("\n"),
    );
    expect(toml).not.toMatch(/approval_mode/);
    const hooks = JSON.parse(readFileSync(m.codex("hooks.json"), "utf8")) as { hooks: Record<string, { hooks: { command: string }[] }[]> };
    expect(Object.keys(hooks.hooks).sort()).toEqual(["PostToolUse", "SessionStart", "Stop", "UserPromptSubmit"]);
    expect(hooks.hooks.Stop!.map((g) => g.hooks[0]!.command)).toEqual(["echo mine", `sh '${join(bin, "hooks", "run.sh")}' stop`]);
    expect(readFileSync(join(m.home, ".agents/skills/pairwire/SKILL.md"), "utf8")).toContain("name: pairwire");
    expect(readdirSync(join(m.home, ".codex")).filter((f) => f.includes(".pairwire-backup-")).sort()).toHaveLength(2);
  });

  it("is idempotent, refuses a hand-written [mcp_servers.pairwire], and uninstalls cleanly", () => {
    const m = machine();
    expect(m.install("--codex").status).toBe(0);
    const once = [readFileSync(m.codex("config.toml"), "utf8"), readFileSync(m.codex("hooks.json"), "utf8")];
    expect(m.install("--codex").status).toBe(0);
    expect([readFileSync(m.codex("config.toml"), "utf8"), readFileSync(m.codex("hooks.json"), "utf8")]).toEqual(once);

    expect(m.install("--codex", "--uninstall").status).toBe(0);
    expect(readFileSync(m.codex("config.toml"), "utf8")).not.toContain("pairwire");
    expect(readFileSync(m.codex("hooks.json"), "utf8")).not.toContain("run.sh");
    expect(existsSync(join(m.home, ".agents/skills/pairwire"))).toBe(false);

    writeFileSync(m.codex("config.toml"), '[mcp_servers.pairwire]\ncommand = "mine"\n');
    const r = m.install("--codex");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("already defines [mcp_servers.pairwire] outside pairwire's markers");
    expect(readFileSync(m.codex("config.toml"), "utf8")).toBe('[mcp_servers.pairwire]\ncommand = "mine"\n');
  });

  it("--print-config prints the MCP entry and the agent guide for a harness", () => {
    const m = machine();
    const codex = m.install("--print-config", "codex");
    expect(codex.stdout).toContain("[mcp_servers.pairwire]");
    expect(codex.stdout).toContain("# pairwire: working with a paired collaborator's agent");
    const cursor = m.install("--print-config", "cursor");
    expect(cursor.stdout).toContain('"PAIRWIRE_HARNESS": "cursor"');
    expect(cursor.stdout).not.toMatch(/^name: pairwire$/m);
    expect(m.install("--print-config", "notepad").status).toBe(1);
  });
});

describe("Claude Code ↔ Codex", () => {
  it("REQ-X-1 REQ-X-2 a Codex user installs with one command and pairs with a Claude Code user", async () => {
    const relay = await startRelay();
    const a = person("Tazo", relay.host, "claude-code", BUNDLE);
    await a.open("claude-session");
    const share = (await a.call("start")).match(SHARE)![0];

    // The Codex user: one install command, then Codex launches the server from config.toml.
    const m = machine();
    expect(m.install("--codex").status).toBe(0);
    const toml = readFileSync(m.codex("config.toml"), "utf8");
    // A TOML literal string (ADR-031); the temp path holds no `'`.
    const args = [toml.match(/^args = \['([^']*)', "mcp"\]$/m)![1]!, "mcp"];
    const project = join(m.home, "project");
    mkdirSync(join(project, ".git"), { recursive: true });
    // Codex clears the environment: a fixed list, plus `env`, plus the names in `env_vars`.
    const userEnv = { ...m.env, PAIRWIRE_RELAY: relay.host, PAIRWIRE_NAME: "Nika", SECRET_TOKEN: "not-passed" };
    const passed = ["HOME", "PATH", "USER", "PAIRWIRE_HOME", "PAIRWIRE_RELAY", "PAIRWIRE_NAME"];
    const codexEnv = Object.fromEntries(passed.flatMap((k) => (userEnv[k as keyof typeof userEnv] ? [[k, String(userEnv[k as keyof typeof userEnv])]] : [])));
    const transport = new StdioClientTransport({ command: "node", args, env: { ...codexEnv, PAIRWIRE_HARNESS: "codex" }, cwd: project, stderr: "pipe" });
    const codex = new Client({ name: "codex", version: "0" });
    await codex.connect(transport);
    closers.push(() => codex.close());
    const call = async (name: string, a: Record<string, unknown> = {}) =>
      ((await codex.callTool({ name, arguments: a, _meta: { sessionId: "codex-thread-1", threadId: "codex-thread-1" } })).content as { text: string }[])[0]!.text;

    expect(await call("join", { share })).toContain("Paired with Tazo (claude-code)");
    await until(async () => (await a.call("status")).includes("Peer: Nika (codex), online"), 10_000, "A sees a Codex peer");

    // A message from Claude Code reaches Codex through the installed PostToolUse hook (D2).
    await a.call("send", { kind: "question", body: "hello Codex, which port does the API use?" });
    const hookInput = JSON.stringify({ session_id: "codex-thread-1", cwd: project, hook_event_name: "PostToolUse", model: "gpt-5", turn_id: "t1", permission_mode: "default", tool_name: "mcp__pairwire__status" });
    const installed = JSON.parse(readFileSync(m.codex("hooks.json"), "utf8")) as { hooks: Record<string, { hooks: { command: string }[] }[]> };
    const postToolUse = installed.hooks.PostToolUse!.at(-1)!.hooks[0]!.command;
    let out = "";
    await until(() => {
      // The installed command line, run through a shell as Codex runs it.
      out = runShellCommand(postToolUse, { env: userEnv, input: hookInput });
      return out.includes("which port");
    }, 10_000, "Codex hook delivery");
    expect(JSON.parse(out).hookSpecificOutput.additionalContext).toContain('<pairwire_message from="Tazo" harness="claude-code"');

    // And back.
    await call("send", { kind: "chat", body: "8080, from Codex" });
    await until(async () => (await a.call("inbox")).includes("8080, from Codex"), 10_000, "A gets Codex's reply");

    // The human-only path is a terminal command for Codex users (04 §10).
    const log = await promisify(execFile)("node", [args[0]!, "ctl", "log", "5"], { env: userEnv, cwd: project, encoding: "utf8" });
    expect(log.stdout).toContain("<pairwire_transcript>");
  }, 60_000);
});
