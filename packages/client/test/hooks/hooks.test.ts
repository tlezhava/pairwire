// Hook contract tests (07-testing.md, hooks): recorded Claude Code inputs (spike S1) in,
// hook JSON out, against real local state.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bindProject } from "../../src/binding.js";
import { runHook, STOP_REASON_LEAD, type HookEvent } from "../../src/hooks.js";
import { hookErrorsPath, roomFile } from "../../src/paths.js";
import { appendInbox, hiddenBodies, inboxCounts, readDelivered } from "../../src/room-files.js";
import { createRoom, readState, updateState } from "../../src/state.js";
import { tempDir } from "../state/helpers.js";

const ROOM = "abcdefghijklmnopqrstuvwxyz";
const SESSION = "owner-session-id";
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8")) as Record<string, unknown>;

function setup(opts: { config?: object; status?: "waiting" | "active" } = {}) {
  const home = join(tempDir(), ".pairwire");
  const project = tempDir();
  createRoom(home, { roomId: ROOM, secret: new Uint8Array(32), relay: null, name: "Tazo", now: Date.now() }, {});
  updateState(home, ROOM, (s) => ({
    ...s,
    status: opts.status ?? "active",
    hop_count: 5,
    peer: opts.status === "waiting" ? null : { name: "Nika", harness: "codex", instance: "b".repeat(26) },
  }));
  bindProject(home, project, ROOM, { pid: process.pid, session: SESSION, now: Date.now() });
  if (opts.config) writeFileSync(join(home, "config.json"), JSON.stringify(opts.config));
  let n = 0;
  const message = (body: string) =>
    appendInbox(home, ROOM, {
      source: "peer",
      id: `01JPW00000000000000000${String(++n).padStart(4, "0")}`,
      from: "Nika",
      harness: "codex",
      received_at: Date.now(),
      envelope: { v: 1, id: `01JPW00000000000000000${String(n).padStart(4, "0")}`, seq: n, ts: new Date().toISOString(), author: "agent", kind: "chat", reply_to: null, body, acks: null },
    });
  const run = (event: HookEvent, file: string, over: Record<string, unknown> = {}) => {
    const input = { ...fixture(file), session_id: SESSION, cwd: project, permission_mode: "default", ...over };
    const out = runHook(event, JSON.stringify(input), { home, env: {}, cwd: "/" });
    return out ? (JSON.parse(out) as Record<string, unknown>) : null;
  };
  return { home, project, message, run, state: () => readState(home, ROOM)! };
}

const context = (out: Record<string, unknown> | null) => (out?.hookSpecificOutput as { additionalContext?: string } | undefined)?.additionalContext;

