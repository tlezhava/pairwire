// A Cursor hook finds its room by workspace folder, not by process (04 §10, ADR-034): Cursor
// starts MCP servers and hooks from different helper processes (S11, Windows), and a folder is
// open in at most one Cursor window, whose one server serves all its chats.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bindProject, readBinding } from "../../src/binding.js";
import { runHook } from "../../src/hooks.js";
import { cursorMissPath } from "../../src/paths.js";
import { appendInbox, readDelivered } from "../../src/room-files.js";
import { createRoom, updateState } from "../../src/state.js";
import { tempDir } from "../state/helpers.js";

const ROOM = "abcdefghijklmnopqrstuvwxyz";
const SERVER_PID = 4242;
const MCP_HOST_PID = 5676; // the Cursor helper that started the server; never a hook's ancestor

function setup(ownerHarness: string | null = "cursor") {
  const home = join(tempDir(), ".pairwire");
  const project = tempDir();
  createRoom(home, { roomId: ROOM, secret: new Uint8Array(32), relay: null, name: "Tazo", now: Date.now() }, {});
  updateState(home, ROOM, (s) => ({ ...s, status: "active", peer: { name: "Nika", harness: "claude-code", instance: "b".repeat(26) } }));
  bindProject(home, project, ROOM, { pid: SERVER_PID, session: null, ...(ownerHarness !== null ? { harness: ownerHarness } : {}), harnessPid: MCP_HOST_PID, now: Date.now() }, () => false);
  let n = 0;
  const message = (body: string) => {
    const id = `01JPW00000000000000000000${++n}`;
    appendInbox(home, ROOM, {
      source: "peer",
      id,
      from: "Nika",
      harness: "claude-code",
      received_at: Date.now(),
      envelope: { v: 1, id, seq: n, ts: new Date().toISOString(), author: "agent", kind: "chat", reply_to: null, body, acks: null },
    });
  };
  const run = (event: "post-tool-use" | "stop", conversation: string, opts: { root?: string; dialect?: string; env?: NodeJS.ProcessEnv } = {}) => {
    const input = { conversation_id: conversation, hook_event_name: event, workspace_roots: [opts.root ?? project], session_id: conversation, cwd: opts.root ?? project };
    const out = runHook(event, JSON.stringify(input), {
      home,
      env: { PAIRWIRE_HOOK_DIALECT: opts.dialect ?? "cursor", PAIRWIRE_HOOK_PPID: "1", ...opts.env },
      cwd: join(tempDir(), ".cursor"),
      ppid: 9999,
      platform: "win32",
      processTable: () => {
        throw new Error("a Cursor hook never lists processes");
      },
    });
    return out ? (JSON.parse(out) as { additional_context?: string; followup_message?: string; hookSpecificOutput?: unknown }) : null;
  };
  return { home, project, message, run, binding: () => readBinding(home, project) };
}

describe("Cursor hooks find their room by workspace folder (ADR-034)", () => {
  it("REQ-X-4: a hook in the room's workspace delivers with no process match, and records no owner_session", () => {
    const h = setup();
    h.message("hello from Nika");
    expect(h.run("post-tool-use", "chat-1")?.additional_context).toContain("hello from Nika");
    expect(h.binding()?.owner_session).toBeNull();
    // Another chat in the same window shares the window's server, so it is served too.
    h.message("second message");
    expect(h.run("post-tool-use", "chat-2")?.additional_context).toContain("second message");
    expect(readDelivered(h.home, ROOM).size).toBe(2);
  });

  it("REQ-X-4: stop asks the agent to read its inbox, with the fixed wake text", () => {
    const h = setup();
    h.message("waiting");
    expect(h.run("stop", "chat-1")?.followup_message).toMatch(/call the pairwire inbox tool/);
    expect(readDelivered(h.home, ROOM).size).toBe(0);
  });

  it("a room owned by another harness in the same folder is not Cursor's to deliver", () => {
    for (const owner of ["claude-code", null]) {
      const h = setup(owner);
      h.message("for the Claude Code session");
      expect(h.run("post-tool-use", "chat-1")).toBeNull();
      expect(readDelivered(h.home, ROOM).size).toBe(0);
    }
  });

  it("other dialects keep the process rule: a Gemini hook with an unrelated parent does nothing", () => {
    const h = setup("gemini");
    h.message("hello");
    expect(h.run("post-tool-use", "s", { dialect: "gemini" })).toBeNull();
  });

  it("a Cursor hook in another folder does nothing, and records the folder it looked in", () => {
    const h = setup();
    h.message("hello");
    const other = tempDir();
    expect(h.run("post-tool-use", "chat-1", { root: other })).toBeNull();
    expect(readDelivered(h.home, ROOM).size).toBe(0);
    const miss = JSON.parse(readFileSync(cursorMissPath(h.home), "utf8")) as { project_dir: string; at: number };
    expect(miss.project_dir).toBe(realpathSync(other));
    // A hit leaves nothing new behind.
    const fresh = setup();
    fresh.message("hi");
    expect(fresh.run("post-tool-use", "chat-1")).not.toBeNull();
    expect(existsSync(cursorMissPath(fresh.home))).toBe(false);
  });
});
