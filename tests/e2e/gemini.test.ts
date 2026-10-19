// Gemini CLI wiring (04 §10, ADR-033): `pairwire install --gemini` from the bundle, and a
// Claude Code ↔ Gemini CLI pairing in which the Gemini side's MCP server is launched exactly as
// the extension's manifest says (cleared environment plus `env`, ${workspacePath} substituted),
// its hooks run as the installed hooks.json commands with Gemini-shaped input, and the human's
// commands run as the installed TOML `!{…}` lines.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";
import { shellQuote } from "../../packages/client/src/install.js";
import { WAKE_PROMPT } from "../../packages/client/src/wake.js";
import { onWindows, person, platformEnv, runShellCommand, SHARE, startRelay, tempDir, until } from "./harness.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const BUNDLE = join(ROOT, "plugins/claude-code/dist/pairwire.mjs");

type Manifest = { name: string; version: string; mcpServers: { pairwire: { command: string; args: string[]; env: Record<string, string> } } };
type GeminiHooks = { hooks: Record<string, { matcher?: string; hooks: { command: string; timeout: number }[] }[]> };

function machine() {
  const home = tempDir();
  const env = { ...platformEnv(home), PATH: process.env.PATH ?? "", HOME: home, PAIRWIRE_HOME: join(home, ".pairwire") };
  const install = (...args: string[]) => spawnSync(process.execPath, [BUNDLE, "install", ...args], { env, encoding: "utf8" });
  const ext = join(home, ".pairwire", "bin", "gemini");
  return { home, env, install, ext, read: (rel: string) => readFileSync(join(ext, rel), "utf8") };
}

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
});

describe("pairwire install --gemini", () => {
  it("writes the extension and prints the link command; --uninstall removes it", () => {
    const m = machine();
    const r = m.install("--gemini");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`Run: gemini extensions link ${m.ext}\n`);
    for (const f of ["gemini-extension.json", "hooks/hooks.json", "skills/pairwire/SKILL.md", "GEMINI.md", "commands/pairwire/say.toml", "commands/pairwire/continue.toml", "commands/pairwire/accept.toml", "commands/pairwire/log.toml"]) {
      expect(existsSync(join(m.ext, f)), f).toBe(true);
    }
    expect(m.read("skills/pairwire/SKILL.md")).toBe(readFileSync(join(ROOT, "plugins/claude-code/skills/pairwire/SKILL.md"), "utf8"));
    const once = m.read("gemini-extension.json") + m.read("hooks/hooks.json");
    expect(m.install("--gemini").status).toBe(0);
    expect(m.read("gemini-extension.json") + m.read("hooks/hooks.json")).toBe(once);

    const u = m.install("--gemini", "--uninstall");
    expect(u.status).toBe(0);
    expect(u.stdout).toContain("gemini extensions uninstall pairwire");
    expect(existsSync(m.ext)).toBe(false);
    expect(existsSync(join(m.home, ".pairwire", "bin", "dist", "pairwire.mjs"))).toBe(true);
  });
});

