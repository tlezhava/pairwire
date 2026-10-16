// End-to-end harness (07-testing.md, client integration): a real relay-node on a random port and
// `pairwire mcp` processes driven by MCP clients over stdio, each with its own PAIRWIRE_HOME.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
 * give children a minimal environment; on Windows a process also needs SYSTEMROOT, TEMP and
 * the like (the MCP SDK's defaults), or Node's networking and temp paths fail.
 */
export function platformEnv(): Record<string, string> {
  return onWindows ? getDefaultEnvironment() : {};
}

/**
 * Runs a hook command string as Claude Code runs a shell-form hook (04 §9): with `sh -c` on
 * macOS and Linux, with Git Bash on Windows (ADR-021).
 */
export function runShellCommand(command: string, o: { env: Record<string, string>; input: string }): string {
  const shell = onWindows ? findGitBash(process.env) : "sh";
  if (!shell) throw new Error("Git Bash not found; pairwire's hooks need it on Windows");
  return execFileSync(shell, ["-c", command], { env: o.env, input: o.input, encoding: "utf8" });
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

/** `bundle`: run the built plugin bundle instead of the TypeScript sources. */
export function person(name: string, relayHost: string, harness = "claude-code", bundle?: string): Person {
  const root = tempDir();
  const home = join(root, "home");
  const project = join(root, "project");
  mkdirSync(project);
  const env: Record<string, string> = {
    ...platformEnv(),
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

export async function until(cond: () => boolean | Promise<boolean>, ms = 10_000, what = "condition"): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

export const SHARE = /pw1_[a-z2-7]{52}(?:@[a-z0-9.:-]+)?/;
