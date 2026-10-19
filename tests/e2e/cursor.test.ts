// Cursor wiring (04 §10 "Cursor"): `pairwire install --cursor` from the bundle, and a Claude Code ↔
// Cursor pairing in which the Cursor side's MCP server is launched exactly as the installed
// mcp.json says and its hooks run as the installed hooks.json says, with Cursor's hook input
// (conversation_id, workspace_roots, hook_event_name) and no session id for the server.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";
import { WAKE_PROMPT } from "../../packages/client/src/wake.js";
import { onWindows, person, platformEnv, runShellCommand, SHARE, startRelay, tempDir, until } from "./harness.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const BUNDLE = join(ROOT, "plugins/claude-code/dist/pairwire.mjs");

type McpFile = { mcpServers: Record<string, { type: string; command: string; args: string[]; env: Record<string, string> }> };
type HooksFile = { version: number; hooks: Record<string, { command: string; timeout?: number }[]> };

function machine() {
  const home = tempDir();
  const env = { ...platformEnv(home), PATH: process.env.PATH ?? "", HOME: home };
  const install = (...args: string[]) => spawnSync(process.execPath, [BUNDLE, "install", ...args], { env, encoding: "utf8" });
  const cursor = (f: string) => join(home, ".cursor", f);
  return { home, env, install, cursor, json: <T>(f: string) => JSON.parse(readFileSync(cursor(f), "utf8")) as T };
}

/** Cursor's config interpolation, for the one variable pairwire's entry uses. */
const expand = (value: string, workspace: string) => value.replaceAll("${workspaceFolder}", workspace);

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
});

describe("pairwire install --cursor", () => {
  it("installs the client, MCP server, hooks and skill, keeping what the user had", () => {
    const m = machine();
    mkdirSync(join(m.home, ".cursor"));
    writeFileSync(m.cursor("mcp.json"), JSON.stringify({ mcpServers: { github: { command: "gh-mcp" } } }));
    writeFileSync(m.cursor("hooks.json"), JSON.stringify({ version: 1, hooks: { stop: [{ command: "./audit.sh" }] } }));
    const r = m.install("--cursor");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Restart Cursor");

    const bin = join(m.home, ".pairwire", "bin");
    const bundle = join(bin, "dist", "pairwire.mjs");
    expect(existsSync(bundle)).toBe(true);
    const mcp = m.json<McpFile>("mcp.json");
    expect(Object.keys(mcp.mcpServers)).toEqual(["github", "pairwire"]);
    expect(mcp.mcpServers.pairwire).toEqual({
      type: "stdio",
      command: "node",
      args: [bundle, "mcp"],
      env: { PAIRWIRE_HARNESS: "cursor", PAIRWIRE_PROJECT_DIR: "${workspaceFolder}" },
    });
    const hooks = m.json<HooksFile>("hooks.json");
    expect(Object.keys(hooks.hooks).sort()).toEqual(["beforeSubmitPrompt", "postToolUse", "sessionStart", "stop"]);
    expect(hooks.hooks.stop).toEqual([{ command: "./audit.sh" }, { command: `PAIRWIRE_HOOK_DIALECT=cursor sh '${join(bin, "hooks", "run.sh")}' stop`, timeout: 10 }]);
    expect(readFileSync(join(m.home, ".cursor/skills/pairwire/SKILL.md"), "utf8")).toContain("name: pairwire");
    expect(readdirSync(join(m.home, ".cursor")).filter((f) => f.includes(".pairwire-backup-"))).toHaveLength(2);

    // Idempotent, and uninstall leaves only what the user had.
    const once = [readFileSync(m.cursor("mcp.json"), "utf8"), readFileSync(m.cursor("hooks.json"), "utf8")];
    expect(m.install("--cursor").status).toBe(0);
    expect([readFileSync(m.cursor("mcp.json"), "utf8"), readFileSync(m.cursor("hooks.json"), "utf8")]).toEqual(once);
    expect(m.install("--cursor", "--uninstall").status).toBe(0);
    expect(m.json("mcp.json")).toEqual({ mcpServers: { github: { command: "gh-mcp" } } });
    expect(m.json("hooks.json")).toEqual({ version: 1, hooks: { stop: [{ command: "./audit.sh" }] } });
    expect(existsSync(join(m.home, ".cursor/skills/pairwire"))).toBe(false);
  });

  it("refuses an mcp.json that isn't valid JSON and changes nothing", () => {
    const m = machine();
    mkdirSync(join(m.home, ".cursor"));
    const broken = '{ "mcpServers": {}, }';
    writeFileSync(m.cursor("mcp.json"), broken);
    const r = m.install("--cursor");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("is not valid JSON");
    expect(readFileSync(m.cursor("mcp.json"), "utf8")).toBe(broken);
    expect(readdirSync(join(m.home, ".cursor"))).toEqual(["mcp.json"]);
  });

  it("--print-config cursor prints the entry the install writes", () => {
    const out = machine().install("--print-config", "cursor").stdout;
    expect(out).toContain('"type": "stdio"');
    expect(out).toContain('"PAIRWIRE_PROJECT_DIR": "${workspaceFolder}"');
  });
});

