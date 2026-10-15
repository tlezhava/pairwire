#!/usr/bin/env node
// The `pairwire` executable (04 §1). Subcommands land with their tasks in specs/tasks.md.
import { runCtl } from "./ctl.js";
import { runMcpServer } from "./mcp.js";

const NOT_YET: Record<string, string> = {
  hook: "M4-1",
  doctor: "M3-7",
  purge: "M3-7",
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
  if (command && NOT_YET[command]) {
    process.stderr.write(`pairwire ${command}: not implemented yet (task ${NOT_YET[command]}).\n`);
    // Hooks must never fail the harness (04 §6).
    return command === "hook" ? 0 : 1;
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
