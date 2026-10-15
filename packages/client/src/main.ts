#!/usr/bin/env node
// The `pairwire` executable (04 §1). Subcommands land with their tasks in specs/tasks.md.
import { runCtl } from "./ctl.js";
import { runDoctor, runPurge } from "./doctor.js";
import { HOOK_EVENTS, runHook, type HookEvent } from "./hooks.js";
import { pairwireHome } from "./paths.js";
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
    // Hooks never fail the harness (04 §6): always exit 0.
    const event = argv[1] as HookEvent;
    if (!(HOOK_EVENTS as readonly string[]).includes(event)) return 0;
    let stdin = "";
    for await (const chunk of process.stdin) stdin += String(chunk);
    const out = runHook(event, stdin, { home: pairwireHome(), env: process.env, cwd: process.cwd() });
    if (out) process.stdout.write(out + "\n");
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
