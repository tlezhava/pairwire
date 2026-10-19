// `pairwire install --cursor` merging (04 §10 "Cursor"): pairwire's entries go into the user's
// own mcp.json and hooks.json, so everything else in them must survive install and uninstall,
// and a file pairwire can't parse is never overwritten.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { CURSOR_HOOK_EVENTS, CursorInstaller } from "../src/install-cursor.js";
import { InstallError, shellQuote } from "../src/install.js";
import { findGitBash } from "../src/platform.js";
import { tempDir } from "./state/helpers.js";

function sink() {
  let text = "";
  const out = new Writable({
    write(chunk, _enc, done) {
      text += String(chunk);
      done();
    },
  });
  return { out, text: () => text };
}

/** A plugin layout whose run.sh prints the event and dialect it was given. */
function source(): string {
  const root = tempDir();
  mkdirSync(join(root, "dist"));
  mkdirSync(join(root, "hooks"));
  mkdirSync(join(root, "skills", "pairwire"), { recursive: true });
  writeFileSync(join(root, "dist", "pairwire.mjs"), "");
  writeFileSync(join(root, "hooks", "run.sh"), 'printf "ran:%s:%s:%s" "$1" "${PAIRWIRE_HOOK_DIALECT:-${2-}}" "${PAIRWIRE_HOME-}"\n');
  writeFileSync(join(root, "skills", "pairwire", "SKILL.md"), "---\nname: pairwire\n---\n<!-- Generated from specs/06-agent-guide.md -->\n");
  return root;
}

function installer(o: { pairwireHome?: string; pinHome?: boolean } = {}) {
  const home = tempDir();
  const log = sink();
  const inst = new CursorInstaller({
    sourceRoot: source(),
    pairwireHome: o.pairwireHome ?? join(home, ".pairwire"),
    userHome: home,
    pinHome: o.pinHome ?? false,
    out: log.out,
  });
  mkdirSync(inst.cursorDir, { recursive: true });
  return { inst, home, log };
}

type Hooks = { version: number; hooks: Record<string, { command: string; timeout?: number }[]>; [k: string]: unknown };
type Mcp = { mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>; [k: string]: unknown };
const json = <T>(p: string) => JSON.parse(readFileSync(p, "utf8")) as T;
const backups = (dir: string) => readdirSync(dir).filter((f) => f.includes(".pairwire-backup-"));
const shell = process.platform === "win32" ? findGitBash(process.env) : "sh";

const USER_MCP = { mcpServers: { github: { command: "gh-mcp", args: ["--stdio"] } }, other: { keep: true } };
const USER_HOOKS = { version: 1, hooks: { stop: [{ command: "./audit.sh", timeout: 3 }], afterFileEdit: [{ command: "prettier" }] }, extra: 1 };

