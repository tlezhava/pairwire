// Atomic writes, locks, paths and the project directory (04 §3).
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { breakStaleLock, inspectLock, LOCK_STALE_MS, lockIdentity, withLock, writeFileAtomic } from "../../src/fs-util.js";
import { chooseCtlPath, isNamedPipePath, roomDir } from "../../src/paths.js";
import { gitRoot, projectHash, resolveProjectDir } from "../../src/project.js";
import { runChild, tempDir } from "./helpers.js";

const ROOM = "abcdefghijklmnopqrstuvwxyz";
const onWindows = process.platform === "win32";

describe("writeFileAtomic", () => {
  it("writes a 0600 file, replaces it whole, and leaves no temp files behind", () => {
    const dir = tempDir();
    const file = join(dir, "state.json");
    writeFileAtomic(file, "first");
    writeFileAtomic(file, "second");
    expect(readFileSync(file, "utf8")).toBe("second");
    if (!onWindows) expect(statSync(file).mode & 0o777).toBe(0o600); // no mode bits on Windows
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

  it("excludes a 0.2.0 process holding the same lock, and is excluded by it (ADR-031)", async () => {
    const dir = tempDir();
    const file = join(dir, "counter");
    writeFileSync(file, "0");
    await Promise.all(["count", "count-0.2.0", "count", "count-0.2.0"].map((mode) => runChild([mode, file, "40"])));
    expect(readFileSync(file, "utf8")).toBe("160");
    expect(readdirSync(dir)).toEqual(["counter"]);
  }, 30_000);

  it("keeps the lock directory empty while held, as 0.1.x and 0.2.0 expect (ADR-031)", () => {
    const file = join(tempDir(), "state.json");
    withLock(file, () => expect(readdirSync(`${file}.lock`)).toEqual([]));
  });

  it("ADR-031: two processes that judged the same lock stale can't both enter", () => {
    const dir = tempDir();
    const file = join(dir, "delivered.json");
    const lock = `${file}.lock`;
    mkdirSync(lock);
    const old = (Date.now() - LOCK_STALE_MS - 1000) / 1000;
    utimesSync(lock, old, old);
    // C finds the lock stale and is then preempted...
    const verdict = inspectLock(lock);
    if (verdict.state !== "stale") throw new Error("expected a stale lock");
    // ...while B breaks the same stale lock and enters.
    withLock(file, () => {
      const held = lockIdentity(lock);
      // C resumes and acts on its old verdict: B's live lock must survive.
      expect(breakStaleLock(lock, verdict.id)).toBe(false);
      expect(lockIdentity(lock)).toBe(held);
      // A third contender sees a fresh lock and waits.
      expect(inspectLock(lock).state).toBe("fresh");
    });
    expect(readdirSync(dir)).toEqual([]);
  });

  it("ADR-031: a holder whose lock was broken and retaken does not remove the new holder's lock", () => {
    const dir = tempDir();
    const file = join(dir, "state.json");
    const lock = `${file}.lock`;
    let theirs = "";
    withLock(file, () => {
      // We overran LOCK_STALE_MS: someone broke our lock and now holds a new one.
      rmdirSync(lock);
      mkdirSync(lock);
      theirs = lockIdentity(lock);
    });
    expect(lockIdentity(lock)).toBe(theirs);
    expect(readdirSync(dir)).toEqual(["state.json.lock"]);
  });

  it("ADR-031: breaks a stale lock whose breaker died mid-break", () => {
    const dir = tempDir();
    const file = join(dir, "state.json");
    const old = (Date.now() - LOCK_STALE_MS - 1000) / 1000;
    for (const d of [`${file}.lock`, `${file}.lock.break`]) {
      mkdirSync(d);
      utimesSync(d, old, old);
    }
    expect(withLock(file, () => 7)).toBe(7);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("ADR-031: a breaker leaves a lock alone that is no longer the one it judged", () => {
    const dir = tempDir();
    const lock = join(dir, "state.json.lock");
    mkdirSync(lock);
    const old = (Date.now() - LOCK_STALE_MS - 1000) / 1000;
    utimesSync(lock, old, old);
    const verdict = inspectLock(lock);
    if (verdict.state !== "stale") throw new Error("expected a stale lock");
    // Replaced by another directory that is stale too, while the first still existed (new inode).
    renameSync(lock, `${lock}.moved`);
    mkdirSync(lock);
    rmdirSync(`${lock}.moved`);
    utimesSync(lock, old, old);
    const other = lockIdentity(lock);
    expect(breakStaleLock(lock, verdict.id)).toBe(false);
    expect(lockIdentity(lock)).toBe(other);
    expect(readdirSync(dir)).toEqual(["state.json.lock"]);
  });
});

describe("paths", () => {
  // The POSIX socket paths are built with node:path, whose separator is "\\" on Windows.
  it.skipIf(onWindows)("keeps the control socket in the room directory when the path is short", () => {
    const home = "/home/u/.pairwire";
    expect(chooseCtlPath(home, ROOM, {}, 501)).toBe(`/home/u/.pairwire/rooms/${ROOM}/ctl.sock`);
  });

  it.skipIf(onWindows)("moves the control socket to XDG_RUNTIME_DIR, else /tmp/pairwire-<uid>, when the path is too long", () => {
    const home = "/" + "x".repeat(80);
    expect(chooseCtlPath(home, ROOM, { XDG_RUNTIME_DIR: "/run/user/501" }, 501)).toMatch(/^\/run\/user\/501\/pairwire-[0-9a-f]{16}\.sock$/);
    expect(chooseCtlPath(home, ROOM, {}, 501)).toMatch(/^\/tmp\/pairwire-501\/[0-9a-f]{16}\.sock$/);
  });

  it.skipIf(onWindows)("gives two state directories in the same room different fallback sockets", () => {
    const long = "/" + "x".repeat(80);
    expect(chooseCtlPath(long + "/a", ROOM, {}, 501)).not.toBe(chooseCtlPath(long + "/b", ROOM, {}, 501));
  });

  it("on Windows uses a named pipe with a fresh random name each time (ADR-024)", () => {
    const home = "C:\\Users\\tazo\\.pairwire";
    const fixed = chooseCtlPath(home, ROOM, {}, 0, "win32", () => new Uint8Array(16).fill(0xab));
    expect(fixed).toMatch(/^\\\\\.\\pipe\\pairwire-[0-9a-f]{16}-(ab){16}$/);
    expect(isNamedPipePath(fixed)).toBe(true);
    const a = chooseCtlPath(home, ROOM, {}, 0, "win32");
    const b = chooseCtlPath(home, ROOM, {}, 0, "win32");
    expect(a).not.toBe(b);
    expect(a.slice(0, -33)).toBe(b.slice(0, -33)); // same tag, different nonce
    expect(chooseCtlPath(home + "2", ROOM, {}, 0, "win32").slice(0, -33)).not.toBe(a.slice(0, -33));
    expect(() => chooseCtlPath(home, "../../etc", {}, 0, "win32")).toThrow("Invalid room id");
  });

  it("tells a named pipe from a socket file", () => {
    expect(isNamedPipePath("\\\\?\\pipe\\x")).toBe(true);
    expect(isNamedPipePath("//./pipe/x")).toBe(true);
    expect(isNamedPipePath(`/home/u/.pairwire/rooms/${ROOM}/ctl.sock`)).toBe(false);
    expect(isNamedPipePath("C:\\Users\\pipe\\ctl.sock")).toBe(false);
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

  // Creating a symlink on Windows needs Developer Mode or an elevated process.
  it.skipIf(onWindows)("hashes the real path: 16 hex characters, equal through a symlink", () => {
    const dir = tempDir();
    const link = join(tempDir(), "link");
    symlinkSync(dir, link);
    expect(projectHash(dir)).toMatch(/^[0-9a-f]{16}$/);
    expect(projectHash(link)).toBe(projectHash(dir));
    expect(projectHash(tempDir())).not.toBe(projectHash(dir));
  });
});
