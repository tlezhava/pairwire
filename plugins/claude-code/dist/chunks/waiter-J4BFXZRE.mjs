import { createRequire as __pwCreateRequire } from "node:module";
const require = __pwCreateRequire(import.meta.url);
import {
  ctlCall,
  ctlTarget
} from "./chunk-RGL4DM7Z.mjs";
import "./chunk-67VZJV77.mjs";
import {
  hookErrorLogger,
  isOpen,
  isProcessAlive,
  loadConfig,
  pushes,
  readBinding,
  readState,
  resolveProjectDir,
  sessionOwnsBinding
} from "./chunk-4NNITFK4.mjs";
import "./chunk-GVGSGJLD.mjs";
import "./chunk-7VVD7K5U.mjs";
import "./chunk-KARZWXGF.mjs";

// packages/client/src/waiter.ts
function locate(stdin, o, forWaiting) {
  let input = {};
  try {
    input = JSON.parse(stdin);
  } catch {
    return null;
  }
  const binding = readBinding(o.home, resolveProjectDir(o.env, input.cwd ?? o.cwd));
  if (!sessionOwnsBinding(binding, input.session_id)) return null;
  if (!isProcessAlive(binding.owner_pid)) return null;
  const state = readState(o.home, binding.room_id);
  if (!state || !isOpen(state)) return null;
  if (forWaiting) {
    const { config } = loadConfig(o.home, o.env);
    if (!pushes(config.delivery) || !config.autoContinue) return null;
  }
  return { target: ctlTarget(o.home, binding.room_id, state.ctl_path), session: input.session_id };
}
async function runStopWait(stdin, o) {
  let where;
  try {
    where = locate(stdin, o, true);
  } catch (e) {
    hookErrorLogger(o.home).error("hook_failed", e, { hook: "stop-wait" });
    return 0;
  }
  if (!where) return 0;
  let line;
  try {
    line = await ctlCall(where.target, { op: "wait", session: where.session });
  } catch {
    return 0;
  }
  try {
    const frame = JSON.parse(line ?? "");
    if (frame.t === "wake" && typeof frame.text === "string" && frame.text !== "") {
      o.stderr.write(frame.text.endsWith("\n") ? frame.text : `${frame.text}
`);
      return 2;
    }
  } catch {
  }
  return 0;
}
async function cancelWaiter(stdin, o, connectTimeoutMs = 50) {
  try {
    const where = locate(stdin, o, false);
    if (!where) return;
    await ctlCall(where.target, { op: "wait_cancel", session: where.session }, { connectTimeoutMs, deadlineMs: 4 * connectTimeoutMs, noReply: true });
  } catch {
  }
}
export {
  cancelWaiter,
  runStopWait
};
