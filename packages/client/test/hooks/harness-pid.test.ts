// Session by harness pid (04 §10, ADR-033): the owning server's parent, kept beside the binding,
// lets a hook act for a binding that has no owner_session, and records the hook's session.
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { adoptOwnerSession, bindProject, claimProject, harnessPidPath, readBinding, readHarnessPid, removeBindingFor } from "../../src/binding.js";
import { runHook } from "../../src/hooks.js";
import { isHarnessProcess, parseProcessTable } from "../../src/process-tree.js";
import { appendInbox, readDelivered } from "../../src/room-files.js";
import { createRoom, updateState } from "../../src/state.js";
import { tempDir } from "../state/helpers.js";

const ROOM = "abcdefghijklmnopqrstuvwxyz";
const SERVER_PID = 4242;
const HARNESS_PID = 31337;

function setup(server: { session?: string | null; harnessPid?: number } = {}) {
  const home = join(tempDir(), ".pairwire");
  const project = tempDir();
  createRoom(home, { roomId: ROOM, secret: new Uint8Array(32), relay: null, name: "Tazo", now: Date.now() }, {});
  updateState(home, ROOM, (s) => ({ ...s, status: "active", peer: { name: "Nika", harness: "codex", instance: "b".repeat(26) } }));
  bindProject(home, project, ROOM, { pid: SERVER_PID, session: server.session ?? null, harnessPid: server.harnessPid ?? HARNESS_PID, now: Date.now() }, () => false);
  appendInbox(home, ROOM, {
    source: "peer",
    id: "01JPW000000000000000000001",
    from: "Nika",
    harness: "codex",
    received_at: Date.now(),
    envelope: { v: 1, id: "01JPW000000000000000000001", seq: 1, ts: new Date().toISOString(), author: "agent", kind: "chat", reply_to: null, body: "hello from Nika", acks: null },
  });
  let ps = 0;
  const run = (session: string | undefined, proc: { ppid: number; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; table?: Map<number, number> }) => {
    const input = { ...(session ? { session_id: session } : {}), cwd: project, hook_event_name: "PostToolUse" };
    const out = runHook("post-tool-use", JSON.stringify(input), {
      home,
      env: proc.env ?? {},
      cwd: "/",
      ppid: proc.ppid,
      platform: proc.platform ?? "linux",
      processTable: () => (ps++, proc.table ?? new Map()),
    });
    return out ? (JSON.parse(out) as { hookSpecificOutput?: { additionalContext?: string } }) : null;
  };
  return { home, project, run, psCalls: () => ps, binding: () => readBinding(home, project) };
}

