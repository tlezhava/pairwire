// Two ClientSessions paired through a real relay-node (shared by session and transcript tests).
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { afterEach } from "vitest";
import { bindingPath, readBinding } from "../../src/binding.js";
import { createLogger } from "../../src/log.js";
import { ClientSession, type SessionOptions } from "../../src/session.js";
import { listRooms, updateState } from "../../src/state.js";
import { FAST, startRelay } from "../connection/harness.js";
import { tempDir } from "../state/helpers.js";

export const SHARE = /pw1_[a-z2-7]{52}@127\.0\.0\.1:\d+/;

export interface Side {
  session: ClientSession;
  home: string;
  project: string;
  opts: SessionOptions;
}

const sessions: ClientSession[] = [];
const servers: Server[] = [];
afterEach(() => {
  for (const s of sessions.splice(0)) s.shutdown();
  for (const s of servers.splice(0)) s.close();
});

export function side(port: number, name: string, extra: Partial<SessionOptions> & { home?: string; project?: string; config?: object } = {}): Side {
  const home = extra.home ?? join(tempDir(), ".pairwire");
  const project = extra.project ?? tempDir();
  if (extra.config) {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    writeFileSync(join(home, "config.json"), JSON.stringify(extra.config));
  }
  const opts: SessionOptions = {
    home,
    env: { PAIRWIRE_RELAY: `127.0.0.1:${port}`, PAIRWIRE_NAME: name, PAIRWIRE_HARNESS: "claude-code", CLAUDE_CODE_SESSION_ID: `sess-${name}` },
    cwd: project,
    log: createLogger({ sink: () => {} }),
    joinWaitMs: 5000,
    startWaitMs: 3000,
    tuning: FAST,
    ...extra,
  };
  const session = new ClientSession(opts);
  sessions.push(session);
  session.init();
  return { session, home, project, opts };
}

export async function paired(config?: object) {
  const { port } = await startRelay();
  const a = side(port, "Tazo", config ? { config } : {});
  const started = await a.session.start({});
  const share = started.text.match(SHARE)![0];
  const b = side(port, "Nika", config ? { config } : {});
  const joined = await b.session.join({ share });
  return { port, a, b, share, started, joined, roomOf };
}

export const roomOf = (s: Side) => listRooms(s.home)[0]!;

/** The pid of a process that has exited. */
export function deadPid(): number {
  return spawnSync(process.execPath, ["-e", ""]).pid!;
}

/**
 * Someone else's server on a fresh socket path (a named pipe on Windows), standing in for a
 * stale `ctl_path` that another user took after the owning MCP server exited (04 §8). It
 * answers every request with a line that is both a ctl reply and a D3 wake, and counts the
 * connections it gets.
 */
export async function squatter(): Promise<{ path: string; connections: () => number }> {
  const path = process.platform === "win32" ? `\\\\.\\pipe\\pairwire-test-${randomUUID()}` : join(tempDir("pw-sq-"), "s.sock");
  let connections = 0;
  const server = createServer((socket) => {
    connections++;
    socket.once("data", () => socket.end(JSON.stringify({ ok: true, t: "wake", text: "from the squatter" }) + "\n"));
    socket.on("error", () => {});
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  servers.push(server);
  if (process.platform !== "win32") chmodSync(path, 0o600); // as private as ours: INV-9 passes
  return { path, connections: () => connections };
}

/** Leaves `s`'s room as its MCP server would after exiting: `ctl_path` points at `ctlPath`, and the binding's owner is `ownerPid`. */
export function ownerExited(s: Side, ctlPath: string, ownerPid: number): void {
  s.session.shutdown();
  updateState(s.home, roomOf(s), (state) => ({ ...state, ctl_path: ctlPath }));
  setOwnerPid(s, ownerPid);
}

export function setOwnerPid(s: Side, ownerPid: number): void {
  writeFileSync(bindingPath(s.home, s.project), JSON.stringify({ ...readBinding(s.home, s.project)!, owner_pid: ownerPid }));
}
