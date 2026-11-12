// Several memberships in one folder (04 §3, §8, ADR-036): each harness's hooks and the human's
// `ctl` act for their own membership only, never another session's.
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { bindProject } from "../../src/binding.js";
import { runCtl } from "../../src/ctl.js";
import { runHook } from "../../src/hooks.js";
import { appendInbox, readDelivered } from "../../src/room-files.js";
import { createRoom, updateState } from "../../src/state.js";
import { appendTranscript, noticeLine } from "../../src/transcript.js";
import { tempDir } from "../state/helpers.js";

const CLAUDE_ROOM = "abcdefghijklmnopqrstuvwxyz";
const CODEX_ROOM = "zyxwvutsrqponmlkjihgfedcba";

function setup() {
  const home = join(tempDir(), ".pairwire");
  const project = tempDir();
  const now = Date.now();
  for (const [room, peer] of [
    [CLAUDE_ROOM, "Nika"],
    [CODEX_ROOM, "Ana"],
  ] as const) {
    createRoom(home, { roomId: room, secret: new Uint8Array(32), relay: null, name: "Tazo", now }, {});
    updateState(home, room, (s) => ({ ...s, status: "active", peer: { name: peer, harness: "claude-code", instance: "b".repeat(26) } }));
    appendTranscript(home, room, noticeLine(`${peer} joined the room.`, now));
  }
  bindProject(home, project, CLAUDE_ROOM, { pid: process.pid, session: "claude-session", harness: "claude-code", now });
  // A Codex server records the session it learns from _meta (04 §10).
  bindProject(home, project, CODEX_ROOM, { pid: process.ppid, session: "codex-session", harness: "codex", now: now + 1 });
  let n = 0;
  const message = (room: string, body: string) => {
    const id = `01JPW00000000000000000${String(++n).padStart(4, "0")}`;
    appendInbox(home, room, {
      source: "peer",
      id,
      from: "x",
      harness: "claude-code",
      received_at: now,
      envelope: { v: 1, id, seq: n, ts: new Date(now).toISOString(), author: "agent", kind: "chat", reply_to: null, body, acks: null },
    });
  };
  const hook = (session: string) => {
    const input = { session_id: session, cwd: project, hook_event_name: "PostToolUse", tool_name: "Bash", permission_mode: "default" };
    const out = runHook("post-tool-use", JSON.stringify(input), { home, env: {}, cwd: "/" });
    return out ? ((JSON.parse(out) as { hookSpecificOutput?: { additionalContext?: string } }).hookSpecificOutput?.additionalContext ?? "") : null;
  };
  const ctl = async (args: string[], env: NodeJS.ProcessEnv = {}) => {
    let out = "";
    const stdout = new Writable({
      write(chunk, _enc, cb) {
        out += String(chunk);
        cb();
      },
    });
    expect(await runCtl(args, { stdin: Readable.from([""]), stdout, env: { PAIRWIRE_HOME: home, ...env }, cwd: project })).toBe(0);
    return out;
  };
  return { home, project, message, hook, ctl };
}

describe("several memberships in one folder (ADR-036)", () => {
  it("each session's hooks deliver its own membership's messages and none of the other's", () => {
    const h = setup();
    h.message(CLAUDE_ROOM, "for claude CLAUDEMSG");
    h.message(CODEX_ROOM, "for codex CODEXMSG");
    const claude = h.hook("claude-session");
    expect(claude).toContain("CLAUDEMSG");
    expect(claude).not.toContain("CODEXMSG");
    const codex = h.hook("codex-session");
    expect(codex).toContain("CODEXMSG");
    expect(codex).not.toContain("CLAUDEMSG");
    expect(h.hook("someone-else")).toBeNull();
    expect(readDelivered(h.home, CLAUDE_ROOM).size).toBe(1);
    expect(readDelivered(h.home, CODEX_ROOM).size).toBe(1);
  });

  it("ctl picks the calling Claude Code session's membership, else --harness, and refuses to guess", async () => {
    const h = setup();
    const ambiguous = await h.ctl(["log"]);
    expect(ambiguous).toBe("pairwire: this folder has more than one pairwire room (claude-code, codex). Run ctl --harness <name> … to pick one.\n");
    expect(await h.ctl(["log"], { CLAUDE_CODE_SESSION_ID: "claude-session" })).toContain("Nika joined the room.");
    expect(await h.ctl(["--harness", "codex", "log"])).toContain("Ana joined the room.");
    expect(await h.ctl(["--harness", "claude-code", "log"])).toContain("Nika joined the room.");
    expect(await h.ctl(["--harness", "gemini-cli", "log"])).toBe("pairwire: there is no pairwire room in this project.\n");
  });
});
