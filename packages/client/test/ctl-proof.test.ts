// Control-channel server proof (04 §8, ADR-029, INV-10): the owning server proves it holds
// the room's ctl.key before any ctl client writes its request or acts on a reply.
import { chmodSync, existsSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { hexToBytes } from "@noble/hashes/utils.js";
import { base32Decode, verifyCtlProof } from "@pairwire/core";
import { describe, expect, it } from "vitest";
import { runCtl } from "../src/ctl.js";
import { CTL_PROOF_FAILED_TEXT } from "../src/ctl-client.js";
import { ensureCtlKey, readCtlKey } from "../src/ctl-key.js";
import { listenFresh } from "../src/ctl-server.js";
import { runDoctor, runPurge } from "../src/doctor.js";
import { hookErrorsPath, roomDir, roomFile } from "../src/paths.js";
import { checkStatePermissions } from "../src/permissions.js";
import { readInbox } from "../src/room-files.js";
import { readSecret, readState, updateState } from "../src/state.js";
import { cancelWaiter, runStopWait } from "../src/waiter.js";
import { until } from "./connection/harness.js";
import { tempDir } from "./state/helpers.js";
import { deadPid, ownerExited, paired, roomOf, setOwnerPid, side, squatter, type Side, type SquatterKey, type SquatterMode } from "./session/pairing.js";

const HELLO_LINE = /^\{"op":"hello","v":1,"nonce":"[0-9a-f]{64}"\}\n$/;
const onWindows = process.platform === "win32";

async function ctl(s: Pick<Side, "home" | "project">, args: string[], stdin = ""): Promise<string> {
  let out = "";
  const stdout = new Writable({
    write(chunk, _enc, cb) {
      out += String(chunk);
      cb();
    },
  });
  expect(await runCtl(args, { stdin: Readable.from([stdin]), stdout, env: { PAIRWIRE_HOME: s.home }, cwd: s.project })).toBe(0);
  return out;
}

async function waiter(s: Side): Promise<{ code: number; stderr: string; input: string }> {
  let stderr = "";
  const input = JSON.stringify({ session_id: "sess-Tazo", cwd: s.project, hook_event_name: "Stop" });
  const code = await runStopWait(input, { home: s.home, env: {}, cwd: s.project, stderr: { write: (t: string) => (stderr += t) } });
  return { code, stderr, input };
}

/** Sends `lines` on one raw connection and returns every line the server sent back. */
function raw(path: string, lines: string[]): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    let buf = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(lines.map((l) => l + "\n").join("")));
    socket.on("data", (d: string) => (buf += d));
    socket.on("error", reject);
    socket.on("close", () => resolve(buf.split("\n").filter((l) => l !== "")));
  });
}

