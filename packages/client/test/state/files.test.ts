// Atomic writes, locks, paths and the project directory (04 §3).
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LOCK_STALE_MS, withLock, writeFileAtomic } from "../../src/fs-util.js";
import { chooseCtlPath, roomDir } from "../../src/paths.js";
import { gitRoot, projectHash, resolveProjectDir } from "../../src/project.js";
import { runChild, tempDir } from "./helpers.js";

const ROOM = "abcdefghijklmnopqrstuvwxyz";

describe("writeFileAtomic", () => {
  it("writes a 0600 file, replaces it whole, and leaves no temp files behind", () => {
    const dir = tempDir();
    const file = join(dir, "state.json");
    writeFileAtomic(file, "first");
    writeFileAtomic(file, "second");
    expect(readFileSync(file, "utf8")).toBe("second");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(["state.json"]);
  });
});

describe("withLock", () => {
  it("serializes read-modify-write cycles across processes", async () => {
    const file = join(tempDir(), "counter");
    writeFileSync(file, "0");
    await Promise.all([1, 2, 3, 4].map(() => runChild(["count", file, "40"])));
    expect(readFileSync(file, "utf8")).toBe("160");
    expect(existsSync(`${file}.lock`)).toBe(false);
  }, 30_000);

  it("breaks a lock older than 5 s and releases the lock when the callback throws", () => {
    const file = join(tempDir(), "state.json");
    mkdirSync(`${file}.lock`);
    const old = (Date.now() - LOCK_STALE_MS - 1000) / 1000;
    utimesSync(`${file}.lock`, old, old);
    expect(withLock(file, () => 42)).toBe(42);
    expect(() =>
      withLock(file, () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(existsSync(`${file}.lock`)).toBe(false);
  });
});

describe("paths", () => {
  it("keeps the control socket in the room directory when the path is short", () => {
    const home = "/home/u/.pairwire";
    expect(chooseCtlPath(home, ROOM, {}, 501)).toBe(`/home/u/.pairwire/rooms/${ROOM}/ctl.sock`);
  });

  it("moves the control socket to XDG_RUNTIME_DIR, else /tmp/pairwire-<uid>, when the path is too long", () => {
    const home = "/" + "x".repeat(80);
    expect(chooseCtlPath(home, ROOM, { XDG_RUNTIME_DIR: "/run/user/501" }, 501)).toMatch(/^\/run\/user\/501\/pairwire-[0-9a-f]{16}\.sock$/);
    expect(chooseCtlPath(home, ROOM, {}, 501)).toMatch(/^\/tmp\/pairwire-501\/[0-9a-f]{16}\.sock$/);
  });

  it("gives two state directories in the same room different fallback sockets", () => {
    const long = "/" + "x".repeat(80);
    expect(chooseCtlPath(long + "/a", ROOM, {}, 501)).not.toBe(chooseCtlPath(long + "/b", ROOM, {}, 501));
  });

  it("refuses room ids that are not 26 base32 characters", () => {
    expect(() => roomDir("/h", "../../etc")).toThrow("Invalid room id");
    expect(() => roomDir("/h", ROOM.toUpperCase())).toThrow("Invalid room id");
  });
});

describe("resolveProjectDir", () => {
  it("prefers PAIRWIRE_PROJECT_DIR, then CLAUDE_PROJECT_DIR, ignoring unexpanded ${...} values", () => {
    const a = tempDir();
    const b = tempDir();
    const cwd = tempDir();
    expect(resolveProjectDir({ PAIRWIRE_PROJECT_DIR: a, CLAUDE_PROJECT_DIR: b }, cwd)).toBe(a);
    expect(resolveProjectDir({ PAIRWIRE_PROJECT_DIR: "${CLAUDE_PROJECT_DIR}", CLAUDE_PROJECT_DIR: b }, cwd)).toBe(b);
  });

  it("falls back to the git root of cwd, else cwd itself", () => {
    const repo = tempDir();
    mkdirSync(join(repo, ".git"));
    mkdirSync(join(repo, "src", "deep"), { recursive: true });
    expect(resolveProjectDir({}, join(repo, "src", "deep"))).toBe(repo);
    const plain = tempDir();
    expect(gitRoot(plain)).toBeNull();
    expect(resolveProjectDir({}, plain)).toBe(plain);
  });

  it("hashes the real path: 16 hex characters, equal through a symlink", () => {
    const dir = tempDir();
    const link = join(tempDir(), "link");
    symlinkSync(dir, link);
    expect(projectHash(dir)).toMatch(/^[0-9a-f]{16}$/);
    expect(projectHash(link)).toBe(projectHash(dir));
    expect(projectHash(tempDir())).not.toBe(projectHash(dir));
  });
});
