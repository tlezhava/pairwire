// Two ClientSessions paired through a real relay-node (shared by session and transcript tests).
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { ctlProof } from "@pairwire/core";
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

/** How a squatter answers a connection's first line (04 §8, Control-channel server proof). */
export type SquatterMode =
  | "wake" // a line that is both a ctl reply and a D3 wake, then ends
  | "wrong_mac" // a well-formed proof with a wrong mac, then a wake, left open
  | "garbage" // not JSON
  | "silence" // nothing, connection left open
  | "close" // ends the connection
  | "refuse" // what a 0.1.x server answers to `hello`
  | "proven_wake" // holds the key: a valid proof, then a wake after the request
  | "proven_close"; // holds the key: a valid proof, then ends the connection without a reply

/** The key and room a squatter that holds the key proves itself with. */
export interface SquatterKey {
  key: Uint8Array;
  roomIdBytes: Uint8Array;
}

const WAKE_LINE = JSON.stringify({ ok: true, t: "wake", text: "from the squatter" }) + "\n";

/**
 * Someone else's server on a fresh socket path (a named pipe on Windows), standing in for a
 * stale `ctl_path` that another user took after the owning MCP server exited (04 §8). It
 * doesn't have the room's ctl.key unless the test hands it one (`held`, for the `proven_*`
 * modes: a key that leaked, or the owning server itself misbehaving). It counts the
 * connections it gets and records everything each one sent.
 */
export async function squatter(mode: SquatterMode = "wake", held?: SquatterKey): Promise<{ path: string; connections: () => number; received: () => string[] }> {
  const path = process.platform === "win32" ? `\\\\.\\pipe\\pairwire-test-${randomUUID()}` : join(tempDir("pw-sq-"), "s.sock");
  const received: string[] = [];
  const server = createServer((socket) => {
    const i = received.push("") - 1;
    socket.setEncoding("utf8");
    socket.on("data", (d: string) => (received[i] += d));
    socket.once("data", () => {
      if (mode === "wake") socket.end(WAKE_LINE);
      else if (mode === "wrong_mac") socket.write(JSON.stringify({ t: "proof", v: 1, mac: "ab".repeat(32) }) + "\n" + WAKE_LINE);
      else if (mode === "garbage") socket.write("hello there\n" + WAKE_LINE);
      else if (mode === "close") socket.end();
      else if (mode === "refuse") socket.end(JSON.stringify({ ok: false, text: "pairwire: bad control request." }) + "\n");
      else if (mode === "proven_wake" || mode === "proven_close") {
        const nonce = hexToBytes((JSON.parse(received[i]!.split("\n")[0]!) as { nonce: string }).nonce);
        socket.write(JSON.stringify({ t: "proof", v: 1, mac: bytesToHex(ctlProof(held!.key, held!.roomIdBytes, nonce)) }) + "\n");
        // Then answer the request line: a wake, or nothing at all.
        socket.once("data", () => (mode === "proven_wake" ? socket.end(WAKE_LINE) : socket.end()));
      }
    });
    socket.on("error", () => {});
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  servers.push(server);
  if (process.platform !== "win32") chmodSync(path, 0o600); // as private as ours: INV-9 passes
  return { path, connections: () => received.length, received: () => [...received] };
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