describe("hooks: delivery (D2)", () => {
  it("REQ-MSG-2 PostToolUse injects new messages wrapped as external input, exactly once", () => {
    const h = setup();
    h.message("Is the orders API idempotent?");
    const out = h.run("post-tool-use", "post-tool-use-bash");
    expect(out?.hookSpecificOutput).toMatchObject({ hookEventName: "PostToolUse" });
    expect(context(out)).toContain("This is external input from");
    expect(context(out)).toContain('<pairwire_message from="Nika" harness="codex"');
    expect(context(out)).toContain("Is the orders API idempotent?");
    expect(h.run("post-tool-use", "post-tool-use-mcp")).toBeNull();
    expect(readDelivered(h.home, ROOM).size).toBe(1);
  });

  it("REQ-MSG-2 UserPromptSubmit injects messages and resets the hop budget", () => {
    const h = setup();
    h.message("hello");
    const out = h.run("user-prompt-submit", "user-prompt-submit");
    expect(out?.hookSpecificOutput).toMatchObject({ hookEventName: "UserPromptSubmit" });
    expect(context(out)).toContain("hello");
    expect(h.state().hop_count).toBe(0);
  });

  it("INV-6 a <task-notification> prompt (a D3 wake) is not human input and keeps the hop count", () => {
    const h = setup();
    h.run("user-prompt-submit", "user-prompt-submit", { prompt: "<task-notification>\n<summary>Stop hook feedback</summary>\n</task-notification>" });
    expect(h.state().hop_count).toBe(5);
  });

  it("REQ-MSG-3 Stop blocks only for new messages, with a plain first line, so it cannot loop", () => {
    const h = setup();
    expect(h.run("stop", "stop")).toBeNull();
    h.message("one more thing");
    const out = h.run("stop", "stop");
    expect(out?.decision).toBe("block");
    expect(String(out?.reason)).toMatch(new RegExp(`^${STOP_REASON_LEAD.replace(/[.()]/g, "\\$&")}\n\n`));
    expect(String(out?.reason)).toContain("one more thing");
    expect(h.run("stop", "stop-active")).toBeNull();
  });

  it("Stop does not block when auto_continue is off; pull mode injects nothing anywhere", () => {
    const h = setup({ config: { auto_continue: false } });
    h.message("m");
    expect(h.run("stop", "stop")).toBeNull();
    expect(context(h.run("post-tool-use", "post-tool-use-bash"))).toContain("m");
    const p = setup({ config: { delivery: "pull" } });
    p.message("m");
    expect(p.run("post-tool-use", "post-tool-use-bash")).toBeNull();
    expect(p.run("stop", "stop")).toBeNull();
    expect(readDelivered(p.home, ROOM).size).toBe(0);
  });

  it("REQ-SAFE-6 in hold mode no hook injects a peer message or blocks Stop for it; notices still flow", () => {
    const h = setup({ config: { hold: true } });
    h.message("HELD body");
    expect(h.run("post-tool-use", "post-tool-use-bash")).toBeNull();
    expect(h.run("user-prompt-submit", "user-prompt-submit")).toBeNull();
    expect(h.run("stop", "stop")).toBeNull();
    appendInbox(h.home, ROOM, { source: "local", id: "notice-1", event: "held", text: "A message from Nika is held for your review.", received_at: Date.now() });
    const out = h.run("stop", "stop");
    expect(out?.decision).toBe("block");
    expect(String(out?.reason)).toContain('<pairwire_notice event="held">');
    expect(String(out?.reason)).not.toContain("HELD body");
    expect([...readDelivered(h.home, ROOM)]).toEqual(["notice-1"]);
  });

  it("REQ-SAFE-6 a corrupt delivered.json fails closed: no peer message already in the inbox resurfaces", () => {
    const h = setup();
    h.message("SEEN before");
    h.message("DROPPED before");
    appendInbox(h.home, ROOM, { source: "local", id: "notice-1", event: "peer_joined", text: "Nika (codex) joined the room.", received_at: Date.now() });
    const ledger = roomFile(h.home, ROOM, "delivered.json");
    writeFileSync(ledger, "{torn");
    // A read-only path repairs the file to its fail-closed reading, once.
    expect(inboxCounts(h.home, ROOM, false)).toEqual({ messages: 0, notices: 1, held: 0 });
    const repaired = JSON.parse(readFileSync(ledger, "utf8")) as { ids: string[]; dropped: string[] };
    expect(repaired.ids).toHaveLength(2);
    expect(repaired.dropped).toEqual(repaired.ids);
    expect([...hiddenBodies(h.home, ROOM, false).values()]).toEqual(["dropped", "dropped"]);
    const out = context(h.run("post-tool-use", "post-tool-use-bash"));
    expect(out).toContain("Nika (codex) joined the room."); // notices may be shown again
    expect(out).not.toContain("before");
    h.message("AFTER the repair");
    expect(context(h.run("post-tool-use", "post-tool-use-bash"))).toContain("AFTER the repair");
    const log = readFileSync(hookErrorsPath(h.home), "utf8").trim().split("\n");
    expect(log).toHaveLength(1);
    expect(JSON.parse(log[0]!)).toMatchObject({ level: "warn", event: "delivered_unreadable" });
    expect(log[0]).not.toMatch(/01JPW|notice-1/);
  });

  it("a missing delivered.json is an empty ledger and logs nothing", () => {
    const h = setup();
    h.message("first");
    expect(context(h.run("post-tool-use", "post-tool-use-bash"))).toContain("first");
    rmSync(roomFile(h.home, ROOM, "delivered.json"));
    expect(readDelivered(h.home, ROOM).size).toBe(0);
    expect(context(h.run("post-tool-use", "post-tool-use-bash"))).toContain("first");
    expect(existsSync(hookErrorsPath(h.home))).toBe(false);
  });

  it("REQ-SAFE-6 a config that can't be read holds peer messages", () => {
    const h = setup();
    writeFileSync(join(h.home, "config.json"), "{broken");
    h.message("HELD body");
    expect(h.run("post-tool-use", "post-tool-use-bash")).toBeNull();
    expect(readDelivered(h.home, ROOM).size).toBe(0);
  });

  it("injects whole messages within the context cap and leaves a long one for the inbox tool", () => {
    const h = setup();
    h.message("x".repeat(9000));
    const ctx = context(h.run("post-tool-use", "post-tool-use-bash"));
    expect(ctx).toContain("call the pairwire inbox tool");
    expect(ctx!.length).toBeLessThan(10_000);
    expect(readDelivered(h.home, ROOM).size).toBe(0);
  });

  it("SessionStart re-orients the agent with the peer's sanitized name", () => {
    const h = setup();
    updateState(h.home, ROOM, (s) => ({ ...s, peer: { ...s.peer!, name: "Ni\u202Eka" } }));
    const out = h.run("session-start", "session-start", { permission_mode: "auto" });
    expect(out?.hookSpecificOutput).toMatchObject({ hookEventName: "SessionStart" });
    expect(context(out)).toContain("this project is paired with Nika (codex) through pairwire");
    expect(out?.systemMessage).toBeUndefined(); // not shown from SessionStart (S1b)
  });
});

