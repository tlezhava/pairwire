// The Codex idle wake (04 §10, ADR-033): with PAIRWIRE_DELIVERY=wake the owning server runs
// `codex queue` with the fixed WAKE_PROMPT. A fake `codex` on PATH records each argv.
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { runHook } from "../../src/hooks.js";
import { createLogger } from "../../src/log.js";
import { createMcpServer } from "../../src/mcp.js";
import { markDelivered, readInbox, readOutbox } from "../../src/room-files.js";
import { readState, updateState } from "../../src/state.js";
import { WAKE_PROMPT } from "../../src/wake.js";
import { startRelay, until } from "../connection/harness.js";
import { tempDir } from "../state/helpers.js";
import { roomOf, SHARE, side, type Side } from "./pairing.js";

const onWindows = process.platform === "win32";
const settle = () => new Promise((r) => setTimeout(r, 400));
const END = "--end-of-call--";

/** A directory holding a POSIX `codex` that records its argv, one argument per line, and exits `exit`. */
function fakeCodex(exit = 0): { dir: string; calls: () => string[][] } {
  const dir = tempDir("pw-codex-");
  const log = join(dir, "calls.log");
  writeFileSync(join(dir, "codex"), `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a" >> '${log}'; done\nprintf '%s\\n' '${END}' >> '${log}'\nexit ${exit}\n`);
  chmodSync(join(dir, "codex"), 0o755);
  const calls = () =>
    existsSync(log)
      ? readFileSync(log, "utf8")
          .split(`${END}\n`)
          .slice(0, -1) // what follows the last end marker is a call still being written
          .map((c) => c.split("\n").slice(0, -1))
      : [];
  return { dir, calls };
}

interface Setup {
  delivery?: string;
  harness?: string;
  exit?: number;
  /** PATH for the Codex side's server; default the fake's directory. */
  path?: string;
  config?: object;
}

/** A as a Codex session (session and thread learned from _meta), paired with B in Claude Code. */
async function pairedCodex(o: Setup = {}) {
  const { port } = await startRelay();
  const fake = fakeCodex(o.exit ?? 0);
  const lines: string[] = [];
  const a = side(port, "Tazo", {
    env: {
      PAIRWIRE_RELAY: `127.0.0.1:${port}`,
      PAIRWIRE_NAME: "Tazo",
      PAIRWIRE_HARNESS: o.harness ?? "codex",
      PAIRWIRE_DELIVERY: o.delivery ?? "wake",
      PATH: o.path ?? fake.dir,
    },
    log: createLogger({ sink: (l) => lines.push(l), level: "debug" }),
    ...(o.config ? { config: o.config } : {}),
  });
  const share = (await a.session.start({})).text.match(SHARE)![0];
  const b = side(port, "Nika");
  await b.session.join({ share });
  await until(() => readInbox(a.home, roomOf(a)).length > 0, 5000, "peer_joined notice");
  a.session.noteHarnessSession("codex-session-1");
  a.session.noteHarnessThread("codex-session-1", "thread-1");
  await a.session.inbox(); // the peer_joined notice
  const peerCount = () => readInbox(a.home, roomOf(a)).filter((e) => e.source === "peer").length;
  /** B sends `body`; resolves once A has it and any wake has finished. */
  const fromB = async (body: string) => {
    const n = peerCount();
    await b.session.send({ kind: "chat", body });
    await until(() => peerCount() > n, 5000, "A got it");
    await settle();
  };
  return { a, b, fake, lines, fromB };
}

const events = (lines: string[], event: string) => lines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l.event === event);

function hook(a: Side, event: "post-tool-use" | "user-prompt-submit", extra: object = {}) {
  const input = { session_id: "codex-session-1", cwd: a.project, hook_event_name: "PostToolUse", model: "gpt-5", turn_id: "t1", permission_mode: "default", ...extra };
  return runHook(event, JSON.stringify(input), { home: a.home, env: { PAIRWIRE_DELIVERY: "wake" }, cwd: "/" });
}

