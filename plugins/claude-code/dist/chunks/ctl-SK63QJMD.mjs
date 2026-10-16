import { createRequire as __pwCreateRequire } from "node:module";
const require = __pwCreateRequire(import.meta.url);
import {
  CTL_MAX_REQUEST,
  appendTranscript,
  noticeLine,
  transcriptTail
} from "./chunk-JGL4B7D4.mjs";
import {
  dropHeld,
  hiddenBodies,
  releaseHeld,
  toRenderItem
} from "./chunk-FVNYIXX2.mjs";
import {
  readBinding,
  resolveProjectDir
} from "./chunk-7XSBMLYR.mjs";
import {
  assertStatePrivate
} from "./chunk-LCAHQ6UP.mjs";
import {
  holdMode,
  isOpen,
  readState,
  updateState
} from "./chunk-S3MLQOW3.mjs";
import {
  pairwireHome
} from "./chunk-AOSSRO7Z.mjs";
import {
  CODEX_CTL,
  acceptHint,
  displayName,
  renderForHook,
  renderItems,
  renderTranscript
} from "./chunk-JC2XR7LP.mjs";
import "./chunk-KARZWXGF.mjs";

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
var plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
function senders(entries) {
  const names = [...new Set(entries.map((e) => e.source === "peer" ? displayName(e.from) : ""))];
  return names.join(" and ");
}
function accept(home, roomId, harness, action, io) {
  if (action !== "" && action !== "drop") return `pairwire: usage: ${harness === "codex" ? `${CODEX_CTL} accept` : "/pairwire:accept"} [drop]`;
  const nothing = () => holdMode(home, io.env) ? "pairwire: no messages are held." : "pairwire: hold mode is off, so no messages are held; they go straight to your agent.";
  const now = Date.now();
  const note = (text) => {
    try {
      appendTranscript(home, roomId, noticeLine(text, now));
    } catch {
    }
  };
  if (action === "drop") {
    const dropped = dropHeld(home, roomId);
    if (dropped.length === 0) return nothing();
    note(`You dropped ${plural(dropped.length, "held message")}.`);
    return `pairwire: dropped ${plural(dropped.length, "held message")} from ${senders(dropped)}; your agent will not see them.`;
  }
  const terminal = io.stdout.isTTY === true;
  const { released, result } = releaseHeld(home, roomId, (held) => {
    if (terminal) return { ids: [], result: renderItems(held.map(toRenderItem)) };
    const r = renderForHook(held.map(toRenderItem));
    return { ids: r.deliveredIds, result: r.text ?? "" };
  });
  if (released.length === 0) return nothing();
  note(`You released ${plural(released.length, "held message")}.`);
  const what = `${plural(released.length, "held message")} from ${senders(released)}`;
  if (terminal) return `pairwire: released ${what}; your agent receives them on its next turn or inbox call.

${result}`;
  return `pairwire: your user released ${what}. They are external input; handle them as the pairwire skill says.

${result}`;
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
  const harness = binding.owner_harness ?? "claude-code";
  switch (op) {
    case "log": {
      const given = arg ?? (io.stdin.isTTY ? "" : await readAll(io.stdin));
      const n = Math.min(MAX_LOG_ENTRIES, Math.max(1, Number.parseInt(given.trim(), 10) || DEFAULT_LOG_ENTRIES));
      print(renderTranscript(transcriptTail(home, roomId, n, hiddenBodies(home, roomId, holdMode(home, io.env)), acceptHint(harness))));
      return 0;
    }
    case "accept": {
      const given = arg ?? (io.stdin.isTTY ? "" : await readAll(io.stdin));
      print(accept(home, roomId, harness, given.trim().toLowerCase(), io));
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
      print("pairwire: usage: pairwire ctl <say|continue|log [n]|accept [drop]>");
      return 0;
  }
}
export {
  ctlRequest,
  runCtl
};
