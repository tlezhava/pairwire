#!/usr/bin/env node
// The `pairwire` executable (04 §1). Each subcommand is imported lazily, so a hook, which must
// finish in well under 100 ms, never loads the MCP SDK.
import { pairwireHome } from "./paths.js";

async function readStdin(): Promise<string> {
  let text = "";
  for await (const chunk of process.stdin) text += String(chunk);
  return text;
}

async function main(argv: string[]): Promise<number> {
  const [command] = argv;
  if (command === "mcp") {
    const { runMcpServer } = await import("./mcp.js");
    await runMcpServer();
    return -1; // keeps running
  }
  if (command === "hook") {
    // Hooks never fail the harness (04 §6): exit 0, except a D3 wake (2).
    const event = argv[1];
    const stdin = await readStdin();
    const opts = { home: pairwireHome(), env: process.env, cwd: process.cwd() };
    if (event === "stop-wait") {
      for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.once(sig, () => process.exit(0));
      const { runStopWait } = await import("./waiter.js");
      return runStopWait(stdin, { ...opts, stderr: process.stderr });
    }
    const { HOOK_EVENTS, runHook } = await import("./hooks.js");
    if (!(HOOK_EVENTS as readonly string[]).includes(event ?? "")) return 0;
    const out = runHook(event as (typeof HOOK_EVENTS)[number], stdin, opts);
    if (out) process.stdout.write(out + "\n");
    // The session is busy: end a pending D3 waiter (04 §6 step 5).
    if (event === "user-prompt-submit" || event === "post-tool-use") {
      const { cancelWaiter } = await import("./waiter.js");
      await cancelWaiter(stdin, opts);
    }
    return 0;
  }
  if (command === "ctl") {
    const { runCtl } = await import("./ctl.js");
    return runCtl(argv.slice(1), { stdin: process.stdin, stdout: process.stdout, env: process.env, cwd: process.cwd() });
  }
  if (command === "doctor") {
    const { runDoctor } = await import("./doctor.js");
    return runDoctor({ home: pairwireHome(), env: process.env, out: process.stdout });
  }
  if (command === "purge") {
    const { runPurge } = await import("./doctor.js");
    const flags = new Set(argv.slice(1));
    return runPurge({ home: pairwireHome(), out: process.stdout, all: flags.has("--all"), force: flags.has("--force") });
  }
  if (command === "install") {
    const { defaultInstallOptions, Installer, InstallError, printConfig, runningPluginRoot } = await import("./install.js");
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
      process.stderr.write(`pairwire install: ${e.message}\n`);
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
  (e: unknown) => {
    process.stderr.write(`pairwire: ${(e as Error).message}\n`);
    process.exit(1);
  },
);
