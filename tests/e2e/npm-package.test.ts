// The npm package as published (04 §9, ADR-021): `npm run pack:npm` output, packed with
// `npm pack`, installed from the tarball into a temporary prefix and run from there.
import { execFile, execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { packNpm } from "../../scripts/pack-npm.js";
import { startRelay, tempDir } from "./harness.js";

// On Windows npm is npm.cmd, which Node only runs through a shell.
const WIN = process.platform === "win32";
const NPM = WIN ? "npm.cmd" : "npm";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const run = promisify(execFile);

describe("npm package", () => {
  it("packs without dependencies, installs from the tarball, and runs doctor, --print-config and --codex", async () => {
    const out = join(tempDir(), "npm");
    const manifest = packNpm(ROOT, out);
    const client = JSON.parse(readFileSync(join(ROOT, "packages/client/package.json"), "utf8")) as { version: string };
    expect(manifest).toMatchObject({ name: "pairwire", version: client.version, bin: { pairwire: "dist/pairwire.mjs" }, engines: { node: ">=20" }, license: "MIT" });
    expect(manifest).not.toHaveProperty("dependencies");
    expect(JSON.parse(readFileSync(join(out, "package.json"), "utf8"))).toEqual(manifest);

    // npm with a private cache and no registry access: the package must need nothing from it.
    const npmHome = tempDir();
    const npmEnv = { PATH: process.env.PATH ?? "", HOME: npmHome, npm_config_cache: join(npmHome, "cache"), npm_config_update_notifier: "false" };
    const packDir = tempDir();
    const [packed] = JSON.parse(execFileSync(NPM, ["pack", "--json", "--pack-destination", packDir], { cwd: out, env: npmEnv, encoding: "utf8", shell: WIN })) as {
      filename: string;
      files: { path: string }[];
    }[];
    const paths = packed!.files.map((f) => f.path);
    expect(paths).toEqual(expect.arrayContaining(["package.json", "README.md", "LICENSE", "THIRD_PARTY_NOTICES.md", "dist/pairwire.mjs", "hooks/run.sh", "skills/pairwire/SKILL.md"]));
    expect(paths.some((p) => p.startsWith("dist/chunks/"))).toBe(true);
    expect(paths.filter((p) => !/^(package\.json|README\.md|LICENSE|THIRD_PARTY_NOTICES\.md|dist\/.*\.mjs|hooks\/run\.sh|skills\/pairwire\/SKILL\.md)$/.test(p))).toEqual([]);

    const prefix = tempDir();
    execFileSync(NPM, ["install", "--global", "--prefix", prefix, "--offline", "--no-audit", "--no-fund", join(packDir, packed!.filename)], { env: npmEnv, encoding: "utf8", shell: WIN });
    // npm's global layout: <prefix>/bin + <prefix>/lib/node_modules, or on Windows
    // <prefix>/pairwire.cmd + <prefix>/node_modules.
    const bin = WIN ? join(prefix, "pairwire.cmd") : join(prefix, "bin", "pairwire");
    const installed = WIN ? join(prefix, "node_modules", "pairwire") : join(prefix, "lib", "node_modules", "pairwire");
    expect(existsSync(bin)).toBe(true);

    const relay = await startRelay();
    const home = tempDir();
    // Windows: the .cmd shim runs under cmd.exe, which needs the system environment.
    const env = { ...(WIN ? process.env : { PATH: process.env.PATH ?? "" }), HOME: home, CODEX_HOME: join(home, ".codex"), PAIRWIRE_HOME: join(home, ".pairwire"), PAIRWIRE_RELAY: relay.host };

    // Async: the relay runs in this process and must keep answering while doctor checks it.
    const doctor = await run(bin, ["doctor"], { env, encoding: "utf8", shell: WIN });
    expect(doctor.stdout).toContain(`ok    relay ${relay.host} answers /health`);
    expect(doctor.stdout).not.toContain("FAIL");
    expect(doctor.stdout).not.toContain("plugin hooks"); // no .claude-plugin: nothing to check

    const printed = (await run(bin, ["install", "--print-config", "cursor"], { env, encoding: "utf8", shell: WIN })).stdout;
    const entry = JSON.parse(printed.slice(printed.indexOf("{"), printed.indexOf("\n}\n") + 2)) as { mcpServers: { pairwire: { args: string[] } } };
    expect(entry.mcpServers.pairwire.args).toEqual([join(installed, "dist", "pairwire.mjs"), "mcp"]);
    expect(printed).toContain("# Agent guide");

    const codex = await run(bin, ["install", "--codex"], { env, encoding: "utf8", shell: WIN });
    expect(codex.stdout).toContain("Run /hooks in Codex and trust the four pairwire hooks");
    for (const f of ["dist/pairwire.mjs", "hooks/run.sh"]) expect(existsSync(join(home, ".pairwire", "bin", f))).toBe(true);
    expect(readFileSync(join(home, ".codex", "config.toml"), "utf8")).toContain(`args = ['${join(home, ".pairwire", "bin", "dist", "pairwire.mjs")}', "mcp"]`);
  });
});
