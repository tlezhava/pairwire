// End-to-end harness (07-testing.md, client integration): a real relay-node on a random port and
// `pairwire mcp` processes driven by MCP clients over stdio, each with its own PAIRWIRE_HOME.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach } from "vitest";
import { findGitBash } from "../../packages/client/src/platform.js";
import { ManualClock, type Clock } from "../../packages/relay-node/src/clock.js";
import { createLogger } from "../../packages/relay-node/src/log.js";
import { createRelayServer } from "../../packages/relay-node/src/server.js";

export const onWindows = process.platform === "win32";

/**
 * Variables a child process needs besides the ones a test sets. Empty off Windows, where tests
 * give children a minimal environment. On Windows: the MCP SDK's defaults (a process there also
 * needs SYSTEMROOT, TEMP and the like, or Node's networking and temp paths fail), `OS`, which
 * makes run.sh take its Windows branch (04 §6), and `USERPROFILE`, Node's home directory there,
 * set to `profile` when given (the test's stand-in for HOME).
 */
export function platformEnv(profile?: string): Record<string, string> {
  if (!onWindows) return {};
  return { ...getDefaultEnvironment(), OS: "Windows_NT", ...(profile ? { USERPROFILE: profile } : {}) };
}

/** `env` plus, on Windows, whatever of platformEnv() it lacks. */
const withPlatform = (env: Record<string, string>) => (onWindows ? { ...platformEnv(), ...env } : env);

/**
 * Runs a shell-form hook command string (Codex's, 04 §10) through a POSIX shell: `sh -c` on
 * macOS and Linux, Git Bash on Windows.
 */
export function runShellCommand(command: string, o: { env: Record<string, string>; input: string; cwd?: string }): string {
  const shell = onWindows ? findGitBash(process.env) : "sh";
  if (!shell) throw new Error("Git Bash not found; pairwire's hooks need it on Windows");
  return execFileSync(shell, ["-c", command], { env: withPlatform(o.env), input: o.input, encoding: "utf8", ...(o.cwd ? { cwd: o.cwd } : {}) });
}

/**
 * Runs an exec-form hook entry from hooks.json (04 §9) as Claude Code does: `${CLAUDE_PLUGIN_ROOT}`
 * substituted in `args`, and `command` run without a shell. On Windows `sh` is taken from the Git
 * install that findGitBash() finds; how Claude Code itself resolves it there is unverified (ADR-024).
 */
export function runExecHook(hook: { command: string; args: string[] }, o: { env: Record<string, string>; input: string; pluginRoot: string }): string {
  const args = hook.args.map((a) => a.replaceAll("${CLAUDE_PLUGIN_ROOT}", o.pluginRoot));
  let command = hook.command;
  if (onWindows && command === "sh") {
    const bash = findGitBash(process.env);
    if (!bash) throw new Error("Git Bash not found; pairwire's hooks need it on Windows");
    const sh = join(dirname(bash), "sh.exe");
    command = existsSync(sh) ? sh : bash;
  }
  return execFileSync(command, args, { env: withPlatform(o.env), input: o.input, encoding: "utf8" });
}

const MAIN = fileURLToPath(new URL("../../packages/client/src/main.ts", import.meta.url));
const TSX = import.meta.resolve("tsx");

const cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

export function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pw-e2e-")));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export async function startRelay(clock?: Clock) {
  const server = createRelayServer({ port: 0, host: "127.0.0.1", log: createLogger(() => {}), ...(clock ? { clock } : {}) });
  const { port } = await server.listen();
  cleanups.push(() => server.close());
  return { port, host: `127.0.0.1:${port}` };
}

export function manualClock(): ManualClock {
  return new ManualClock(Date.now());
}

export interface Person {
  name: string;
  home: string;
  project: string;
  env: Record<string, string>;
  /** Everything the MCP process wrote to stderr (its log). */
  logs: string[];
  /** Every tool result text this person's agent saw. */
  results: { tool: string; text: string }[];
  client: Client | null;
  pid: number | null;
  call(tool: string, args?: Record<string, unknown>): Promise<string>;
  /** Starts (or restarts) the MCP process: a new agent session in the same project. */
  open(sessionId?: string): Promise<void>;
  close(): Promise<void>;
}

/**
 * `bundle`: run the built plugin bundle instead of the TypeScript sources. `home`: the state
 * directory (PAIRWIRE_HOME), by default `home` under a fresh temporary directory.
 */
export function person(name: string, relayHost: string, harness = "claude-code", bundle?: string, home?: string): Person {
  const root = tempDir();
  home ??= join(root, "home");
  const project = join(root, "project");
  mkdirSync(project);
  const env: Record<string, string> = {
    ...platformEnv(root),
    PATH: process.env.PATH ?? "",
    HOME: root,
    PAIRWIRE_HOME: home,
    PAIRWIRE_RELAY: relayHost,
    PAIRWIRE_NAME: name,
    PAIRWIRE_HARNESS: harness,
    PAIRWIRE_PROJECT_DIR: project,
  };
  let sessions = 0;
  const p: Person = {
    name,
    home,
    project,
    env,
    logs: [],
    results: [],
    client: null,
    pid: null,
    async call(tool, args = {}) {
      if (!p.client) throw new Error(`${name} has no open session`);
      const res = await p.client.callTool({ name: tool, arguments: args });
      const text = (res.content as { type: string; text: string }[]).map((c) => c.text).join("\n");
      p.results.push({ tool, text });
      return text;
    },
    async open(sessionId) {
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: bundle ? [bundle, "mcp"] : ["--conditions=source", "--import", TSX, MAIN, "mcp"],
        env: { ...env, CLAUDE_CODE_SESSION_ID: sessionId ?? `${name}-session-${++sessions}` },
        cwd: project,
        stderr: "pipe",
      });
      transport.stderr?.on("data", (d) => p.logs.push(String(d)));
      const client = new Client({ name: `e2e-${name}`, version: "0" });
      await client.connect(transport);
      p.client = client;
      p.pid = transport.pid;
      cleanups.push(() => p.close());
    },
    async close() {
      const c = p.client;
      p.client = null;
      p.pid = null;
      await c?.close();
    },
  };
  return p;
}

/** Runs `pairwire <args>` from the sources as `p` would in a shell in their project, with `input` on stdin. */
export function runCli(p: Pick<Person, "env" | "project">, args: string[], input = ""): string {
  return execFileSync(process.execPath, ["--conditions=source", "--import", TSX, MAIN, ...args], { env: p.env, cwd: p.project, input, encoding: "utf8" });
}

export async function until(cond: () => boolean | Promise<boolean>, ms = 10_000, what = "condition"): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

export const SHARE = /pw1_[a-z2-7]{52}(?:@[a-z0-9.:-]+)?/;