describe("Claude Code ↔ Gemini CLI", () => {
  it("REQ-X-3 a Gemini CLI user installs the extension and pairs with a Claude Code user", async () => {
    const relay = await startRelay();
    const a = person("Tazo", relay.host, "claude-code", BUNDLE);
    await a.open("claude-session");
    const share = (await a.call("start")).match(SHARE)![0];

    // The Gemini user: one install command (the `gemini extensions link` it prints is Gemini's).
    const m = machine();
    expect(m.install("--gemini").status).toBe(0);
    // Extension servers get no user variables, so the name comes from config.json (04 §10).
    writeFileSync(join(m.home, ".pairwire", "config.json"), JSON.stringify({ name: "Nika" }), { mode: 0o600 });
    const project = join(m.home, "project");
    mkdirSync(join(project, ".git"), { recursive: true });

    // Gemini launches the server from the manifest: HOME, PATH and the like, plus `env`, with
    // ${workspacePath} substituted. Nothing else from the user's environment.
    const manifest = JSON.parse(m.read("gemini-extension.json")) as Manifest;
    const server = manifest.mcpServers.pairwire;
    const subst = (v: string) => v.replaceAll("${workspacePath}", project);
    const serverEnv = {
      ...platformEnv(m.home),
      HOME: m.home,
      PATH: process.env.PATH ?? "",
      ...Object.fromEntries(Object.entries(server.env).map(([k, v]) => [k, subst(v)])),
    };
    expect(serverEnv).not.toHaveProperty("PAIRWIRE_HOME"); // the default state directory: nothing pinned
    const transport = new StdioClientTransport({ command: server.command, args: server.args.map(subst), env: serverEnv, cwd: project, stderr: "pipe" });
    const gemini = new Client({ name: "gemini-cli-mcp-client", version: "0" });
    await gemini.connect(transport);
    closers.push(() => gemini.close());
    // Gemini gives the server no session id: no _meta, no environment variable.
    const call = async (name: string, args: Record<string, unknown> = {}) => ((await gemini.callTool({ name, arguments: args })).content as { text: string }[])[0]!.text;

    expect(await call("join", { share })).toContain("Paired with Tazo (claude-code)");
    await until(async () => (await a.call("status")).includes("Peer: Nika (gemini-cli), online"), 10_000, "A sees a Gemini peer");

    // Hooks: the installed command lines, run through a shell as Gemini runs them, with
    // Gemini's hook input and its project variables (04 §10).
    const hooks = JSON.parse(m.read("hooks/hooks.json")) as GeminiHooks;
    const hookEnv = { ...m.env, GEMINI_PROJECT_DIR: project, CLAUDE_PROJECT_DIR: project };
    const hook = (event: string, extra: Record<string, unknown> = {}) => {
      const input = { session_id: "gemini-session-1", transcript_path: join(m.home, ".gemini", "chat.json"), cwd: project, hook_event_name: event, timestamp: new Date().toISOString(), ...extra };
      const out = runShellCommand(hooks.hooks[event]![0]!.hooks[0]!.command, { env: hookEnv, input: JSON.stringify(input) }).trim();
      return out ? (JSON.parse(out) as { hookSpecificOutput?: { hookEventName: string; additionalContext: string }; decision?: string; reason?: string }) : null;
    };
    const unread = async () => /Inbox: [1-9]/.test(await call("status"));

    // On Windows the hook cannot find the server's harness by pid (no `ps`, and Git sh's pids
    // are not Windows pids) [S11], so D2 is off there and the room runs on D1.
    if (!onWindows) {
      const start = hook("SessionStart", { source: "startup" });
      expect(start?.hookSpecificOutput).toMatchObject({ hookEventName: "SessionStart" });
      expect(start?.hookSpecificOutput?.additionalContext).toContain("paired with Tazo (claude-code)");

      // D2 between steps: AfterTool context, in Claude Code's format with Gemini's event name.
      await a.call("send", { kind: "question", body: "hello Gemini, which port does the API use?" });
      let after: ReturnType<typeof hook> = null;
      await until(() => {
        after = hook("AfterTool", { tool_name: "run_shell_command", tool_input: { command: "ls" }, tool_response: { llmContent: "" } });
        return after !== null;
      }, 10_000, "AfterTool delivery");
      expect(after!.hookSpecificOutput).toMatchObject({ hookEventName: "AfterTool" });
      expect(after!.hookSpecificOutput!.additionalContext).toContain('<pairwire_message from="Tazo" harness="claude-code"');
      expect(after!.hookSpecificOutput!.additionalContext).toContain("which port");

      // The agent answers; its send uses one hop.
      await call("send", { kind: "chat", body: "8080, from Gemini" });
      await until(async () => (await a.call("inbox")).includes("8080, from Gemini"), 10_000, "A gets Gemini's reply");

      // At the turn's end AfterAgent wakes with the fixed text only, never the peer's words, and
      // only once for the same message.
      await a.call("send", { kind: "chat", body: "thanks; also check /health" });
      await until(unread, 10_000, "Gemini has the second message");
      const stop = hook("AfterAgent", { prompt: "which port?", prompt_response: "Asked.", stop_hook_active: false });
      expect(stop).toEqual({ decision: "block", reason: WAKE_PROMPT });
      expect(hook("AfterAgent", { prompt: "which port?", prompt_response: "Asked.", stop_hook_active: true })).toBeNull();

      // Gemini sends the reason as a new prompt: BeforeAgent shows the message, labeled, and
      // does not reset the hop budget for it.
      const woken = hook("BeforeAgent", { prompt: WAKE_PROMPT });
      expect(woken?.hookSpecificOutput).toMatchObject({ hookEventName: "BeforeAgent" });
      expect(woken?.hookSpecificOutput?.additionalContext).toContain("check /health");
      expect(woken?.hookSpecificOutput?.additionalContext).toContain('<pairwire_message from="Tazo"');
      expect(await call("status")).toContain("Hop budget: 7/8 left");
      // A prompt the human types does reset it.
      hook("BeforeAgent", { prompt: "ok, carry on" });
      expect(await call("status")).toContain("Hop budget: 8/8 left");
    } else {
      await a.call("send", { kind: "question", body: "hello Gemini, which port does the API use?" });
      await until(unread, 10_000, "Gemini has the message");
      expect(await call("inbox")).toContain("which port");
      await call("send", { kind: "chat", body: "8080, from Gemini" });
      await until(async () => (await a.call("inbox")).includes("8080, from Gemini"), 10_000, "A gets Gemini's reply");
    }

    // The human's commands: the installed `!{…}` line, {{args}} shell-escaped into one word as
    // Gemini does, run in the workspace.
    const bang = (name: string, args: string) => {
      const toml = m.read(`commands/pairwire/${name}.toml`);
      const line = /^!\{(.*)\}$/m.exec(toml)![1]!.replace(/\\(["\\])/g, "$1");
      return runShellCommand(line.replace("{{args}}", shellQuote(args)), { env: m.env, input: "", cwd: project });
    };
    expect(bang("say", "from the Gemini user, verbatim: $(not run)")).toMatch(/^pairwire: sent your message to Tazo as you/);
    await until(async () => (await a.call("inbox")).includes("from the Gemini user, verbatim: $(not run)"), 10_000, "A gets the human's words");
    expect(a.results.at(-1)!.text).toContain('author="human"');
    expect(bang("log", "")).toContain("<pairwire_transcript>");
    expect(bang("accept", "")).toContain("hold mode is off");
  }, 60_000);
});