describe("Claude Code ↔ Cursor", () => {
  it("REQ-X-4 a Cursor user installs with one command, pairs with a Claude Code user, and gets messages through Cursor's hooks", async () => {
    const relay = await startRelay();
    const a = person("Tazo", relay.host, "claude-code", BUNDLE);
    await a.open("claude-session");
    const share = (await a.call("start")).match(SHARE)![0];

    const m = machine();
    expect(m.install("--cursor").status).toBe(0);
    const workspace = join(m.home, "project");
    mkdirSync(join(workspace, ".git"), { recursive: true });
    // Cursor's environment: the user's, started from the desktop, so the relay and name come
    // from ~/.pairwire/config.json rather than the shell profile (04 §10).
    writeFileSync(join(m.home, ".pairwire", "config.json"), JSON.stringify({ relay: relay.host, name: "Nika" }));

    // The server, launched as mcp.json says, with ${workspaceFolder} expanded; Cursor gives it
    // no session id, so its hooks find it by the harness pid (04 §10).
    const entry = m.json<McpFile>("mcp.json").mcpServers.pairwire!;
    const serverEnv = { ...m.env, ...Object.fromEntries(Object.entries(entry.env).map(([k, v]) => [k, expand(v, workspace)])) };
    const transport = new StdioClientTransport({ command: entry.command, args: entry.args, env: serverEnv, cwd: join(m.home, ".cursor"), stderr: "pipe" });
    const cursor = new Client({ name: "cursor", version: "0" });
    await cursor.connect(transport);
    closers.push(() => cursor.close());
    const call = async (name: string, args: Record<string, unknown> = {}) => ((await cursor.callTool({ name, arguments: args })).content as { text: string }[])[0]!.text;

    expect(await call("join", { share })).toContain("Paired with Tazo (claude-code)");
    await until(async () => (await a.call("status")).includes("Peer: Nika (cursor), online"), 10_000, "A sees a Cursor peer");

    // The installed hook commands, run through a shell with Cursor's input and environment.
    const installed = m.json<HooksFile>("hooks.json").hooks;
    const hookEnv = { ...m.env, CURSOR_PROJECT_DIR: workspace, CLAUDE_PROJECT_DIR: workspace };
    const runHook = (event: string, extra: Record<string, unknown> = {}) =>
      runShellCommand(installed[event]!.at(-1)!.command, {
        env: hookEnv,
        input: JSON.stringify({
          conversation_id: "cursor-conv-1",
          generation_id: "gen-1",
          model: "auto",
          hook_event_name: event,
          cursor_version: "2.0.0",
          workspace_roots: [workspace],
          user_email: null,
          transcript_path: null,
          ...extra,
        }),
      });

    await a.call("send", { kind: "question", body: "hello Cursor, which port does the API use?" });
    await until(async () => (await call("status")).includes("1 unread"), 10_000, "the message reaches the Cursor side");

    if (onWindows) {
      // Through Git sh, run.sh's $PPID is not a Windows pid and Windows never runs ps, so the
      // harness-pid match can't be shown here [S11]; delivery falls back to D1.
      expect(await call("inbox")).toContain("which port");
    } else {
      // stop: a fixed-text wake, never the peer's text (04 §10).
      const stop = runHook("stop", { status: "completed", loop_count: 0 });
      expect(JSON.parse(stop)).toEqual({ followup_message: WAKE_PROMPT });
      expect(stop).not.toContain("which port");
      // The wake's own prompt keeps the hop budget; beforeSubmitPrompt always allows.
      expect(JSON.parse(runHook("beforeSubmitPrompt", { prompt: WAKE_PROMPT, attachments: [] }))).toEqual({ continue: true });
      // postToolUse: the message itself, labeled, as additional_context.
      const post = JSON.parse(runHook("postToolUse", { tool_name: "MCP:pairwire-status", tool_input: "{}", tool_output: "{}", duration: 5 })) as { additional_context: string };
      expect(post.additional_context).toContain('<pairwire_message from="Tazo" harness="claude-code"');
      expect(post.additional_context).toContain("which port");
      // Delivered now, so the next turn end doesn't wake again.
      expect(runHook("stop", { status: "completed", loop_count: 1 })).toBe("");
      // sessionStart re-orients the agent on the room.
      const start = JSON.parse(runHook("sessionStart", { session_id: "cursor-conv-1", is_background_agent: false, composer_mode: "agent" })) as { additional_context: string };
      expect(start.additional_context).toContain("Tazo (claude-code)");
    }

    // And back.
    await call("send", { kind: "chat", body: "8080, from Cursor" });
    await until(async () => (await a.call("inbox")).includes("8080, from Cursor"), 10_000, "A gets Cursor's reply");
  }, 60_000);
});
