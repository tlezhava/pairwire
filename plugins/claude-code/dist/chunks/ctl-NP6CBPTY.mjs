import { createRequire as __pwCreateRequire } from "node:module";
const require = __pwCreateRequire(import.meta.url);
import {
  CTL_MAX_REQUEST,
  transcriptTail
} from "./chunk-EQVX44FC.mjs";
import {
  readBinding,
  resolveProjectDir
} from "./chunk-S7BK5NUX.mjs";
import {
  assertStatePrivate
} from "./chunk-RLWKG6QV.mjs";
import {
  isOpen,
  readState,
  renderTranscript,
  updateState
} from "./chunk-H4ULF7HQ.mjs";
import {
  pairwireHome
} from "./chunk-A6UKVX6D.mjs";

// packages/client/src/ctl.ts
import { createConnection } from "node:net";
var DEFAULT_LOG_ENTRIES = 30;
var MAX_LOG_ENTRIES = 500;
function ctlRequest(path, request, timeoutMs = 15e3) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    let buf = "";
    socket.setEncoding("utf8");
    socket.setTimeout(timeoutMs, () => socket.destroy(new Error("timeout")));
    socket.on("connect", () => socket.write(JSON.stringify(request) + "\n"));
    socket.on("data", (d) => buf += d);
    socket.on("error", reject);
    socket.on("close", () => {
      try {
        const reply = JSON.parse(buf.split("\n")[0] ?? "");
        resolve({ ok: reply.ok === true, text: String(reply.text) });
      } catch {
        reject(new Error("no reply"));
      }
    });
  });
}
async function readAll(stream) {
  let text = "";
  for await (const chunk of stream) {
    text += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    if (text.length > CTL_MAX_REQUEST) break;
  }
  return text;
}
async function runCtl(args, io) {
  const print = (text) => io.stdout.write(text.endsWith("\n") ? text : `${text}
`);
  const home = pairwireHome(io.env);
  try {
    assertStatePrivate(home);
  } catch (e) {
    print(`pairwire: ${e.message}`);
    return 0;
  }
  const [op, arg] = args;
  const binding = readBinding(home, resolveProjectDir(io.env, io.cwd));
  const state = binding ? readState(home, binding.room_id) : null;
  if (!binding || !state) {
    print("pairwire: there is no pairwire room in this project.");
    return 0;
  }
  const roomId = binding.room_id;
  switch (op) {
    case "log": {
      const given = arg ?? (io.stdin.isTTY ? "" : await readAll(io.stdin));
      const n = Math.min(MAX_LOG_ENTRIES, Math.max(1, Number.parseInt(given.trim(), 10) || DEFAULT_LOG_ENTRIES));
      print(renderTranscript(transcriptTail(home, roomId, n)));
      return 0;
    }
    case "continue": {
      try {
        print((await ctlRequest(state.ctl_path, { op: "continue" })).text);
      } catch {
        if (isOpen(state)) updateState(home, roomId, (s) => ({ ...s, hop_count: 0 }));
        print("pairwire: hop budget reset; your agent may send again.");
      }
      return 0;
    }
    case "say": {
      let text = await readAll(io.stdin);
      if (text.length > CTL_MAX_REQUEST) {
        print("pairwire: that message is too long.");
        return 0;
      }
      if (text.endsWith("\n")) text = text.slice(0, -1);
      if (text.trim() === "") {
        print("pairwire: nothing to send. Usage: /pairwire:say <message>");
        return 0;
      }
      try {
        print((await ctlRequest(state.ctl_path, { op: "say", text })).text);
      } catch {
        print("pairwire: no running agent session owns this room, so nothing was sent. Start your agent session in this project first.");
      }
      return 0;
    }
    default:
      print("pairwire: usage: pairwire ctl <say|continue|log [n]>");
      return 0;
  }
}
export {
  ctlRequest,
  runCtl
};
