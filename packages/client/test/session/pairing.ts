// Two ClientSessions paired through a real relay-node (shared by session and transcript tests).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach } from "vitest";
import { createLogger } from "../../src/log.js";
import { ClientSession, type SessionOptions } from "../../src/session.js";
import { listRooms } from "../../src/state.js";
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
afterEach(() => {
  for (const s of sessions.splice(0)) s.shutdown();
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