describe("session by harness pid (ADR-033)", () => {
  it("the owning server writes the sidecar (0600) only while the binding has no owner_session", () => {
    const h = setup();
    const side = harnessPidPath(h.home, h.project);
    expect(JSON.parse(readFileSync(side, "utf8"))).toEqual({ owner_pid: SERVER_PID, harness_pid: HARNESS_PID });
    if (process.platform !== "win32") expect(statSync(side).mode & 0o777).toBe(0o600);
    expect(readHarnessPid(h.home, h.project, h.binding()!)).toBe(HARNESS_PID);
    // The binding keeps its strict 0.1.x/0.2.x shape: nothing was added to it.
    expect(Object.keys(h.binding()!).sort()).toEqual(["owner_pid", "owner_session", "project_dir", "room_id", "updated_at"]);

    const withSession = setup({ session: "claude-session" });
    expect(existsSync(harnessPidPath(withSession.home, withSession.project))).toBe(false);
    const noParent = setup({ harnessPid: 1 }); // reparented to init: no usable harness pid
    expect(existsSync(harnessPidPath(noParent.home, noParent.project))).toBe(false);
  });

  it("follows the binding's lifecycle: replaced on takeover, removed on adopt and on removal", () => {
    const h = setup();
    const side = harnessPidPath(h.home, h.project);
    // A new server takes over the dead owner's binding and records its own parent.
    expect(claimProject(h.home, h.project, { pid: 5151, session: null, harnessPid: 777, now: Date.now() }, () => false)).toMatchObject({ kind: "owner", tookOver: true });
    expect(JSON.parse(readFileSync(side, "utf8"))).toEqual({ owner_pid: 5151, harness_pid: 777 });
    expect(adoptOwnerSession(h.home, h.project, ROOM, 5151, "learned")).toBe(true);
    expect(existsSync(side)).toBe(false);
    bindProject(h.home, h.project, ROOM, { pid: 5151, session: null, harnessPid: 777, now: Date.now() }, () => true);
    expect(existsSync(side)).toBe(true);
    removeBindingFor(h.home, ROOM);
    expect(existsSync(side)).toBe(false);
  });

  it("a sidecar left by an earlier owner (an older client took the binding over) is ignored", () => {
    const h = setup();
    writeFileSync(harnessPidPath(h.home, h.project), JSON.stringify({ owner_pid: 9999, harness_pid: HARNESS_PID }));
    expect(readHarnessPid(h.home, h.project, h.binding()!)).toBeNull();
    expect(h.run("gemini-session", { ppid: HARNESS_PID })).toBeNull();
    writeFileSync(harnessPidPath(h.home, h.project), "{torn");
    expect(h.run("gemini-session", { ppid: HARNESS_PID })).toBeNull();
  });

  it("a hook whose parent is the harness acts, records its session, and later hooks match by session id", () => {
    const h = setup();
    const out = h.run("gemini-session", { ppid: HARNESS_PID });
    expect(out?.hookSpecificOutput?.additionalContext).toContain("hello from Nika");
    expect(h.binding()?.owner_session).toBe("gemini-session");
    expect(existsSync(harnessPidPath(h.home, h.project))).toBe(false);
    // Now another process's hook with the same session id passes, and other sessions don't.
    appendInbox(h.home, ROOM, { source: "local", id: "notice-1", event: "peer_joined", text: "Nika (codex) joined the room.", received_at: Date.now() });
    expect(h.run("other-session", { ppid: HARNESS_PID })).toBeNull();
    expect(h.run("gemini-session", { ppid: 1234 })?.hookSpecificOutput?.additionalContext).toContain("joined the room");
    expect(h.psCalls()).toBe(0);
  });

  it("PAIRWIRE_HOOK_PPID from run.sh matches too", () => {
    const h = setup();
    expect(h.run("s", { ppid: 1234, env: { PAIRWIRE_HOOK_PPID: String(HARNESS_PID) } })).not.toBeNull();
    expect(h.psCalls()).toBe(0);
  });

  it("a hook from another harness process does nothing and takes none of the owner's messages", () => {
    const h = setup();
    const table = parseProcessTable(["  1234  900", "   900  800", "   800    1"].join("\n"));
    expect(h.run("passive-session", { ppid: 1234, env: { PAIRWIRE_HOOK_PPID: "1234" }, table })).toBeNull();
    expect(h.psCalls()).toBe(1);
    expect(h.binding()?.owner_session).toBeNull();
    expect(readDelivered(h.home, ROOM).size).toBe(0);
    expect(h.run("passive-session", { ppid: 1234, env: { PAIRWIRE_HOOK_PPID: "31337x" } })).toBeNull();
  });

  it("on macOS and Linux, a harness up to 4 ancestors above the hook matches through ps", () => {
    const chain = (depth: number) => {
      // hook's parent 100 -> 101 -> ... ; the harness sits at `depth` levels.
      const lines = [];
      for (let i = 0; i < depth - 1; i++) lines.push(`${100 + i} ${i === depth - 2 ? HARNESS_PID : 101 + i}`);
      lines.push(`${HARNESS_PID} 1`);
      return parseProcessTable(lines.join("\n"));
    };
    expect(isHarnessProcess(HARNESS_PID, { env: {}, ppid: 100, platform: "darwin", processTable: () => chain(4) })).toBe(true);
    expect(isHarnessProcess(HARNESS_PID, { env: {}, ppid: 100, platform: "linux", processTable: () => chain(5) })).toBe(false);
    expect(isHarnessProcess(HARNESS_PID, { env: {}, ppid: 100, platform: "linux", processTable: () => null })).toBe(false);
    const looped = parseProcessTable("100 100");
    expect(isHarnessProcess(HARNESS_PID, { env: {}, ppid: 100, platform: "linux", processTable: () => looped })).toBe(false);
    const h = setup();
    expect(h.run("nested", { ppid: 100, table: chain(3) })).not.toBeNull();
    expect(h.binding()?.owner_session).toBe("nested");
  });

  it("on Windows only the direct comparison counts: ps is never run", () => {
    const h = setup();
    const table = parseProcessTable(`1234 ${HARNESS_PID}`);
    expect(h.run("win-session", { ppid: 1234, platform: "win32", table })).toBeNull();
    expect(h.psCalls()).toBe(0);
    expect(h.run("win-session", { ppid: HARNESS_PID, platform: "win32" })).not.toBeNull();
    expect(h.psCalls()).toBe(0);
  });

  it("a hook input without a session id may act on a match and records nothing", () => {
    const h = setup();
    expect(h.run(undefined, { ppid: HARNESS_PID })).not.toBeNull();
    expect(h.binding()?.owner_session).toBeNull();
  });
});
