import { createRequire as __pwCreateRequire } from "node:module";
const require = __pwCreateRequire(import.meta.url);
import {
  appendTranscript,
  noticeLine,
  transcriptTail
} from "./chunk-G6D7GQZL.mjs";
import {
  dropHeld,
  hiddenBodies,
  releaseHeld,
  renderItemsFor
} from "./chunk-BM7N4KKH.mjs";
import {
  assertStatePrivate
} from "./chunk-OMHNOFXD.mjs";
import {
  CTL_PROOF_FAILED_TEXT,
  CtlProofError,
  CtlUnreachableError,
  ctlCall,
  ctlTarget
} from "./chunk-Q3M3SKV6.mjs";
import {
  CTL_MAX_REQUEST
} from "./chunk-WJTGR6M6.mjs";
import {
  holdMode,
  isOpen,
  isProcessAlive,
  readBinding,
  readState,
  resolveProjectDir,
  updateState
} from "./chunk-V6BBUVLD.mjs";
import {
  pairwireHome
} from "./chunk-GVGSGJLD.mjs";
import {
  CODEX_CTL,
  acceptHint,
  displayName,
  renderForHook,
  renderItems,
  renderTranscript
} from "./chunk-7VVD7K5U.mjs";
import "./chunk-KARZWXGF.mjs";

// packages/client/src/ctl.ts
var DEFAULT_LOG_ENTRIES = 30;
var MAX_LOG_ENTRIES = 500;
async function ctlRequest(target, request, timeoutMs = 15e3) {
  const line = await ctlCall(target, request, { replyTimeoutMs: timeoutMs });
  try {
    const reply = JSON.parse(line ?? "");
    return { ok: reply.ok === true, text: String(reply.text) };
  } catch {
    throw new Error("no reply");
  }
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
  const { released, result } = releaseHeld(home, roomId, (held, ledger) => {
    const items = renderItemsFor(home, roomId, held, { hold: true, now, ledger });
    if (terminal) return { ids: [], result: renderItems(items) };
    const r = renderForHook(items);
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
  const ask = async (request) => {
    if (!isProcessAlive(binding.owner_pid)) throw new CtlUnreachableError("owner not running");
    return ctlRequest(ctlTarget(home, roomId, state.ctl_path), request);
  };
  switch (op) {
    case "log": {
      const given = arg ?? (io.stdin.isTTY ? "" : await readAll(io.stdin));
      const n = Math.min(MAX_LOG_ENTRIES, Math.max(1, Number.parseInt(given.trim(), 10) || DEFAULT_LOG_ENTRIES));
      const hidden = /* @__PURE__ */ new Map();
      const holding = holdMode(home, io.env);
      for (const [id, why] of hiddenBodies(home, roomId, true)) hidden.set(id, why === "held" && !holding ? "pending" : why);
      print(renderTranscript(transcriptTail(home, roomId, n, hidden, acceptHint(harness))));
      return 0;
    }
    case "accept": {
      const given = arg ?? (io.stdin.isTTY ? "" : await readAll(io.stdin));
      print(accept(home, roomId, harness, given.trim().toLowerCase(), io));
      return 0;
    }
    case "continue": {
      try {
        print((await ask({ op: "continue" })).text);
      } catch (e) {
        if (e instanceof CtlProofError) {
          print(CTL_PROOF_FAILED_TEXT);
          return 0;
        }
        if (!(e instanceof CtlUnreachableError)) {
          print("pairwire: your agent session did not answer, so the hop budget was not reset; try again.");
          return 0;
        }
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
        print((await ask({ op: "say", text })).text);
      } catch (e) {
        if (e instanceof CtlProofError) print(CTL_PROOF_FAILED_TEXT);
        else print("pairwire: no running agent session owns this room, so nothing was sent. Start your agent session in this project first.");
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
