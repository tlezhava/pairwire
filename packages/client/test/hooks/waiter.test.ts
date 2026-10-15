// D3 waiter (04 §6, 07-testing.md hooks): `pairwire hook stop-wait` against a real session.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readInbox } from "../../src/room-files.js";
import { WAKE_LEAD } from "../../src/session.js";
import { cancelWaiter, runStopWait } from "../../src/waiter.js";
import { until } from "../connection/harness.js";
import { paired, roomOf, type Side } from "../session/pairing.js";

const MAIN = fileURLToPath(new URL("../../src/main.ts", import.meta.url));
const TSX = import.meta.resolve("tsx");

function waiter(side: Side, session = "sess-Tazo") {
  let stderr = "";
  let settled: number | null = null;
  const input = JSON.stringify({ session_id: session, cwd: side.project, hook_event_name: "Stop" });
  const done = runStopWait(input, { home: side.home, env: {}, cwd: side.project, stderr: { write: (t: string) => (stderr += t) } }).then((code) => (settled = code));
  return { done, stderr: () => stderr, settled: () => settled, input };
}

async function idleA() {
  const p = await paired();
  await p.a.session.ctlReady();
  await until(() => readInbox(p.a.home, roomOf(p.a)).length > 0, 5000, "peer_joined notice");
  await p.a.session.inbox(); // the peer_joined notice is seen; nothing undelivered
  return p;
}

const pending = (w: ReturnType<typeof waiter>) => new Promise((r) => setTimeout(r, 300)).then(() => w.settled() === null);

describe("D3 waiter (stop-wait)", () => {
  it("REQ-MSG-4 a message arriving while idle ends the waiter with exit 2 and the rendered message on stderr", async () => {
    const { a, b } = await idleA();
    const w = waiter(a);
    expect(await pending(w)).toBe(true);
    await b.session.send({ kind: "question", body: "Are you there?" });
    expect(await w.done).toBe(2);
    expect(w.stderr()).toMatch(new RegExp(`^${WAKE_LEAD.replace(/[.()]/g, "\\$&")}\n\n`));
    expect(w.stderr()).toContain('<pairwire_message from="Nika"');
    expect(w.stderr()).toContain("Are you there?");
    expect((await a.session.inbox()).text).toMatch(/^No new messages\./);
  });

  it("wakes at once for items that arrived before it registered", async () => {
    const { a, b } = await idleA();
    await b.session.send({ kind: "chat", body: "early" });
    await until(() => readInbox(a.home, roomOf(a)).some((e) => e.source === "peer"), 5000, "arrived");
    const w = waiter(a);
    expect(await w.done).toBe(2);
    expect(w.stderr()).toContain("early");
  });

  it("a second waiter for the session supersedes the first, which exits 0", async () => {
    const { a, b } = await idleA();
    const first = waiter(a);
    expect(await pending(first)).toBe(true);
    const second = waiter(a);
    expect(await first.done).toBe(0);
    expect(first.stderr()).toBe("");
    await b.session.send({ kind: "chat", body: "only once" });
    expect(await second.done).toBe(2);
  });

  it("wait_cancel from a busy hook ends it with exit 0", async () => {
    const { a } = await idleA();
    const w = waiter(a);
    expect(await pending(w)).toBe(true);
    await cancelWaiter(w.input, { home: a.home, env: {}, cwd: a.project });
    expect(await w.done).toBe(0);
  });

  it("an ack never wakes it, and it has no timer of its own", async () => {
    const { a } = await idleA();
    const w = waiter(a);
    await a.session.send({ kind: "chat", body: "my message" });
    await new Promise((r) => setTimeout(r, 1200)); // the ack arrives meanwhile
    expect(w.settled()).toBeNull();
    await cancelWaiter(w.input, { home: a.home, env: {}, cwd: a.project });
    expect(await w.done).toBe(0);
  });

  it("exits 0 at once for another session, pull delivery, auto_continue off, or no server", async () => {
    const { a } = await idleA();
    expect(await waiter(a, "some-other-session").done).toBe(0);
    writeFileSync(join(a.home, "config.json"), JSON.stringify({ delivery: "pull" }));
    expect(await waiter(a).done).toBe(0);
    writeFileSync(join(a.home, "config.json"), JSON.stringify({ auto_continue: false }));
    expect(await waiter(a).done).toBe(0);
    writeFileSync(join(a.home, "config.json"), "{}");
    a.session.shutdown();
    await new Promise((r) => setTimeout(r, 100));
    expect(await waiter(a).done).toBe(0);
  });

  it("exits 0 when the MCP server goes away while it waits", async () => {
    const { a } = await idleA();
    const w = waiter(a);
    expect(await pending(w)).toBe(true);
    a.session.shutdown();
    expect(await w.done).toBe(0);
  });

  it("the stop-wait process exits 0 on SIGTERM (session end, S3)", async () => {
    const { a } = await idleA();
    const child = spawn(process.execPath, ["--conditions=source", "--import", TSX, MAIN, "hook", "stop-wait"], {
      env: { PATH: process.env.PATH ?? "", PAIRWIRE_HOME: a.home },
      cwd: a.project,
      stdio: ["pipe", "ignore", "pipe"],
    });
    child.stdin.end(JSON.stringify({ session_id: "sess-Tazo", cwd: a.project }));
    await new Promise((r) => setTimeout(r, 1500));
    expect(child.exitCode).toBeNull(); // still waiting
    const code = await new Promise<number | null>((resolve) => {
      child.on("exit", (c) => resolve(c));
      child.kill("SIGTERM");
    });
    expect(code).toBe(0);
  }, 20_000);
});
