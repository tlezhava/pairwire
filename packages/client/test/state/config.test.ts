// Client configuration (04 §2).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, DEFAULT_CONFIG, holdMode, loadConfig, resolveDisplayName } from "../../src/config.js";
import { tempDir } from "./helpers.js";

function homeWith(config: unknown): string {
  const home = tempDir();
  writeFileSync(join(home, "config.json"), typeof config === "string" ? config : JSON.stringify(config));
  return home;
}

describe("loadConfig", () => {
  it("uses the defaults when there is no config file", () => {
    expect(loadConfig(tempDir(), {})).toEqual({ config: DEFAULT_CONFIG, warnings: [] });
    expect(DEFAULT_CONFIG).toMatchObject({ autoContinue: true, hopBudget: 8, delivery: "auto", hold: false, channels: false, relay: null });
  });

  it("reads every key from config.json", () => {
    const home = homeWith({ name: "Tazo", relay: "relay.example.com:8443", auto_continue: false, hop_budget: 3, delivery: "pull", hold: true, channels: true });
    expect(loadConfig(home, {}).config).toEqual({
      name: "Tazo",
      relay: "relay.example.com:8443",
      autoContinue: false,
      hopBudget: 3,
      delivery: "pull",
      hold: true,
      channels: true,
    });
  });

  it("lets environment variables override the file", () => {
    const home = homeWith({ name: "Tazo", relay: "a.example.com", delivery: "auto", channels: false });
    const env = { PAIRWIRE_NAME: "Nika", PAIRWIRE_RELAY: "B.Example.com", PAIRWIRE_DELIVERY: "pull", PAIRWIRE_CHANNELS: "1", PAIRWIRE_HOLD: "true" };
    expect(loadConfig(home, env).config).toMatchObject({ name: "Nika", relay: "b.example.com", delivery: "pull", channels: true, hold: true });
    expect(loadConfig(homeWith({ hold: true }), { PAIRWIRE_HOLD: "0" }).config.hold).toBe(false);
  });

  it("accepts delivery wake (the Codex idle wake, 04 §10) from the environment only", () => {
    expect(loadConfig(tempDir(), { PAIRWIRE_DELIVERY: " Wake " }).config.delivery).toBe("wake");
    // 0.1.x and 0.2.x read config.json with a strict auto/pull enum: the file never holds it.
    expect(() => loadConfig(homeWith({ delivery: "wake" }), {})).toThrow(/"delivery"/);
  });

  it("warns about unknown keys instead of failing", () => {
    const { warnings } = loadConfig(homeWith({ hop_budegt: 3 }), {});
    expect(warnings).toEqual([expect.stringContaining('unknown key "hop_budegt"')]);
  });

  it("names the bad key or variable and does not echo the value", () => {
    expect(() => loadConfig(homeWith({ hop_budget: 0 }), {})).toThrow(/"hop_budget"/);
    expect(() => loadConfig(homeWith("{not json"), {})).toThrow(ConfigError);
    expect(() => loadConfig(homeWith([]), {})).toThrow("must contain a JSON object");
    expect(() => loadConfig(homeWith({ relay: "wss://relay.example.com" }), {})).toThrow(/"relay".*without a scheme/);
    expect(() => loadConfig(tempDir(), { PAIRWIRE_DELIVERY: "push" })).toThrow('PAIRWIRE_DELIVERY must be "auto", "pull" or "wake"');
    expect(() => loadConfig(tempDir(), { PAIRWIRE_CHANNELS: "yes" })).toThrow("PAIRWIRE_CHANNELS must be");
    expect(() => loadConfig(tempDir(), { PAIRWIRE_HOLD: "on" })).toThrow("PAIRWIRE_HOLD must be");
    expect(() => loadConfig(homeWith({ hold: "yes" }), {})).toThrow(/"hold"/);
    let message = "";
    try {
      loadConfig(homeWith({ name: "pw1_aaaa".repeat(40) }), {});
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/"name"/);
    expect(message).not.toContain("pw1_");
  });
});

describe("holdMode", () => {
  it("REQ-SAFE-6 is off by default, follows the config, and holds when the config can't be read", () => {
    expect(holdMode(tempDir(), {})).toBe(false);
    expect(holdMode(homeWith({ hold: true }), {})).toBe(true);
    expect(holdMode(tempDir(), { PAIRWIRE_HOLD: "1" })).toBe(true);
    expect(holdMode(homeWith("{not json"), {})).toBe(true);
    expect(holdMode(tempDir(), { PAIRWIRE_HOLD: "maybe" })).toBe(true);
  });
});

describe("resolveDisplayName", () => {
  it("uses the configured name, else git user.name, else $USER", () => {
    expect(resolveDisplayName({ ...DEFAULT_CONFIG, name: "Configured" }, tempDir(), {})).toBe("Configured");

    const repo = tempDir();
    mkdirSync(join(repo, ".git"));
    writeFileSync(join(repo, ".git", "config"), "[user]\n\tname = Git Name\n");
    writeFileSync(join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
    mkdirSync(join(repo, ".git", "objects"));
    mkdirSync(join(repo, ".git", "refs"));
    const isolated = { PATH: process.env.PATH, HOME: tempDir(), GIT_CONFIG_NOSYSTEM: "1", USER: "unixuser" };
    expect(resolveDisplayName(DEFAULT_CONFIG, repo, isolated)).toBe("Git Name");
    expect(resolveDisplayName(DEFAULT_CONFIG, tempDir(), isolated)).toBe("unixuser");
    expect(resolveDisplayName(DEFAULT_CONFIG, tempDir(), { PATH: process.env.PATH, HOME: tempDir(), GIT_CONFIG_NOSYSTEM: "1" })).toBe("anonymous");
  });
});