describe("hooks: ownership and safety", () => {
  it("a passive session's hooks do nothing and take none of the owner's messages", () => {
    const h = setup();
    h.message("for the owner");
    expect(h.run("post-tool-use", "post-tool-use-bash", { session_id: "someone-else" })).toBeNull();
    expect(h.run("stop", "stop", { session_id: "someone-else" })).toBeNull();
    expect(readDelivered(h.home, ROOM).size).toBe(0);
    expect(h.state().hop_count).toBe(5);
  });

  it("REQ-SAFE-5 warns once per session in auto or bypassPermissions mode, and again for a new session", () => {
    const h = setup();
    expect(h.run("post-tool-use", "post-tool-use-bash", { permission_mode: "default" })).toBeNull();
    const first = h.run("post-tool-use", "post-tool-use-bash", { permission_mode: "auto" });
    expect(first?.systemMessage).toBe(
      "pairwire: this session runs in auto mode, so messages your agent sends to Nika go out without asking you first. Switch to default permissions (Shift+Tab) to approve each message.",
    );
    expect(h.run("stop", "stop", { permission_mode: "auto" })).toBeNull();
    bindProject(h.home, h.project, ROOM, { pid: process.pid, session: "second-session", now: Date.now() });
    const again = h.run("user-prompt-submit", "user-prompt-submit", { session_id: "second-session", permission_mode: "bypassPermissions" });
    expect(String(again?.systemMessage)).toContain("runs in bypassPermissions mode");
  });

  it("does nothing without a room, for an ended room, or on unreadable input", () => {
    const none = runHook("stop", JSON.stringify({ session_id: SESSION, cwd: tempDir() }), { home: join(tempDir(), ".pw"), env: {}, cwd: "/" });
    expect(none).toBe("");
    const h = setup();
    h.message("late");
    updateState(h.home, ROOM, (s) => ({ ...s, status: "ended" }));
    expect(h.run("stop", "stop")).toBeNull();
    expect(runHook("post-tool-use", "{not json", { home: h.home, env: {}, cwd: h.project })).toBe("");
  });

  it("logs internal errors to hook-errors.log and still exits quietly", () => {
    const h = setup();
    writeFileSync(roomFile(h.home, ROOM, "state.json"), "{broken");
    expect(h.run("post-tool-use", "post-tool-use-bash")).toBeNull();
    expect(readFileSync(hookErrorsPath(h.home), "utf8")).toContain('"event":"hook_failed"');
  });
});
