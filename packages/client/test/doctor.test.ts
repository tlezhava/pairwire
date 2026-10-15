// `pairwire doctor` and `pairwire purge` (04 §1, REQ-INST-4).
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { nodeAdvice, runDoctor, runPurge } from "../src/doctor.js";
import { activeFlagPath, roomDir } from "../src/paths.js";
import { createRoom, listRooms, updateState } from "../src/state.js";
import { tempDir } from "./state/helpers.js";

const R1 = "abcdefghijklmnopqrstuvwxyz";
const R2 = "zyxwvutsrqponmlkjihgfedcba";

function sink() {
  let text = "";
  const out = new Writable({
    write(chunk, _e, cb) {
      text += String(chunk);
      cb();
    },
  });
  return { out, text: () => text };
}

const okFetch = (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch;
const deadFetch = (async () => {
  throw new Error("ECONNREFUSED");
}) as unknown as typeof fetch;

function home() {
  return join(tempDir(), ".pairwire");
}

describe("pairwire doctor", () => {
  it("REQ-INST-4 says exactly what to install when Node is too old", async () => {
    const s = sink();
    const code = await runDoctor({ home: home(), env: {}, out: s.out, nodeVersion: "18.19.0", fetch: okFetch, bundleDir: null });
    expect(code).toBe(1);
    expect(s.text()).toContain("FAIL  Node 18.19.0 is installed, but pairwire needs Node 20 or newer. Install the current LTS from https://nodejs.org");
    expect(nodeAdvice(null)).toContain("Node.js was not found");
    expect(nodeAdvice("22.20.0")).toBeNull();
  });

  it("passes on a healthy setup and lists rooms without secrets", async () => {
    const h = home();
    createRoom(h, { roomId: R1, secret: new Uint8Array(32).fill(9), relay: "relay.example.com", name: "Tazo", now: Date.now() }, {});
    updateState(h, R1, (st) => ({ ...st, status: "active", token: "TOKEN-SHOULD-NOT-PRINT", peer: { name: "Nika", harness: "codex", instance: "a".repeat(26) } }));
    const s = sink();
    const code = await runDoctor({ home: h, env: { PAIRWIRE_RELAY: "relay.example.com" }, out: s.out, nodeVersion: "22.20.0", fetch: okFetch, bundleDir: null });
    expect(code).toBe(0);
    expect(s.text()).toContain("ok    Node 22.20.0");
    expect(s.text()).toContain("ok    room abcdef…: active, Nika (codex), expires ");
    expect(s.text()).toContain("ok    relay relay.example.com answers /health");
    expect(s.text()).not.toContain("TOKEN-SHOULD-NOT-PRINT");
    expect(s.text()).not.toMatch(/0909/);
  });

  it("fails on an unreachable relay, loose permissions and a broken config", async () => {
    const h = home();
    mkdirSync(h, { recursive: true, mode: 0o700 });
    writeFileSync(join(h, "config.json"), "{oops");
    chmodSync(h, 0o755);
    const s = sink();
    const code = await runDoctor({ home: h, env: { PAIRWIRE_RELAY: "127.0.0.1:9" }, out: s.out, nodeVersion: "22.0.0", fetch: deadFetch, bundleDir: null });
    expect(code).toBe(1);
    expect(s.text()).toMatch(/FAIL {2}config: .*is not valid JSON/);
    expect(s.text()).toContain(`chmod -R go-rwx '${h}'`);
    chmodSync(h, 0o700);
  });

  it("reports an unreachable relay", async () => {
    const s = sink();
    await runDoctor({ home: home(), env: { PAIRWIRE_RELAY: "127.0.0.1:9" }, out: s.out, nodeVersion: "22.0.0", fetch: deadFetch, bundleDir: null });
    expect(s.text()).toContain("FAIL  relay 127.0.0.1:9: unreachable (ECONNREFUSED)");
  });

  it("repairs a stale active flag and checks plugin wiring", async () => {
    const h = home();
    createRoom(h, { roomId: R1, secret: new Uint8Array(32), relay: null, name: "Tazo", now: Date.now() }, {});
    updateState(h, R1, (st) => ({ ...st, status: "ended" }));
    writeFileSync(activeFlagPath(h), "");
    const plugin = tempDir();
    mkdirSync(join(plugin, "dist"));
    mkdirSync(join(plugin, "hooks"));
    writeFileSync(join(plugin, "hooks", "hooks.json"), "{}");
    const s = sink();
    await runDoctor({ home: h, env: {}, out: s.out, nodeVersion: "22.0.0", fetch: okFetch, bundleDir: join(plugin, "dist") });
    expect(s.text()).toContain('warn  the "active" flag was set; repaired');
    expect(existsSync(activeFlagPath(h))).toBe(false);
    expect(s.text()).toContain("is missing hooks/run.sh; reinstall the plugin");
  });
});

describe("pairwire purge", () => {
  function twoRooms() {
    const h = home();
    createRoom(h, { roomId: R1, secret: new Uint8Array(32), relay: null, name: "Tazo", now: Date.now() }, {});
    createRoom(h, { roomId: R2, secret: new Uint8Array(32), relay: null, name: "Tazo", now: Date.now() }, {});
    updateState(h, R1, (st) => ({ ...st, status: "left" }));
    return h;
  }

  it("deletes left and ended rooms only", () => {
    const h = twoRooms();
    const s = sink();
    expect(runPurge({ home: h, out: s.out, all: false, force: false })).toBe(0);
    expect(listRooms(h)).toEqual([R2]);
    expect(s.text()).toBe("deleted room abcdef… (left)\n");
    expect(runPurge({ home: h, out: sink().out, all: false, force: false })).toBe(0);
  });

  it("--all refuses while a room is open, unless --force", () => {
    const h = twoRooms();
    const s = sink();
    expect(runPurge({ home: h, out: s.out, all: true, force: false })).toBe(1);
    expect(s.text()).toContain("1 room(s) still open");
    expect(existsSync(roomDir(h, R2))).toBe(true);
    expect(runPurge({ home: h, out: sink().out, all: true, force: true })).toBe(0);
    expect(existsSync(h)).toBe(false);
    rmSync(h, { recursive: true, force: true });
  });
});
