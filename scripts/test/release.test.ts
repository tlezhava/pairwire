import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { bumpVersions, checkVersions, compareVersions, gitIn, LOCATIONS, parseVersion, preflight, readVersions, ReleaseError, type Git } from "../release.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const FILES = [...new Set(LOCATIONS.map((l) => l.file))];

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A temp root holding copies of the repository's real version files. */
function copyRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "pw-release-"));
  dirs.push(root);
  for (const f of FILES) cpSync(join(ROOT, f), join(root, f), { recursive: true });
  return root;
}

const lines = (text: string) => text.split("\n");

describe("parseVersion", () => {
  it("accepts X.Y.Z, a leading v and prerelease suffixes", () => {
    expect(parseVersion("0.1.0")).toBe("0.1.0");
    expect(parseVersion("v1.2.3")).toBe("1.2.3");
    expect(parseVersion("1.0.0-rc.1")).toBe("1.0.0-rc.1");
  });

  it("refuses anything else", () => {
    for (const bad of [undefined, "", "0.1", "1.2.3.4", "01.2.3", "1.2.3+build", "1.2.3-", "latest", "1.2.3-01"]) {
      expect(() => parseVersion(bad)).toThrow(ReleaseError);
    }
  });
});

describe("compareVersions", () => {
  it("orders by semver precedence", () => {
    const ordered = ["0.0.0", "0.1.0-alpha", "0.1.0-alpha.1", "0.1.0-alpha.beta", "0.1.0-beta.2", "0.1.0-beta.11", "0.1.0-rc.1", "0.1.0", "0.1.1", "0.10.0", "1.0.0"];
    for (let i = 0; i < ordered.length - 1; i++) {
      expect(compareVersions(ordered[i]!, ordered[i + 1]!)).toBeLessThan(0);
      expect(compareVersions(ordered[i + 1]!, ordered[i]!)).toBeGreaterThan(0);
    }
    expect(compareVersions("0.2.0", "0.2.0")).toBe(0);
  });
});

describe("bumpVersions", () => {
  it("writes the version to every location and changes nothing else", () => {
    const root = copyRoot();
    const before = new Map(FILES.map((f) => [f, readFileSync(join(root, f), "utf8")]));
    expect(bumpVersions(root, "9.8.7-rc.1").sort()).toEqual([...FILES].sort());
    expect(readVersions(root).map((r) => r.version)).toEqual(LOCATIONS.map(() => "9.8.7-rc.1"));
    expect(checkVersions(root, "9.8.7-rc.1")).toEqual([]);

    for (const f of FILES) {
      const old = lines(before.get(f)!);
      const now = lines(readFileSync(join(root, f), "utf8"));
      expect(now).toHaveLength(old.length);
      const diff = now.flatMap((l, i) => (l === old[i] ? [] : [[old[i], l]]));
      const expected = f === "package-lock.json" ? 3 : 1;
      expect(diff, f).toHaveLength(expected);
      for (const [o, n] of diff) {
        expect(n!.replace("9.8.7-rc.1", "X")).toBe(o!.replace(/"\d+\.\d+\.\d+(-[^"]*)?"/, '"X"'));
      }
    }
  });

  it("is idempotent", () => {
    const root = copyRoot();
    bumpVersions(root, "2.0.0");
    expect(bumpVersions(root, "2.0.0")).toEqual([]);
  });

  it("leaves @pairwire/core alone", () => {
    const root = copyRoot();
    bumpVersions(root, "2.0.0");
    const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8")) as { packages: Record<string, { version?: string; dependencies?: Record<string, string> }> };
    expect(lock.packages["packages/core"]!.version).toBe("0.0.0");
    expect(lock.packages["packages/client"]!.dependencies!["@pairwire/core"]).toBe("0.0.0");
  });

  it("refuses a manifest whose first version key is not the top-level one", () => {
    const root = copyRoot();
    const file = join(root, "packages/relay-node/package.json");
    writeFileSync(file, JSON.stringify({ name: "x", engines: { version: "1" }, version: "0.0.0" }, null, 2));
    expect(() => bumpVersions(root, "2.0.0")).toThrow(/first "version" key/);
  });
});

describe("checkVersions", () => {
  it("names every location that doesn't hold the version", () => {
    const root = copyRoot();
    bumpVersions(root, "1.0.0");
    const ts = join(root, "packages/relay-worker/src/version.ts");
    writeFileSync(ts, readFileSync(ts, "utf8").replace('"1.0.0"', '"0.9.0"'));
    expect(checkVersions(root, "1.0.0")).toEqual(["packages/relay-worker/src/version.ts: 0.9.0, expected 1.0.0"]);
    writeFileSync(join(root, "plugins/claude-code/.claude-plugin/plugin.json"), JSON.stringify({ name: "pairwire" }));
    expect(checkVersions(root, "1.0.0")).toContain("plugins/claude-code/.claude-plugin/plugin.json: no version found, expected 1.0.0");
  });
});

describe("preflight", () => {
  /** A copy of the version files committed to a fresh git repository at version 1.2.0. */
  function repo(): { root: string; git: Git } {
    const root = copyRoot();
    bumpVersions(root, "1.2.0");
    const run = gitIn(root);
    const git: Git = (...args) => run("-c", "user.name=pairwire test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...args);
    git("init", "-q", "-b", "main");
    git("add", "-A");
    git("commit", "-q", "-m", "init");
    return { root, git };
  }

  it("passes on a clean tree with a new, greater version", () => {
    const { root, git } = repo();
    expect(() => preflight("1.2.1", root, git)).not.toThrow();
    expect(() => preflight("2.0.0-rc.1", root, git)).not.toThrow();
  });

  it("refuses a version equal to or lower than the current one", () => {
    const { root, git } = repo();
    expect(() => preflight("1.2.0", root, git)).toThrow(/1\.2\.0 is not greater than the current version 1\.2\.0/);
    expect(() => preflight("1.1.9", root, git)).toThrow(/not greater than the current version 1\.2\.0/);
    expect(() => preflight("1.2.0-rc.1", root, git)).toThrow(ReleaseError);
  });

  it("refuses a tag that already exists", () => {
    const { root, git } = repo();
    git("tag", "-a", "v1.3.0", "-m", "x");
    expect(() => preflight("1.3.0", root, git)).toThrow(/Tag v1\.3\.0 already exists/);
    expect(() => preflight("1.3.1", root, git)).not.toThrow();
  });

  it("refuses changes to tracked files, staged or not", () => {
    const { root, git } = repo();
    const file = join(root, "packages/client/src/version.ts");
    const original = readFileSync(file, "utf8");
    writeFileSync(file, original + "// edit\n");
    expect(() => preflight("1.3.0", root, git)).toThrow(/changes to tracked files/);
    git("add", "-A");
    expect(() => preflight("1.3.0", root, git)).toThrow(/changes to tracked files/);
    git("reset", "-q", "--hard");
    writeFileSync(join(root, "staged-new-file.txt"), "x");
    git("add", "staged-new-file.txt");
    expect(() => preflight("1.3.0", root, git)).toThrow(/changes to tracked files/);
  });

  it("ignores untracked files, such as a local .claude/ directory", () => {
    const { root, git } = repo();
    mkdirSync(join(root, ".claude/worktrees/wf"), { recursive: true });
    writeFileSync(join(root, ".claude/worktrees/wf/file.txt"), "x");
    writeFileSync(join(root, "notes.txt"), "x");
    expect(git("status", "--porcelain")).not.toBe("");
    expect(() => preflight("1.3.0", root, git)).not.toThrow();
  });
});
