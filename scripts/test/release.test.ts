import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { bumpVersions, checkVersions, compareVersions, LOCATIONS, parseVersion, readVersions, ReleaseError } from "../release.js";

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
