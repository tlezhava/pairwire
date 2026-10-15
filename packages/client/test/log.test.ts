// Client logger (04 §1, Logging; INV-7).
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { encodeShareString, generateSecret } from "@pairwire/core";
import { describe, expect, it } from "vitest";
import { createLogger, fileSink, hookErrorLogger, parseLogLevel, roomTag } from "../src/log.js";
import { tempDir } from "./state/helpers.js";

const NOW = new Date(Date.UTC(2026, 9, 16, 12));

function capture(level: "debug" | "info" | "warn" | "error" = "debug") {
  const lines: string[] = [];
  const log = createLogger({ sink: (l) => lines.push(l), level, now: () => NOW });
  return { log, lines, parsed: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>) };
}

describe("client logger", () => {
  it("writes one JSON object per line with time, level and event", () => {
    const { log, parsed } = capture();
    log.info("connected", { epoch: 3, resumed: true, relay: "relay.example.com" });
    expect(parsed()).toEqual([{ t: NOW.toISOString(), level: "info", event: "connected", epoch: 3, resumed: true, relay: "relay.example.com" }]);
  });

  it("INV-7 redacts share strings and secrets anywhere in a line, including errors", () => {
    const share = encodeShareString(generateSecret());
    const { log, lines } = capture();
    log.info(`joined with ${share}`, { detail: `string was ${share}@relay.example.com`, aws: "AKIAIOSFODNN7EXAMPLE" });
    log.error("join_failed", new Error(`bad share string ${share}`), { input: share.toUpperCase() });
    const all = lines.join("\n");
    expect(all).not.toContain(share.slice(4));
    expect(all.toLowerCase()).not.toContain(share.slice(4));
    expect(all).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(all).toContain("[redacted:pairwire_share]");
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
  });

  it("INV-7 drops fields named like secrets, tokens and keys whatever their value", () => {
    const { log, parsed } = capture();
    log.info("state", { member_token: "Zm9vYmFyYmF6", sendKey: "00".repeat(32), psk: "x", secret: "y", share_string: "z", password: "p", count: 2 });
    expect(parsed()[0]).toMatchObject({ member_token: "[redacted]", sendKey: "[redacted]", psk: "[redacted]", secret: "[redacted]", share_string: "[redacted]", password: "[redacted]", count: 2 });
    expect(JSON.stringify(parsed())).not.toContain("0000000000");
  });

  it("logs errors with name, code, message and stack", () => {
    const { log, parsed } = capture();
    const err = Object.assign(new Error("socket closed"), { code: "ECONNRESET" });
    log.error("relay_error", err, { attempt: 2 });
    expect(parsed()[0]).toMatchObject({ level: "error", event: "relay_error", attempt: 2, error_name: "Error", error_code: "ECONNRESET", error_message: "socket closed" });
    expect(parsed()[0]!.error_stack).toContain("socket closed");
  });

  it("filters by level and parses PAIRWIRE_LOG, defaulting to info", () => {
    const { log, parsed } = capture("warn");
    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");
    expect(parsed().map((l) => l.event)).toEqual(["w", "e"]);
    expect(parseLogLevel("DEBUG")).toBe("debug");
    expect(parseLogLevel(undefined)).toBe("info");
    expect(parseLogLevel("verbose")).toBe("info");
  });

  it("does not let fields override time, level or event, and never throws", () => {
    const { log, parsed } = capture();
    log.info("real", { event: "fake", level: "error", t: "then" });
    expect(parsed()[0]).toMatchObject({ event: "real", level: "info", t: NOW.toISOString() });
    const throwing = createLogger({
      sink: () => {
        throw new Error("disk full");
      },
    });
    expect(() => throwing.error("x", new Error("y"))).not.toThrow();
  });

  it("tags rooms with 4 hex characters of SHA-256(room_id)", () => {
    expect(roomTag("abcdefghijklmnopqrstuvwxyz")).toMatch(/^[0-9a-f]{4}$/);
    expect(roomTag("abcdefghijklmnopqrstuvwxyz")).not.toBe(roomTag("zyxwvutsrqponmlkjihgfedcba"));
  });
});

describe("hook error log", () => {
  it("appends errors only, to a 0600 hook-errors.log", () => {
    const home = join(tempDir(), ".pairwire");
    const log = hookErrorLogger(home);
    log.info("ignored");
    log.error("hook_failed", new Error("boom"), { hook: "stop" });
    const path = join(home, "hook-errors.log");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ event: "hook_failed", hook: "stop", error_message: "boom" });
  });

  it("moves the file to .1 above the size limit", () => {
    const dir = tempDir();
    const path = join(dir, "hook-errors.log");
    writeFileSync(path, "x".repeat(200), { mode: 0o600 });
    const sink = fileSink(path, 100);
    sink("new line");
    expect(readFileSync(`${path}.1`, "utf8")).toBe("x".repeat(200));
    expect(readFileSync(path, "utf8")).toBe("new line\n");
  });

  it("swallows write failures", () => {
    const dir = tempDir();
    mkdirSync(join(dir, "ro"));
    chmodSync(join(dir, "ro"), 0o500);
    const path = join(dir, "ro", "hook-errors.log");
    expect(() => fileSink(path)("line")).not.toThrow();
    expect(existsSync(path)).toBe(process.getuid?.() === 0);
    chmodSync(join(dir, "ro"), 0o700);
  });
});