describe.skipIf(onWindows)("Codex idle wake (POSIX fake codex)", { timeout: 30_000 }, () => {
  it("REQ-MSG-4 runs codex queue with the exact argv, once while a wake is outstanding, again after delivery", async () => {
    const { a, fake, lines, fromB } = await pairedCodex();
    await fromB("first WAKEBODY");
    expect(fake.calls()).toEqual([["queue", "--thread", "thread-1", "--message", WAKE_PROMPT]]);
    await fromB("second WAKEBODY");
    expect(fake.calls()).toHaveLength(1); // outstanding: no second wake

    // inbox delivers, which clears it.
    expect((await a.session.inbox()).text).toContain("second WAKEBODY");
    await fromB("third WAKEBODY");
    expect(fake.calls()).toHaveLength(2);

    // A hook in another process delivers: cleared through delivered.json.
    expect(hook(a, "post-tool-use")).toContain("third WAKEBODY");
    await fromB("fourth WAKEBODY");
    expect(fake.calls()).toHaveLength(3);

    expect(events(lines, "codex_wake")).toHaveLength(3);
    expect(events(lines, "codex_wake")[0]).toMatchObject({ exit_code: 0 });
    // The log has the exit status only: never the wake text or a message.
    expect(lines.join("\n")).not.toContain("inbox tool");
    expect(lines.join("\n")).not.toContain("WAKEBODY");
  });

  it("does not wake unless delivery is wake in a Codex server with a known thread", async () => {
    for (const o of [{ delivery: "auto" }, { delivery: "pull" }, { harness: "claude-code" }, { config: { auto_continue: false } }]) {
      const { fake, fromB } = await pairedCodex(o);
      await fromB("hello");
      expect(fake.calls()).toEqual([]);
    }
  });

  it("does not wake before the server has seen a thread id, and ignores ids that could read as options", async () => {
    const { port } = await startRelay();
    const fake = fakeCodex();
    const a = side(port, "Tazo", { env: { PAIRWIRE_RELAY: `127.0.0.1:${port}`, PAIRWIRE_NAME: "Tazo", PAIRWIRE_HARNESS: "codex", PAIRWIRE_DELIVERY: "wake", PATH: fake.dir } });
    const share = (await a.session.start({})).text.match(SHARE)![0];
    const b = side(port, "Nika");
    await b.session.join({ share });
    await until(() => readInbox(a.home, roomOf(a)).length > 0, 5000, "peer_joined notice");
    await settle();
    expect(fake.calls()).toEqual([]); // no thread known yet
    a.session.noteHarnessSession("s1");
    a.session.noteHarnessThread("s1", "--help");
    a.session.noteHarnessThread("s1", "");
    a.session.noteHarnessThread("someone-else", "t-other");
    await b.session.send({ kind: "chat", body: "one" });
    await until(() => readInbox(a.home, roomOf(a)).some((e) => e.source === "peer"), 5000, "A got it");
    await settle();
    expect(fake.calls()).toEqual([]);
    a.session.noteHarnessThread(undefined, "019a-thread_2");
    await b.session.send({ kind: "chat", body: "two" });
    await until(() => fake.calls().length === 1, 5000, "wake");
    expect(fake.calls()[0]).toEqual(["queue", "--thread", "019a-thread_2", "--message", WAKE_PROMPT]);
  });

  it("never wakes for an ack, even with an unread item and no wake outstanding", async () => {
    const { a, fake, fromB } = await pairedCodex();
    await fromB("first");
    await fromB("second");
    expect(fake.calls()).toHaveLength(1);
    // A hook under its size cap showed only the first: the wake is cleared, the second is unread.
    const first = readInbox(a.home, roomOf(a)).find((e) => e.source === "peer")!;
    markDelivered(a.home, roomOf(a), [first.id]);
    // Now only an ack arrives: A sends, B acks.
    await a.session.send({ kind: "chat", body: "from Codex" });
    await until(() => readOutbox(a.home, roomOf(a)).some((e) => e.status === "delivered"), 5000, "A sees delivered");
    await settle();
    expect(fake.calls()).toHaveLength(1);
    await fromB("third"); // a message still does
    expect(fake.calls()).toHaveLength(2);
  });

  it("REQ-SAFE-6 in hold mode a held message never wakes; its one held notice does, as with D3", async () => {
    const { a, fake, fromB } = await pairedCodex();
    writeFileSync(join(a.home, "config.json"), JSON.stringify({ hold: true }));
    await fromB("held HOLDME");
    expect(fake.calls()).toHaveLength(1); // the held notice
    await fromB("held again HOLDME");
    expect(fake.calls()).toHaveLength(1);
    const inbox = await a.session.inbox(); // shows the notice, which clears the wake
    expect(inbox.text).toContain('<pairwire_notice event="held">');
    expect(inbox.text).not.toContain("HOLDME");
    await fromB("third HOLDME"); // still held, and no new notice while some are held
    expect(fake.calls()).toHaveLength(1);
  });

  it("a nonzero exit is logged once and turns the wake off for the server's life", async () => {
    const { a, fake, lines, fromB } = await pairedCodex({ exit: 3 });
    await fromB("one");
    expect(fake.calls()).toHaveLength(1);
    await until(() => events(lines, "codex_wake_failed").length === 1, 5000, "failure logged");
    expect(events(lines, "codex_wake_failed")[0]).toMatchObject({ level: "warn", exit_code: 3, timed_out: false });
    await a.session.inbox();
    await fromB("two");
    await a.session.inbox();
    await fromB("three");
    expect(fake.calls()).toHaveLength(1);
    expect(events(lines, "codex_wake_failed")).toHaveLength(1);
  });

  it("learns the thread from a Codex tool call's _meta", async () => {
    const { port } = await startRelay();
    const fake = fakeCodex();
    const a = side(port, "Tazo", { env: { PAIRWIRE_RELAY: `127.0.0.1:${port}`, PAIRWIRE_NAME: "Tazo", PAIRWIRE_HARNESS: "codex", PAIRWIRE_DELIVERY: "wake", PATH: fake.dir } });
    const server = createMcpServer(a.session);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "codex-like", version: "0" });
    await Promise.all([server.connect(st), client.connect(ct)]);
    const res = await client.callTool({ name: "start", arguments: {}, _meta: { sessionId: "codex-session-1", threadId: "thread-9" } });
    const share = (res.content as { text: string }[])[0]!.text.match(SHARE)![0];
    await client.callTool({ name: "status", arguments: {}, _meta: { sessionId: "codex-session-1", threadId: "thread-other" } });
    const b = side(port, "Nika");
    await b.session.join({ share });
    await until(() => fake.calls().length === 1, 5000, "wake for peer_joined");
    expect(fake.calls()[0]).toEqual(["queue", "--thread", "thread-9", "--message", WAKE_PROMPT]);
    await client.close();
  });
});