describe("install --cursor (04 §10)", () => {
  it("adds the MCP server, four hooks and the skill to an empty ~/.cursor", () => {
    const { inst, home, log } = installer();
    inst.install();

    const mcp = json<Mcp>(inst.mcpPath);
    expect(mcp.mcpServers.pairwire).toEqual({
      type: "stdio",
      command: "node",
      args: [inst.bundle, "mcp"],
      env: { PAIRWIRE_HARNESS: "cursor", PAIRWIRE_PROJECT_DIR: "${workspaceFolder}" },
    });
    const hooks = json<Hooks>(inst.hooksPath);
    expect(hooks.version).toBe(1);
    expect(Object.keys(hooks.hooks)).toEqual(Object.keys(CURSOR_HOOK_EVENTS));
    expect(hooks.hooks.stop).toEqual([{ command: `sh ${shellQuote(inst.runSh)} stop cursor`, timeout: 10 }]);
    expect(readFileSync(join(home, ".cursor/skills/pairwire/SKILL.md"), "utf8")).toContain("name: pairwire");
    expect(existsSync(inst.bundle)).toBe(true);
    expect(log.text()).toContain("Restart Cursor");
    expect(log.text()).toContain("ask the agent to check its pairwire inbox");
    expect(log.text()).toContain(`node ${JSON.stringify(inst.bundle)} ctl accept [drop]`);
  });

  it("keeps the user's servers, hooks and other keys, and backs up both files", () => {
    const { inst } = installer();
    writeFileSync(inst.mcpPath, JSON.stringify(USER_MCP));
    writeFileSync(inst.hooksPath, JSON.stringify(USER_HOOKS));
    inst.install();

    const mcp = json<Mcp>(inst.mcpPath);
    expect(mcp.other).toEqual({ keep: true });
    expect(Object.keys(mcp.mcpServers)).toEqual(["github", "pairwire"]);
    expect(mcp.mcpServers.github).toEqual(USER_MCP.mcpServers.github);
    const hooks = json<Hooks>(inst.hooksPath);
    expect(hooks.extra).toBe(1);
    expect(hooks.hooks.afterFileEdit).toEqual([{ command: "prettier" }]);
    expect(hooks.hooks.stop!.map((h) => h.command)).toEqual(["./audit.sh", `sh ${shellQuote(inst.runSh)} stop cursor`]);
    expect(backups(inst.cursorDir).sort()).toHaveLength(2);
    expect(JSON.parse(readFileSync(join(inst.cursorDir, backups(inst.cursorDir).find((f) => f.startsWith("mcp.json"))!), "utf8"))).toEqual(USER_MCP);
  });

  it("is idempotent, and uninstall removes only pairwire's entries", () => {
    const { inst, home } = installer();
    writeFileSync(inst.mcpPath, JSON.stringify(USER_MCP));
    writeFileSync(inst.hooksPath, JSON.stringify(USER_HOOKS));
    inst.install();
    const once = [readFileSync(inst.mcpPath, "utf8"), readFileSync(inst.hooksPath, "utf8")];
    inst.install();
    expect([readFileSync(inst.mcpPath, "utf8"), readFileSync(inst.hooksPath, "utf8")]).toEqual(once);
    expect(backups(inst.cursorDir)).toHaveLength(2); // nothing changed, nothing backed up

    inst.uninstall();
    expect(json(inst.mcpPath)).toEqual(USER_MCP);
    expect(json(inst.hooksPath)).toEqual(USER_HOOKS);
    expect(existsSync(join(home, ".cursor/skills/pairwire"))).toBe(false);
    expect(existsSync(inst.bundle)).toBe(true); // ~/.pairwire stays
  });

  it("replaces earlier pairwire hook entries, quoted or not, instead of adding a second set", () => {
    const { inst } = installer();
    writeFileSync(inst.hooksPath, JSON.stringify({ version: 1, hooks: { stop: [{ command: `sh ${inst.runSh} stop` }, { command: "./audit.sh" }] } }));
    inst.install();
    expect(json<Hooks>(inst.hooksPath).hooks.stop!.map((h) => h.command)).toEqual(["./audit.sh", `sh ${shellQuote(inst.runSh)} stop cursor`]);
  });

  it("refuses a file that isn't valid JSON, and changes nothing", () => {
    for (const file of ["mcp.json", "hooks.json"] as const) {
      const { inst } = installer();
      const broken = '{\n  // my servers\n  "mcpServers": {},\n}\n';
      writeFileSync(join(inst.cursorDir, file), broken);
      expect(() => inst.install()).toThrow(InstallError);
      expect(() => inst.install()).toThrow(/is not valid JSON \(comments and trailing commas count\).*Nothing was changed/);
      expect(readFileSync(join(inst.cursorDir, file), "utf8")).toBe(broken);
      expect(readdirSync(inst.cursorDir)).toEqual([file]);
      expect(existsSync(inst.binDir)).toBe(false);
      expect(() => inst.uninstall()).toThrow(InstallError);
      expect(readFileSync(join(inst.cursorDir, file), "utf8")).toBe(broken);
    }
  });

  it("refuses files of the wrong shape and a pairwire server it didn't install", () => {
    for (const [file, text, msg] of [
      ["mcp.json", '{"mcpServers": []}', /doesn't have the shape Cursor documents/],
      ["mcp.json", "[1, 2]", /doesn't have the shape Cursor documents/],
      ["hooks.json", '{"version": 1, "hooks": {"stop": {"command": "x"}}}', /doesn't have the shape Cursor documents/],
      ["hooks.json", '{"version": 1, "hooks": {"stop": ["x"]}}', /doesn't have the shape Cursor documents/],
      ["mcp.json", '{"mcpServers": {"pairwire": {"command": "npx", "args": ["some-other-pairwire"]}}}', /already has an mcpServers.pairwire entry that pairwire didn't install/],
    ] as const) {
      const { inst } = installer();
      writeFileSync(join(inst.cursorDir, file), text);
      expect(() => inst.install()).toThrow(msg);
      expect(readFileSync(join(inst.cursorDir, file), "utf8")).toBe(text);
      expect(existsSync(inst.binDir)).toBe(false);
    }
    // Uninstall leaves a pairwire entry someone else wrote.
    const { inst } = installer();
    const theirs = '{"mcpServers": {"pairwire": {"command": "npx", "args": ["some-other-pairwire"]}}}';
    writeFileSync(inst.mcpPath, theirs);
    inst.uninstall();
    expect(readFileSync(inst.mcpPath, "utf8")).toBe(theirs);
  });

  it("refuses a state directory path with a control character before changing any file", () => {
    const { inst } = installer({ pairwireHome: join(tempDir(), "a\u0001b", ".pairwire") });
    expect(() => inst.install()).toThrow(/contains a control character/);
    expect(readdirSync(inst.cursorDir)).toEqual([]);
  });

  it("pins a non-default state directory in the MCP env and the hook commands, quoted for sh", () => {
    const name = process.platform === "win32" ? "pair$HOME it's" : "pair$HOME `x` it's";
    const pairwireHome = join(tempDir(), name, ".pairwire");
    const { inst } = installer({ pairwireHome, pinHome: true });
    inst.install();
    expect(json<Mcp>(inst.mcpPath).mcpServers.pairwire!.env.PAIRWIRE_HOME).toBe(pairwireHome);
    const stop = json<Hooks>(inst.hooksPath).hooks.stop!.at(-1)!.command;
    expect(stop).toBe(`PAIRWIRE_HOME=${shellQuote(pairwireHome)} sh ${shellQuote(inst.runSh)} stop cursor`);
    if (shell) expect(execFileSync(shell, ["-c", stop], { encoding: "utf8" })).toBe(`ran:stop:cursor:${pairwireHome}`);
    inst.uninstall();
    expect(json<Hooks>(inst.hooksPath).hooks).toEqual({});
  });
});
