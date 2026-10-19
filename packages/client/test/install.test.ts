// `pairwire install --codex` quoting (04 §10, ADR-031): the hook command goes through a POSIX
// shell and the bundle path into config.toml, so both need their own quoting.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { COMMANDS, geminiPathProblem, Installer, InstallError, pathProblem, printConfig, shellQuote, tomlPath } from "../src/install.js";
import { findGitBash } from "../src/platform.js";
import { CLIENT_VERSION } from "../src/version.js";
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

describe("install --gemini (04 §10)", () => {
  type GeminiHooks = { hooks: Record<string, { matcher?: string; hooks: { name: string; type: string; command: string; timeout: number }[] }[]> };
  const REPO = fileURLToPath(new URL("../../..", import.meta.url));

  function gemini(pairwireHome?: string, platform?: NodeJS.Platform) {
    const home = tempDir();
    const out: string[] = [];
    const inst = new Installer({
      sourceRoot: source(),
      pairwireHome: pairwireHome ?? join(home, ".pairwire"),
      userHome: home,
      codexHome: join(home, ".codex"),
      out: new Writable({
        write(chunk, _enc, done) {
          out.push(String(chunk));
          done();
        },
      }),
      now: () => new Date("2026-10-19T10:00:00Z"),
      ...(platform ? { platform } : {}),
    });
    const read = (rel: string) => readFileSync(join(inst.geminiDir, rel), "utf8");
    return { home, inst, out, read };
  }

  it("REQ-X-3 writes the extension: manifest, hooks, skill, context file and commands", () => {
    const g = gemini();
    g.inst.installGemini();
    expect(existsSync(g.inst.bundle)).toBe(true);
    expect(g.out.join("")).toContain(`  1. Run: gemini extensions link ${g.inst.geminiDir}\n`);

    expect(JSON.parse(g.read("gemini-extension.json"))).toEqual({
      name: "pairwire",
      version: CLIENT_VERSION,
      mcpServers: { pairwire: { command: "node", args: [g.inst.bundle, "mcp"], env: { PAIRWIRE_HARNESS: "gemini-cli", PAIRWIRE_PROJECT_DIR: "${workspacePath}" } } },
    });

    const hooks = JSON.parse(g.read("hooks/hooks.json")) as GeminiHooks;
    expect(Object.keys(hooks.hooks)).toEqual(["SessionStart", "BeforeAgent", "AfterTool", "AfterAgent"]);
    const events = { SessionStart: "session-start", BeforeAgent: "user-prompt-submit", AfterTool: "post-tool-use", AfterAgent: "stop" };
    for (const [event, arg] of Object.entries(events)) {
      const command = `sh ${shellQuote(g.inst.runSh)} ${arg} gemini`;
      expect(hooks.hooks[event]).toEqual([{ ...(event === "AfterTool" ? { matcher: "*" } : {}), hooks: [{ name: `pairwire-${arg}`, type: "command", command, timeout: 10000 }] }]);
      if (shell) expect(execFileSync(shell, ["-c", command], { encoding: "utf8" })).toBe(`ran:${arg}`);
    }

    expect(g.read("skills/pairwire/SKILL.md")).toContain("<!-- Generated from specs/06-agent-guide.md -->");
    expect(g.read("GEMINI.md")).toContain("The `pairwire` skill is the\nguide");

    expect(g.read("commands/pairwire/say.toml")).toBe(
      [
        "# Generated by pairwire install --gemini (specs/04-client.md section 10).",
        'description = "Send your own words to your collaborator, marked as written by you"',
        'prompt = """',
        // TOML basic strings escape backslashes, so a Windows path appears doubled in the file.
        `!{node ${shellQuote(g.inst.bundle)} ctl say --args {{args}}}`.replaceAll("\\", "\\\\"),
        "",
        COMMANDS.say.text,
        '"""',
        "",
      ].join("\n"),
    );
    expect(g.read("commands/pairwire/continue.toml")).toContain(`!{node ${shellQuote(g.inst.bundle)} ctl continue}\n`.replaceAll("\\", "\\\\"));
    expect(g.read("commands/pairwire/accept.toml")).toContain("ctl accept --args {{args}}}");
    expect(g.read("commands/pairwire/log.toml")).toContain("ctl log --args {{args}}}");
  });

  it("keeps the commands' text equal to the Claude Code commands'", () => {
    for (const name of ["say", "continue", "accept", "log"] as const) {
      const md = readFileSync(join(REPO, "plugins", "claude-code", "commands", `${name}.md`), "utf8").replaceAll("\r\n", "\n");
      expect(md.slice(md.lastIndexOf("```") + 3).trim()).toBe(COMMANDS[name].text);
      expect(md).toContain(`description: ${COMMANDS[name].description}\n`);
    }
  });

  it("escapes backslashes and double quotes in the commands' TOML and pins a non-default state directory", () => {
    if (process.platform === "win32") return; // `"` is not a legal Windows file name
    const pairwireHome = join(tempDir(), 'my "pair" $x\\y', ".pairwire");
    const g = gemini(pairwireHome);
    g.inst.installGemini();
    const say = g.read("commands/pairwire/say.toml");
    const body = say.slice(say.indexOf('"""\n') + 4, say.lastIndexOf('\n"""'));
    expect(body).not.toMatch(/(^|[^\\])"/);
    expect(body.replace(/\\(["\\])/g, "$1").split("\n")[0]).toBe(`!{node ${shellQuote(g.inst.bundle)} ctl say --args {{args}}}`);
    const manifest = JSON.parse(g.read("gemini-extension.json")) as { mcpServers: { pairwire: { env: Record<string, string> } } };
    expect(manifest.mcpServers.pairwire.env.PAIRWIRE_HOME).toBe(pairwireHome);
    expect(g.out.join("")).toContain(`gemini extensions link ${shellQuote(g.inst.geminiDir)}\n`);
  });

  it("is idempotent, backs up a file it replaces, and uninstalls only the extension", () => {
    const g = gemini();
    g.inst.installGemini();
    const dir = g.inst.geminiDir;
    const snapshot = () => readdirRecursive(dir).map((f) => [f, readFileSync(join(dir, f), "utf8")]);
    const once = snapshot();
    g.inst.installGemini();
    expect(snapshot()).toEqual(once);

    writeFileSync(join(dir, "GEMINI.md"), "edited\n");
    g.inst.installGemini();
    expect(readFileSync(join(dir, "GEMINI.md.pairwire-backup-2026-10-19T10-00-00-000Z"), "utf8")).toBe("edited\n");
    expect(g.read("GEMINI.md")).toContain("# pairwire");

    g.inst.uninstallGemini();
    expect(g.out.join("")).toContain("Run: gemini extensions uninstall pairwire");
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(g.inst.bundle)).toBe(true);
  });

  it("refuses a control character, a lone surrogate, a brace, or (on Windows) a single quote before changing any file", () => {
    for (const bad of ["/tmp/a\u0001b", "/tmp/a\ud800b", "/tmp/a{b", "/tmp/a}b"]) {
      const g = gemini(join(bad, ".pairwire"));
      expect(() => g.inst.installGemini()).toThrow(InstallError);
      expect(existsSync(g.inst.binDir)).toBe(false);
    }
    expect(geminiPathProblem("C:\\Users\\o'brien\\.pairwire", "win32")).toBe("a single quote");
    expect(geminiPathProblem("/home/o'brien/.pairwire", "linux")).toBeNull();
    const g = gemini(join(tempDir(), "o'brien", ".pairwire"), "win32");
    expect(() => g.inst.installGemini()).toThrow(/single quote/);
    expect(existsSync(g.inst.binDir)).toBe(false);
  });

  it("--print-config gemini prints a settings.json entry for gemini-cli", () => {
    let out = "";
    const w = new Writable({
      write(chunk, _enc, done) {
        out += String(chunk);
        done();
      },
    });
    printConfig("gemini", source(), w);
    expect(out).toContain('"PAIRWIRE_HARNESS": "gemini-cli"');
  });
});

function readdirRecursive(dir: string, prefix = ""): string[] {
  return readdirSync(join(dir, prefix), { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? readdirRecursive(dir, join(prefix, e.name)) : [join(prefix, e.name)]))
    .sort();
}