describe("Codex idle wake", { timeout: 30_000 }, () => {
  it("codex missing from PATH: logged once with the error code, then no more attempts", async () => {
    const { a, lines, fromB } = await pairedCodex({ path: tempDir("pw-empty-") });
    await fromB("one");
    await until(() => events(lines, "codex_wake_failed").length === 1, 5000, "failure logged");
    expect(events(lines, "codex_wake_failed")[0]).toMatchObject({ error_code: "ENOENT", exit_code: null });
    await a.session.inbox();
    await fromB("two");
    await a.session.inbox();
    await fromB("three");
    expect(events(lines, "codex_wake_failed")).toHaveLength(1);
    expect(events(lines, "codex_wake")).toHaveLength(0);
  });

  it("INV-6 the queued wake arrives as Codex's prompt and keeps the hop budget; the human's prompt resets it", async () => {
    const { a } = await pairedCodex({ path: tempDir("pw-empty-") });
    updateState(a.home, roomOf(a), (s) => ({ ...s, hop_count: 5 }));
    hook(a, "user-prompt-submit", { hook_event_name: "UserPromptSubmit", prompt: WAKE_PROMPT });
    expect(readState(a.home, roomOf(a))!.hop_count).toBe(5);
    hook(a, "user-prompt-submit", { hook_event_name: "UserPromptSubmit", prompt: "go on" });
    expect(readState(a.home, roomOf(a))!.hop_count).toBe(0);
  });
});
