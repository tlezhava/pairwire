// D3 idle wake (04 §6, S3): `pairwire hook stop-wait` runs as an async, asyncRewake Stop hook.
// It waits on ctl.sock until the MCP server hands it new items, then prints them on stderr and
// exits 2, which makes Claude Code start a turn in the idle session. Every other outcome exits 0
// quietly. It has no timer of its own: a waiter that exits 0 is not replaced until a turn ends.
import { isProcessAlive, readBinding, sessionOwnsBinding } from "./binding.js";
import { loadConfig, pushes } from "./config.js";
import { ctlCall, ctlTarget, type CtlTarget } from "./ctl-client.js";
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
  target: CtlTarget;
  session: string;
}

/**
 * The owning session's control socket, or null when this session must not wait. Null too when
 * the binding's owner pid is dead: whatever listens on `ctl_path` then is not our server (a
 * squatted stale pipe or socket name, 04 §8), so nothing connects to it. Throws when the
 * room's ctl.key can't be read (the caller gives up: INV-10).
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
    if (!pushes(config.delivery) || !config.autoContinue) return null;
  }
  return { target: ctlTarget(o.home, binding!.room_id, state.ctl_path), session: input.session_id! };
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
  let line: string | null;
  try {
    // No reply timeout: the waiter waits until it is woken, superseded or cancelled (04 §6).
    // A listener that can't prove itself gets only the hello and never wakes the session.
    line = await ctlCall(where.target, { op: "wait", session: where.session });
  } catch {
    return 0; // no server, or no proof (logged as ctl_proof_failed)
  }
  try {
    const frame = JSON.parse(line ?? "") as WaitFrame;
    if (frame.t === "wake" && typeof frame.text === "string" && frame.text !== "") {
      o.stderr.write(frame.text.endsWith("\n") ? frame.text : `${frame.text}\n`);
      return 2;
    }
  } catch {
    // malformed or none: exit 0
  }
  return 0;
}

/**
 * Tells the MCP server the session is busy, ending a pending waiter (04 §6 step 5). Never
 * throws. 50 ms to connect, then 200 ms for the proof and the request; on any failure it gives
 * up silently.
 */
export async function cancelWaiter(stdin: string, o: Pick<WaiterOptions, "home" | "env" | "cwd">, connectTimeoutMs = 50): Promise<void> {
  try {
    const where = locate(stdin, o, false);
    if (!where) return;
    await ctlCall(where.target, { op: "wait_cancel", session: where.session }, { connectTimeoutMs, deadlineMs: 4 * connectTimeoutMs, noReply: true });
  } catch {
    // fire-and-forget
  }
}
