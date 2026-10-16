// D3 idle wake (04 §6, S3): `pairwire hook stop-wait` runs as an async, asyncRewake Stop hook.
// It waits on ctl.sock until the MCP server hands it new items, then prints them on stderr and
// exits 2, which makes Claude Code start a turn in the idle session. Every other outcome exits 0
// quietly. It has no timer of its own: a waiter that exits 0 is not replaced until a turn ends.
import { createConnection } from "node:net";
import { isProcessAlive, readBinding, sessionOwnsBinding } from "./binding.js";
import { loadConfig } from "./config.js";
import type { WaitFrame } from "./ctl-server.js";
import { hookErrorLogger } from "./log.js";
import { resolveProjectDir } from "./project.js";
import { isOpen, readState } from "./state.js";

export interface WaiterOptions {
  home: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
  stderr: { write(text: string): unknown };
}

interface Located {
  ctlPath: string;
  session: string;
}

/**
 * The owning session's control socket, or null when this session must not wait. Null too when
 * the binding's owner pid is dead: whatever listens on `ctl_path` then is not our server (a
 * squatted stale pipe or socket name, 04 §8), so nothing connects to it.
 */
function locate(stdin: string, o: Pick<WaiterOptions, "home" | "env" | "cwd">, forWaiting: boolean): Located | null {
  let input: { session_id?: string; cwd?: string } = {};
  try {
    input = JSON.parse(stdin) as typeof input;
  } catch {
    return null;
  }
  const binding = readBinding(o.home, resolveProjectDir(o.env, input.cwd ?? o.cwd));
  if (!sessionOwnsBinding(binding, input.session_id)) return null;
  if (!isProcessAlive(binding!.owner_pid)) return null;
  const state = readState(o.home, binding!.room_id);
  if (!state || !isOpen(state)) return null;
  if (forWaiting) {
    const { config } = loadConfig(o.home, o.env);
    if (config.delivery !== "auto" || !config.autoContinue) return null;
  }
  return { ctlPath: state.ctl_path, session: input.session_id! };
}

/** Exit code: 2 after a wake (stderr carries the messages), else 0. */
export async function runStopWait(stdin: string, o: WaiterOptions): Promise<number> {
  let where: Located | null;
  try {
    where = locate(stdin, o, true);
  } catch (e) {
    hookErrorLogger(o.home).error("hook_failed", e, { hook: "stop-wait" });
    return 0;
  }
  if (!where) return 0;
  return new Promise<number>((resolve) => {
    const socket = createConnection(where.ctlPath);
    let buf = "";
    let code = 0;
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(JSON.stringify({ op: "wait", session: where.session }) + "\n"));
    socket.on("data", (d: string) => {
      buf += d;
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      try {
        const frame = JSON.parse(buf.slice(0, nl)) as WaitFrame;
        if (frame.t === "wake" && typeof frame.text === "string" && frame.text !== "") {
          o.stderr.write(frame.text.endsWith("\n") ? frame.text : `${frame.text}\n`);
          code = 2;
        }
      } catch {
        // malformed: exit 0
      }
      socket.destroy();
    });
    socket.on("error", () => {}); // no server: exit 0 on close
    socket.on("close", () => resolve(code));
  });
}

/** Tells the MCP server the session is busy, ending a pending waiter (04 §6 step 5). Never throws. */
export async function cancelWaiter(stdin: string, o: Pick<WaiterOptions, "home" | "env" | "cwd">, connectTimeoutMs = 50): Promise<void> {
  let where: Located | null;
  try {
    where = locate(stdin, o, false);
  } catch {
    return;
  }
  if (!where) return;
  const { ctlPath, session } = where;
  await new Promise<void>((resolve) => {
    const socket = createConnection(ctlPath);
    let timer = setTimeout(() => socket.destroy(), connectTimeoutMs);
    socket.on("connect", () => {
      clearTimeout(timer);
      timer = setTimeout(() => socket.destroy(), 4 * connectTimeoutMs);
      socket.end(JSON.stringify({ op: "wait_cancel", session }) + "\n");
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
