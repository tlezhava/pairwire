#!/usr/bin/env node
import { createRequire as __pwCreateRequire } from "node:module";
const require = __pwCreateRequire(import.meta.url);
import {
  pairwireHome
} from "./chunks/chunk-GVGSGJLD.mjs";
import "./chunks/chunk-KARZWXGF.mjs";

// packages/client/src/main.ts
async function readStdin() {
  let text = "";
  for await (const chunk of process.stdin) text += String(chunk);
  return text;
}
async function main(argv) {
  const [command] = argv;
  if (command === "mcp") {
    const { runMcpServer } = await import("./chunks/mcp-DJTNVPFX.mjs");
    await runMcpServer();
    return -1;
  }
  if (command === "hook") {
    const event = argv[1];
    const stdin = await readStdin();
    const opts = { home: pairwireHome(), env: process.env, cwd: process.cwd() };
    if (event === "stop-wait") {
      for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.once(sig, () => process.exit(0));
      const { runStopWait } = await import("./chunks/waiter-5K36UDWM.mjs");
      return runStopWait(stdin, { ...opts, stderr: process.stderr });
    }
    const { HOOK_EVENTS, runHook } = await import("./chunks/hooks-PEA6P32V.mjs");
    if (!HOOK_EVENTS.includes(event ?? "")) return 0;
    const out = runHook(event, stdin, opts);
    if (out) process.stdout.write(out + "\n");
    if (event === "user-prompt-submit" || event === "post-tool-use") {
      const { cancelWaiter } = await import("./chunks/waiter-5K36UDWM.mjs");
      await cancelWaiter(stdin, opts);
    }
    return 0;
  }
  if (command === "ctl") {
    const { runCtl } = await import("./chunks/ctl-G2OUFA24.mjs");
    return runCtl(argv.slice(1), { stdin: process.stdin, stdout: process.stdout, env: process.env, cwd: process.cwd() });
  }
  if (command === "doctor") {
    const { runDoctor } = await import("./chunks/doctor-VRKXZIDX.mjs");
    return runDoctor({ home: pairwireHome(), env: process.env, out: process.stdout });
  }
  if (command === "purge") {
    const { runPurge } = await import("./chunks/doctor-VRKXZIDX.mjs");
    const flags = new Set(argv.slice(1));
    return runPurge({ home: pairwireHome(), out: process.stdout, all: flags.has("--all"), force: flags.has("--force") });
  }
  if (command === "install") {
    const { defaultInstallOptions, Installer, InstallError, printConfig, runningPluginRoot } = await import("./chunks/install-QEZBR7VQ.mjs");
    const args = argv.slice(1);
    try {
      const printFor = args.indexOf("--print-config");
      if (printFor >= 0) {
        const root = runningPluginRoot();
        if (!root) throw new InstallError("Run this from the pairwire bundle (dist/pairwire.mjs).");
        printConfig(args[printFor + 1] ?? "", root, process.stdout);
        return 0;
      }
      if (args.includes("--codex")) {
        const opts = defaultInstallOptions(process.env, process.stdout, pairwireHome());
        if (!opts) throw new InstallError("Run this from the pairwire bundle (dist/pairwire.mjs).");
        const installer = new Installer(opts);
        if (args.includes("--uninstall")) installer.uninstallCodex();
        else installer.installCodex();
        return 0;
      }
    } catch (e) {
      if (!(e instanceof InstallError)) throw e;
      process.stderr.write(`pairwire install: ${e.message}
`);
      return 1;
    }
    process.stderr.write("usage: pairwire install --codex [--uninstall] | --print-config <harness>\n");
    return 2;
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
