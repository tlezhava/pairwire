#!/usr/bin/env node
import { createRequire as __pwCreateRequire } from "node:module";
const require = __pwCreateRequire(import.meta.url);
import {
  pairwireHome
} from "./chunks/chunk-A6UKVX6D.mjs";

// packages/client/src/main.ts
var NOT_YET = {
  install: "M6"
};
async function readStdin() {
  let text = "";
  for await (const chunk of process.stdin) text += String(chunk);
  return text;
}
async function main(argv) {
  const [command] = argv;
  if (command === "mcp") {
    const { runMcpServer } = await import("./chunks/mcp-QMQKPSAM.mjs");
    await runMcpServer();
    return -1;
  }
  if (command === "hook") {
    const event = argv[1];
    const stdin = await readStdin();
    const opts = { home: pairwireHome(), env: process.env, cwd: process.cwd() };
    if (event === "stop-wait") {
      for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.once(sig, () => process.exit(0));
      const { runStopWait } = await import("./chunks/waiter-GVUQBENV.mjs");
      return runStopWait(stdin, { ...opts, stderr: process.stderr });
    }
    const { HOOK_EVENTS, runHook } = await import("./chunks/hooks-4LMJP6PN.mjs");
    if (!HOOK_EVENTS.includes(event ?? "")) return 0;
    const out = runHook(event, stdin, opts);
    if (out) process.stdout.write(out + "\n");
    if (event === "user-prompt-submit" || event === "post-tool-use") {
      const { cancelWaiter } = await import("./chunks/waiter-GVUQBENV.mjs");
      await cancelWaiter(stdin, opts);
    }
    return 0;
  }
  if (command === "ctl") {
    const { runCtl } = await import("./chunks/ctl-NP6CBPTY.mjs");
    return runCtl(argv.slice(1), { stdin: process.stdin, stdout: process.stdout, env: process.env, cwd: process.cwd() });
  }
  if (command === "doctor") {
    const { runDoctor } = await import("./chunks/doctor-ZMSDYWL6.mjs");
    return runDoctor({ home: pairwireHome(), env: process.env, out: process.stdout });
  }
  if (command === "purge") {
    const { runPurge } = await import("./chunks/doctor-ZMSDYWL6.mjs");
    const flags = new Set(argv.slice(1));
    return runPurge({ home: pairwireHome(), out: process.stdout, all: flags.has("--all"), force: flags.has("--force") });
  }
  if (command && NOT_YET[command]) {
    process.stderr.write(`pairwire ${command}: not implemented yet (task ${NOT_YET[command]}).
`);
    return 1;
  }
  process.stderr.write("usage: pairwire <mcp|hook|ctl|doctor|purge|install> ...\n");
  return 2;
}
main(process.argv.slice(2)).then(
  (code) => {
    if (code >= 0) process.exit(code);
  },
  (e) => {
    process.stderr.write(`pairwire: ${e.message}
`);
    process.exit(1);
  }
);
