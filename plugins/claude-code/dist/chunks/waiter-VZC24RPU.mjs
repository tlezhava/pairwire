import { createRequire as __pwCreateRequire } from "node:module";
const require = __pwCreateRequire(import.meta.url);
import {
  hookErrorLogger,
  isProcessAlive,
  readBinding,
  resolveProjectDir,
  sessionOwnsBinding
} from "./chunk-ICN7LAQE.mjs";
import {
  isOpen,
  loadConfig,
  readState
} from "./chunk-SKIYUC7T.mjs";
import "./chunk-GVGSGJLD.mjs";
import "./chunk-J2VZYBRA.mjs";
import "./chunk-KARZWXGF.mjs";

// packages/client/src/waiter.ts
import { createConnection } from "node:net";
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
    if (config.delivery !== "auto" || !config.autoContinue) return null;
  }
  return { ctlPath: state.ctl_path, session: input.session_id };
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
  return new Promise((resolve) => {
    const socket = createConnection(where.ctlPath);
    let buf = "";
    let code = 0;
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(JSON.stringify({ op: "wait", session: where.session }) + "\n"));
    socket.on("data", (d) => {
      buf += d;
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      try {
        const frame = JSON.parse(buf.slice(0, nl));
        if (frame.t === "wake" && typeof frame.text === "string" && frame.text !== "") {
          o.stderr.write(frame.text.endsWith("\n") ? frame.text : `${frame.text}
`);
          code = 2;
        }
      } catch {
      }
      socket.destroy();
    });
    socket.on("error", () => {
    });
    socket.on("close", () => resolve(code));
  });
}
async function cancelWaiter(stdin, o, connectTimeoutMs = 50) {
  let where;
  try {
    where = locate(stdin, o, false);
  } catch {
    return;
  }
  if (!where) return;
  const { ctlPath, session } = where;
  await new Promise((resolve) => {
    const socket = createConnection(ctlPath);
    let timer = setTimeout(() => socket.destroy(), connectTimeoutMs);
    socket.on("connect", () => {
      clearTimeout(timer);
      timer = setTimeout(() => socket.destroy(), 4 * connectTimeoutMs);
      socket.end(JSON.stringify({ op: "wait_cancel", session }) + "\n");
    });
    socket.on("error", () => {
    });
    socket.on("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
export {
  cancelWaiter,
  runStopWait
};
