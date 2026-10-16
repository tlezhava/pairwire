// Platform helpers (04 §1, §3, §6; ADR-021): the Windows branches, tested on every OS.
import { posix, win32 } from "node:path";
import { describe, expect, it } from "vitest";
import { envValue, findDistDir, findGitBash, isInsideDir } from "../src/platform.js";

const files = (...paths: string[]) => {
  const set = new Set(paths.map((p) => p.toLowerCase()));
  return (p: string) => set.has(p.toLowerCase());
};

describe("findDistDir", () => {
  it("finds the bundle's dist/ from the entry file or a chunk, with either separator", () => {
    const isRoot = (root: string) => root === "/p" || root === "C:\\p";
    expect(findDistDir("/p/dist", isRoot, posix)).toBe("/p/dist");
    expect(findDistDir("/p/dist/chunks", isRoot, posix)).toBe("/p/dist");
    expect(findDistDir("C:\\p\\dist", isRoot, win32)).toBe("C:\\p\\dist");
    expect(findDistDir("C:\\p\\dist\\chunks", isRoot, win32)).toBe("C:\\p\\dist");
    expect(findDistDir("/p/src", isRoot, posix)).toBeNull();
    expect(findDistDir("/q/dist", isRoot, posix)).toBeNull();
    expect(findDistDir("/p/distx", isRoot, posix)).toBeNull();
  });
});

describe("isInsideDir", () => {
  it("compares Windows paths case-insensitively and refuses siblings and other drives", () => {
    expect(isInsideDir("C:\\Users\\Tazo\\.pairwire", "C:\\Users\\Tazo")).toBe(true);
    expect(isInsideDir("c:\\users\\tazo\\.pairwire", "C:\\Users\\Tazo")).toBe(true);
    expect(isInsideDir("C:\\Users\\Tazo", "C:\\Users\\Tazo")).toBe(true);
    expect(isInsideDir("C:\\Users\\Tazo2\\.pairwire", "C:\\Users\\Tazo")).toBe(false);
    expect(isInsideDir("C:\\pairwire", "C:\\Users\\Tazo")).toBe(false);
    expect(isInsideDir("D:\\Users\\Tazo\\.pairwire", "C:\\Users\\Tazo")).toBe(false);
  });
});

describe("envValue", () => {
  it("looks variables up regardless of case and treats empty as unset", () => {
    expect(envValue({ Path: "a;b" }, "PATH")).toBe("a;b");
    expect(envValue({ USERPROFILE: "" }, "USERPROFILE")).toBeUndefined();
    expect(envValue({}, "X")).toBeUndefined();
  });
});

describe("findGitBash", () => {
  const BASH = "C:\\Program Files\\Git\\bin\\bash.exe";

  it("uses CLAUDE_CODE_GIT_BASH_PATH when set, and only if it exists", () => {
    expect(findGitBash({ CLAUDE_CODE_GIT_BASH_PATH: "D:\\tools\\bash.exe" }, files("D:\\tools\\bash.exe", BASH))).toBe("D:\\tools\\bash.exe");
    expect(findGitBash({ CLAUDE_CODE_GIT_BASH_PATH: "D:\\nope\\bash.exe", ProgramFiles: "C:\\Program Files" }, files(BASH))).toBeNull();
  });

  it("finds bin\\bash.exe next to the git.exe on PATH (cmd or mingw64\\bin)", () => {
    const exists = files("E:\\Git\\cmd\\git.exe", "E:\\Git\\bin\\bash.exe");
    expect(findGitBash({ Path: 'C:\\Windows;"E:\\Git\\cmd"' }, exists)).toBe("E:\\Git\\bin\\bash.exe");
    const mingw = files("E:\\Git\\mingw64\\bin\\git.exe", "E:\\Git\\bin\\bash.exe");
    expect(findGitBash({ PATH: "E:\\Git\\mingw64\\bin" }, mingw)).toBe("E:\\Git\\bin\\bash.exe");
  });

  it("falls back to the usual install directories, else reports none", () => {
    expect(findGitBash({ ProgramFiles: "C:\\Program Files" }, files(BASH))).toBe(BASH);
    const user = "C:\\Users\\tazo\\AppData\\Local\\Programs\\Git\\bin\\bash.exe";
    expect(findGitBash({ LOCALAPPDATA: "C:\\Users\\tazo\\AppData\\Local" }, files(user))).toBe(user);
    expect(findGitBash({ PATH: "C:\\Windows", ProgramFiles: "C:\\Program Files" }, files())).toBeNull();
  });
});
