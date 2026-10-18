// `pairwire install --codex` quoting (04 §10, ADR-031): the hook command goes through a POSIX
// shell and the bundle path into config.toml, so both need their own quoting.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { Installer, InstallError, pathProblem, shellQuote, tomlPath } from "../src/install.js";
import { findGitBash } from "../src/platform.js";
import { tempDir } from "./state/helpers.js";

const sink = () =>
  new Writable({
    write(_chunk, _enc, done) {
      done();
    },
  });

/** A plugin layout whose run.sh prints the event it was given. */
function source(): string {
  const root = tempDir();
  mkdirSync(join(root, "dist"));
  mkdirSync(join(root, "hooks"));
  mkdirSync(join(root, "skills", "pairwire"), { recursive: true });
  writeFileSync(join(root, "dist", "pairwire.mjs"), "");
  writeFileSync(join(root, "hooks", "run.sh"), 'printf "ran:%s" "$1"\n');
  writeFileSync(join(root, "skills", "pairwire", "SKILL.md"), "---\nname: pairwire\n---\n<!-- Generated from specs/06-agent-guide.md -->\n");
  return root;
}

function installer(pairwireHome: string) {
  const home = tempDir();
  return new Installer({ sourceRoot: source(), pairwireHome, userHome: home, codexHome: join(home, ".codex"), out: sink() });
}

/** Reads a TOML literal or basic string the way TOML does, for the escapes tomlPath writes. */
function tomlValue(s: string): string {
  if (s.startsWith("'")) return s.slice(1, -1);
  return s.slice(1, -1).replace(/\\(["\\])/g, "$1");
}

type Hooks = { hooks: Record<string, { hooks: { command: string }[] }[]> };

const shell = process.platform === "win32" ? findGitBash(process.env) : "sh";

describe("install --codex quoting (ADR-031)", () => {
  // Legal in POSIX and NTFS file names; each broke the 0.2.0 command or config.toml.
  for (const name of ["pair$HOME x", "back`echo pwned`tick", "it's here", 'dq"uote']) {
    if (process.platform === "win32" && name.includes('"')) continue; // not a legal Windows file name
    it(`keeps a state directory named ${JSON.stringify(name)} literal in the hook and config.toml`, () => {
      const pairwireHome = join(tempDir(), name, ".pairwire");
      const inst = installer(pairwireHome);
      inst.installCodex();

      const args = readFileSync(inst.configPath, "utf8").match(/^args = \[(.*), "mcp"\]$/m)![1]!;
      expect(tomlValue(args)).toBe(inst.bundle);
      expect(args.startsWith(name.includes("'") ? '"' : "'")).toBe(true);

      const hooks = JSON.parse(readFileSync(inst.hooksPath, "utf8")) as Hooks;
      const stop = hooks.hooks.Stop!.at(-1)!.hooks[0]!.command;
      expect(stop).toBe(`sh ${shellQuote(inst.runSh)} stop`);
      if (shell) expect(execFileSync(shell, ["-c", stop], { encoding: "utf8" })).toBe("ran:stop");
    });
  }

  it("writes Windows backslashes unescaped in a literal string", () => {
    expect(tomlPath("C:\\Users\\tazo\\.pairwire\\bin\\dist\\pairwire.mjs")).toBe("'C:\\Users\\tazo\\.pairwire\\bin\\dist\\pairwire.mjs'");
    expect(tomlPath("C:\\Users\\o'brien\\x")).toBe('"C:\\\\Users\\\\o\'brien\\\\x"');
    expect(shellQuote("C:\\Users\\o'brien")).toBe("'C:\\Users\\o'\\''brien'");
  });

  it("refuses a path with a control character or a lone surrogate before changing any file", () => {
    for (const bad of ["/tmp/a\u0001b", "/tmp/a\u007fb", "/tmp/a\u0085b", "/tmp/a\nb", "/tmp/a\ud800b", "/tmp/a\udc00b", "/tmp/a\ud800"]) {
      expect(pathProblem(bad)).not.toBeNull();
      const inst = installer(join(bad, ".pairwire"));
      expect(() => inst.installCodex()).toThrow(InstallError);
      expect(existsSync(inst.configPath)).toBe(false);
      expect(existsSync(inst.binDir)).toBe(false);
    }
    expect(pathProblem("/tmp/\u{1F600} caf\u00e9")).toBeNull();
  });

  it("replaces the hook entries a 0.2.0 install wrote instead of adding a second set", () => {
    const pairwireHome = join(tempDir(), ".pairwire");
    const inst = installer(pairwireHome);
    mkdirSync(join(inst.configPath, ".."), { recursive: true });
    const old = (event: string) => ({ hooks: [{ type: "command", command: `sh ${JSON.stringify(inst.runSh)} ${event}`, timeout: 10 }] });
    writeFileSync(
      inst.hooksPath,
      JSON.stringify({
        hooks: {
          SessionStart: [old("session-start")],
          UserPromptSubmit: [old("user-prompt-submit")],
          PostToolUse: [{ matcher: "*", ...old("post-tool-use") }],
          Stop: [{ hooks: [{ type: "command", command: "echo mine" }] }, old("stop")],
        },
      }),
    );
    inst.installCodex();
    const hooks = JSON.parse(readFileSync(inst.hooksPath, "utf8")) as Hooks;
    expect(hooks.hooks.Stop!.map((g) => g.hooks[0]!.command)).toEqual(["echo mine", `sh ${shellQuote(inst.runSh)} stop`]);
    for (const event of ["SessionStart", "UserPromptSubmit", "PostToolUse"]) expect(hooks.hooks[event]).toHaveLength(1);
    const once = readFileSync(inst.hooksPath, "utf8");
    inst.installCodex();
    expect(readFileSync(inst.hooksPath, "utf8")).toBe(once);
    inst.uninstallCodex();
    expect(readFileSync(inst.hooksPath, "utf8")).not.toContain("run.sh");
  });
});
