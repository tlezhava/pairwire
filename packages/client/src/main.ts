#!/usr/bin/env node
// The `pairwire` executable (04 §1). Subcommands land with their tasks in specs/tasks.md.
import { runCtl } from "./ctl.js";
import { runDoctor, runPurge } from "./doctor.js";
import { HOOK_EVENTS, runHook, type HookEvent } from "./hooks.js";
import { pairwireHome } from "./paths.js";
import { cancelWaiter, runStopWait } from "./waiter.js";
import { runMcpServer } from "./mcp.js";

const NOT_YET: Record<string, string> = {
  install: "M6",
};

async function main(argv: string[]): Promise<number> {
  const [command] = argv;
  if (command === "mcp") {
    await runMcpServer();
    return -1; // keeps running
  }
  if (command === "ctl") {
    return runCtl(argv.slice(1), { stdin: process.stdin, stdout: process.stdout, env: process.env, cwd: process.cwd() });
  }
  if (command === "hook") {
    // Hooks never fail the harness (04 §6): exit 0, except a D3 wake (2).
    const event = argv[1];
    let stdin = "";
    for await (const chunk of process.stdin) stdin += String(chunk);
    const opts = { home: pairwireHome(), env: process.env, cwd: process.cwd() };
    if (event === "stop-wait") {
      for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.once(sig, () => process.exit(0));
      return runStopWait(stdin, { ...opts, stderr: process.stderr });
    }
    if (!(HOOK_EVENTS as readonly string[]).includes(event ?? "")) return 0;
    const out = runHook(event as HookEvent, stdin, opts);
    if (out) process.stdout.write(out + "\n");
    // The session is busy: end a pending D3 waiter (04 §6 step 5).
    if (event === "user-prompt-submit" || event === "post-tool-use") await cancelWaiter(stdin, opts);
    return 0;
  }
  if (command === "doctor") return runDoctor({ home: pairwireHome(), env: process.env, out: process.stdout });
  if (command === "purge") {
    const flags = new Set(argv.slice(1));
    return runPurge({ home: pairwireHome(), out: process.stdout, all: flags.has("--all"), force: flags.has("--force") });
  }
  if (command && NOT_YET[command]) {
    process.stderr.write(`pairwire ${command}: not implemented yet (task ${NOT_YET[command]}).\n`);
    return 1;
  }
  process.stderr.write("usage: pairwire <mcp|hook|ctl|doctor|purge|install> ...\n");
  return 2;
}

main(process.argv.slice(2)).then(
  (code) => {
    if (code >= 0) process.exit(code);
  },
  (e: unknown) => {
    process.stderr.write(`pairwire: ${(e as Error).message}\n`);
    process.exit(1);
  },
);