const sink = () => {
  let text = "";
  return {
    out: new Writable({
      write(chunk, _e, cb) {
        text += String(chunk);
        cb();
      },
    }),
    text: () => text,
  };
};
const okFetch = (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch;
const heldKey = (s: Side): SquatterKey => ({ key: readCtlKey(s.home, roomOf(s))!, roomIdBytes: base32Decode(roomOf(s)) });

describe("control-channel server proof (04 §8)", () => {
  it("INV-10 a genuine server proves itself before reading the request, and still serves a 0.1.x client", async () => {
    const { a } = await paired();
    await a.session.ctlReady();
    const roomId = roomOf(a);
    const key = readCtlKey(a.home, roomId)!;
    expect(key).toHaveLength(32);
    const path = readState(a.home, roomId)!.ctl_path;

    const nonce = "a1".repeat(32);
    const [proof, reply] = await raw(path, [JSON.stringify({ op: "hello", v: 1, nonce }), JSON.stringify({ op: "continue" })]);
    const parsed = JSON.parse(proof!) as { t: string; v: number; mac: string };
    expect(parsed).toMatchObject({ t: "proof", v: 1 });
    expect(verifyCtlProof(key, base32Decode(roomId), hexToBytes(nonce), hexToBytes(parsed.mac))).toBe(true);
    expect(JSON.parse(reply!)).toEqual({ ok: true, text: "pairwire: hop budget reset; your agent may send again." });

    // A 0.1.x client writes its request first: served as before.
    expect(await raw(path, [JSON.stringify({ op: "continue" })])).toEqual([JSON.stringify({ ok: true, text: "pairwire: hop budget reset; your agent may send again." })]);
    // A second hello, a malformed one, or a hello of another version is a bad request.
    const bad = JSON.stringify({ ok: false, text: "pairwire: bad control request." });
    const hello = JSON.stringify({ op: "hello", v: 1, nonce });
    expect((await raw(path, [hello, hello]))[1]).toBe(bad);
    expect(await raw(path, [JSON.stringify({ op: "hello", v: 1, nonce: "xyz" })])).toEqual([bad]);
    expect(await raw(path, [JSON.stringify({ op: "hello", v: 2, nonce })])).toEqual([bad]);

    // And the CLI goes through the exchange.
    updateState(a.home, roomId, (s) => ({ ...s, hop_count: 8 }));
    expect(await ctl(a, ["continue"])).toBe("pairwire: hop budget reset; your agent may send again.\n");
    expect(readState(a.home, roomId)!.hop_count).toBe(0);
    expect(existsSync(hookErrorsPath(a.home))).toBe(false);
  });

  it("INV-10 a squatter without the key gets nothing but the hello from say, continue, the waiter or wait_cancel", async () => {
    const { a, b } = await paired();
    await a.session.ctlReady();
    const roomId = roomOf(a);
    a.session.shutdown();
    // The binding's owner pid is alive (this process) but someone else holds ctl_path.
    const modes: SquatterMode[] = ["wake", "wrong_mac", "garbage", "silence", "close", "refuse"];
    for (const mode of modes) {
      const sq = await squatter(mode);
      ownerExited(a, sq.path, process.pid);
      updateState(a.home, roomId, (s) => ({ ...s, hop_count: 5 }));

      expect(await ctl(a, ["say"], "secret plans\n"), mode).toBe(CTL_PROOF_FAILED_TEXT + "\n");
      expect(await ctl(a, ["continue"]), mode).toBe(CTL_PROOF_FAILED_TEXT + "\n");
      expect(readState(a.home, roomId)!.hop_count, `${mode}: continue must not fall back to state.json`).toBe(5);
      const w = await waiter(a);
      expect([w.code, w.stderr], mode).toEqual([0, ""]);
      await cancelWaiter(w.input, { home: a.home, env: {}, cwd: a.project });

      await until(() => sq.received().length === 4 && sq.received().every((r) => r.endsWith("\n")), 2000, `${mode}: squatter saw four hellos`);
      await new Promise((r) => setTimeout(r, 50)); // anything sent after a hello would show up now
      const received = sq.received();
      expect(received, mode).toHaveLength(4);
      for (const r of received) expect(r, mode).toMatch(HELLO_LINE);
    }
    const log = readFileSync(hookErrorsPath(a.home), "utf8");
    expect(log).toContain('"event":"ctl_proof_failed"');
    for (const reason of ["malformed", "wrong_mac", "timeout", "closed", "refused"]) expect(log).toContain(`"reason":"${reason}"`);
    expect(log).not.toContain(roomId);
    expect(log).not.toContain(Buffer.from(readCtlKey(a.home, roomId)!).toString("hex"));
    expect(readInbox(b.home, roomOf(b)).some((e) => e.source === "peer")).toBe(false);
  }, 30_000);

  it("INV-10 a ctl.key that isn't 32 bytes fails closed without connecting", async () => {
    const { a } = await paired();
    await a.session.ctlReady();
    const roomId = roomOf(a);
    const sq = await squatter();
    ownerExited(a, sq.path, process.pid);
    writeFileSync(roomFile(a.home, roomId, "ctl.key"), new Uint8Array(16), { mode: 0o600 });
    updateState(a.home, roomId, (s) => ({ ...s, hop_count: 5 }));
    expect(await ctl(a, ["say"], "hi\n")).toBe(CTL_PROOF_FAILED_TEXT + "\n");
    expect(await ctl(a, ["continue"])).toBe(CTL_PROOF_FAILED_TEXT + "\n");
    expect(readState(a.home, roomId)!.hop_count).toBe(5);
    expect((await waiter(a)).code).toBe(0);
    expect(sq.connections()).toBe(0);
    expect(readFileSync(hookErrorsPath(a.home), "utf8")).toContain('"reason":"key_unreadable"');
  });

  it("a room without ctl.key behaves as before, and the next server to open it creates the key", async () => {
    const { a, port } = await paired();
    await a.session.ctlReady();
    const roomId = roomOf(a);
    const keyPath = roomFile(a.home, roomId, "ctl.key");
    // A running server serves a client that finds no key (a 0.1.x-style room) without the proof.
    rmSync(keyPath);
    expect(await ctl(a, ["continue"])).toBe("pairwire: hop budget reset; your agent may send again.\n");
    // No server and no key: continue resets state.json itself, as in 0.1.x.
    a.session.shutdown();
    setOwnerPid(a, deadPid());
    updateState(a.home, roomId, (s) => ({ ...s, hop_count: 5 }));
    expect(await ctl(a, ["continue"])).toBe("pairwire: hop budget reset; your agent may send again.\n");
    expect(readState(a.home, roomId)!.hop_count).toBe(0);
    // A new server taking the room over creates the key before it listens, and clients use it.
    const again = side(port, "Tazo", { home: a.home, project: a.project });
    expect(existsSync(keyPath)).toBe(true);
    const key = readFileSync(keyPath);
    await again.session.ctlReady();
    expect(await ctl(again, ["say"], "back\n")).toMatch(/^pairwire: sent your message to Nika as you/);
    // It is kept, not rotated, when the next server opens the room.
    again.session.shutdown();
    setOwnerPid(a, deadPid());
    const third = side(port, "Tazo", { home: a.home, project: a.project });
    await third.session.ctlReady();
    expect(readFileSync(keyPath).equals(key)).toBe(true);
  }, 20_000);

  it.skipIf(onWindows)("INV-9 ctl.key is created 0600 with an exclusive create and counts in the permission check", async () => {
    // Mode bits: POSIX only (07-testing.md, Layers).
    const { a } = await paired();
    await a.session.ctlReady();
    const roomId = roomOf(a);
    const keyPath = roomFile(a.home, roomId, "ctl.key");
    expect(statSync(keyPath).mode & 0o777).toBe(0o600);
    const before = readFileSync(keyPath);
    ensureCtlKey(a.home, roomId);
    expect(readFileSync(keyPath).equals(before)).toBe(true);
    chmodSync(keyPath, 0o640);
    expect(checkStatePermissions(a.home)).toEqual([{ path: keyPath, problem: "group_or_world_access" }]);
    expect(await ctl(a, ["continue"])).toContain("pairwire refuses to start");
  });

  it("leave, the end of a room, and purge remove ctl.key", async () => {
    const { a, b } = await paired();
    await a.session.ctlReady();
    await b.session.ctlReady();
    expect(existsSync(roomFile(a.home, roomOf(a), "ctl.key"))).toBe(true);
    expect(existsSync(roomFile(b.home, roomOf(b), "ctl.key"))).toBe(true);
    await a.session.leave({});
    expect(existsSync(roomFile(a.home, roomOf(a), "ctl.key"))).toBe(false);
    // The peer's leave ends B's room locally.
    await until(() => readState(b.home, roomOf(b))!.status === "ended", 5000, "B ended");
    expect(existsSync(roomFile(b.home, roomOf(b), "ctl.key"))).toBe(false);
    // purge deletes what is left of the room directory.
    writeFileSync(roomFile(a.home, roomOf(a), "ctl.key"), new Uint8Array(32), { mode: 0o600 });
    const dir = roomDir(a.home, roomOf(a));
    expect(runPurge({ home: a.home, out: sink().out, all: false, force: false })).toBe(0);
    expect(existsSync(dir)).toBe(false);
  });

  it("INV-10 continue changes nothing when a proven server gives no reply", async () => {
    const { a } = await paired();
    await a.session.ctlReady();
    const roomId = roomOf(a);
    const sq = await squatter("proven_close", heldKey(a));
    ownerExited(a, sq.path, process.pid);
    updateState(a.home, roomId, (s) => ({ ...s, hop_count: 5 }));
    // The owner is alive and proved itself, so state.json is its to change, not ours (04 §8).
    expect(await ctl(a, ["continue"])).toBe("pairwire: your agent session did not answer, so the hop budget was not reset; try again.\n");
    expect(readState(a.home, roomId)!.hop_count).toBe(5);
    expect(sq.connections()).toBe(1);
  });

  it("INV-10 ADR-029 a room past its expiry ends without a ctl.key when a session opens it", async () => {
    const { a, port } = await paired();
    await a.session.ctlReady();
    const roomId = roomOf(a);
    const keyPath = roomFile(a.home, roomId, "ctl.key");
    expect(existsSync(keyPath)).toBe(true);
    a.session.shutdown();
    setOwnerPid(a, deadPid());
    updateState(a.home, roomId, (s) => ({ ...s, expires_at: Date.now() - 1000 }));
    const again = side(port, "Tazo", { home: a.home, project: a.project });
    await again.session.ctlReady();
    expect(readState(a.home, roomId)!.status).toBe("ended");
    expect(readSecret(a.home, roomId)).toBeNull();
    expect(existsSync(keyPath)).toBe(false);
  });

  it("ADR-029 a ctl.key cut short by a crash is replaced on the next open, and creation leaves no temp file", async () => {
    const { a, port } = await paired();
    await a.session.ctlReady();
    const roomId = roomOf(a);
    const keyPath = roomFile(a.home, roomId, "ctl.key");
    for (const short of [0, 31]) {
      const oldPath = readState(a.home, roomId)!.ctl_path;
      a.session.shutdown();
      // The old listener removes its socket file as it closes: let it, before the next listens.
      if (!onWindows) await until(() => !existsSync(oldPath), 2000, "old socket removed");
      setOwnerPid(a, deadPid());
      writeFileSync(keyPath, new Uint8Array(short), { mode: 0o600 });
      const again = side(port, "Tazo", { home: a.home, project: a.project });
      a.session = again.session;
      await again.session.ctlReady();
      expect(readCtlKey(a.home, roomId), `${short} bytes`).toHaveLength(32);
      expect(await ctl(a, ["say"], "back\n")).toMatch(/^pairwire: sent your message to Nika as you/);
    }
    rmSync(keyPath);
    ensureCtlKey(a.home, roomId);
    expect(readCtlKey(a.home, roomId)).toHaveLength(32);
    expect(readdirSync(roomDir(a.home, roomId)).filter((f) => f.startsWith("ctl.key"))).toEqual(["ctl.key"]);
  }, 20_000);

  it.skipIf(onWindows)("INV-10 a ctl.key that isn't private or is a symlink fails closed in every client, hooks included", async () => {
    // Mode bits and symlinks: POSIX only (07-testing.md, Layers). The hooks don't run INV-9's check.
    const { a } = await paired();
    await a.session.ctlReady();
    const roomId = roomOf(a);
    const keyPath = roomFile(a.home, roomId, "ctl.key");
    const sq = await squatter("proven_wake", heldKey(a));
    ownerExited(a, sq.path, process.pid);
    // It holds the key: with a private key the waiter trusts it, so the cases below discriminate.
    expect((await waiter(a)).code).toBe(2);
    expect(sq.connections()).toBe(1);

    chmodSync(keyPath, 0o644);
    const w = await waiter(a);
    expect([w.code, w.stderr]).toEqual([0, ""]);
    await cancelWaiter(w.input, { home: a.home, env: {}, cwd: a.project });

    const real = join(tempDir("pw-key-"), "ctl.key");
    writeFileSync(real, readFileSync(keyPath), { mode: 0o600 });
    rmSync(keyPath);
    symlinkSync(real, keyPath);
    expect((await waiter(a)).code).toBe(0);
    expect(() => readCtlKey(a.home, roomId)).toThrow();

    expect(sq.connections()).toBe(1);
    expect(readFileSync(hookErrorsPath(a.home), "utf8")).toContain('"reason":"key_unreadable"');
  });

  it("Windows listen retry: a fresh, recorded path for each of up to 3 retries", async () => {
    const tried: string[] = [];
    let n = 0;
    const next = () => `pipe-${++n}`;
    const failTimes = (k: number) => async (p: string) => {
      tried.push(p);
      if (tried.length <= k) throw Object.assign(new Error("in use"), { code: "EADDRINUSE" });
      return p;
    };
    expect(await listenFresh("pipe-0", next, failTimes(2))).toBe("pipe-2");
    expect(tried).toEqual(["pipe-0", "pipe-1", "pipe-2"]);
    tried.length = 0;
    n = 0;
    await expect(listenFresh("pipe-0", next, failTimes(10))).rejects.toThrow("in use");
    expect(tried).toEqual(["pipe-0", "pipe-1", "pipe-2", "pipe-3"]);
    tried.length = 0;
    await expect(listenFresh("sock", null, failTimes(10))).rejects.toThrow("in use");
    expect(tried).toEqual(["sock"]);
  });

  it("INV-10 doctor checks the proof: ok for the owning server, FAIL for a squatter, deletion advice for a 0.1.x-like one", async () => {
    const { a } = await paired();
    await a.session.ctlReady();
    const roomId = roomOf(a);
    const run = async () => {
      const s = sink();
      await runDoctor({ home: a.home, env: {}, out: s.out, nodeVersion: "22.20.0", fetch: okFetch, bundleDir: null });
      return s.text();
    };
    expect(await run()).toContain(`ok    room ${roomId.slice(0, 6)}…: the session on its control channel proves it is yours`);

    const sq = await squatter("wrong_mac");
    ownerExited(a, sq.path, process.pid);
    expect(await run()).toMatch(/FAIL {2}room \w{6}…: the program on its control channel could not prove it is your pairwire session: its proof is wrong/);

    const old = await squatter("refuse");
    updateState(a.home, roomId, (s) => ({ ...s, ctl_path: old.path }));
    const text = await run();
    expect(text).toContain("It answers like pairwire 0.1.x");
    expect(text).toContain(`delete ${roomFile(a.home, roomId, "ctl.key")}`);
    // Anyone can answer that way, so the advice comes with the warning and the condition.
    expect(text).toContain("any program can answer this way");
    expect(text).toContain("only if you are sure your agent session runs pairwire 0.1.x");

    // A key that can't be used gets its own advice, not the squatter's.
    writeFileSync(roomFile(a.home, roomId, "ctl.key"), new Uint8Array(16), { mode: 0o600 });
    const corrupt = await run();
    expect(corrupt).toContain(`FAIL  room ${roomId.slice(0, 6)}…: its ctl.key is corrupt`);
    expect(corrupt).toContain(`delete ${roomFile(a.home, roomId, "ctl.key")}`);
    expect(corrupt).not.toContain("another program");
    // No live owner: nothing to check.
    setOwnerPid(a, deadPid());
    expect(await run()).not.toContain("control channel");
  });
});
