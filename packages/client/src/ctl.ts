// `pairwire ctl <say|continue|log|accept>`: the human-side commands, run by slash commands
// through `!` (04 §8). Output lands in the prompt, so expected failures print `pairwire: …` and
// exit 0.
import { createConnection } from "node:net";
import type { Readable, Writable } from "node:stream";
import { displayName, renderForHook, renderItems, renderTranscript } from "@pairwire/core";
import { readBinding } from "./binding.js";
import { holdMode } from "./config.js";
import { CTL_MAX_REQUEST, type CtlReply, type CtlRequest } from "./ctl-server.js";
import { pairwireHome } from "./paths.js";
import { assertStatePrivate } from "./permissions.js";
import { resolveProjectDir } from "./project.js";
import { isOpen, readState, updateState } from "./state.js";
import { dropHeld, hiddenBodies, releaseHeld, toRenderItem, type InboxEntry } from "./room-files.js";
import { appendTranscript, noticeLine, transcriptTail } from "./transcript.js";

export interface CtlIo {
  stdin: Readable;
  stdout: Writable;
  env: NodeJS.ProcessEnv;
  cwd: string;
}

const DEFAULT_LOG_ENTRIES = 30;
const MAX_LOG_ENTRIES = 500;

/** Sends one request to the server listening on `path`. Rejects if nobody is listening. */
export function ctlRequest(path: string, request: CtlRequest, timeoutMs = 15_000): Promise<CtlReply> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    let buf = "";
    socket.setEncoding("utf8");
    socket.setTimeout(timeoutMs, () => socket.destroy(new Error("timeout")));
    socket.on("connect", () => socket.write(JSON.stringify(request) + "\n"));
    socket.on("data", (d: string) => (buf += d));
    socket.on("error", reject);
    socket.on("close", () => {
      try {
        const reply = JSON.parse(buf.split("\n")[0] ?? "") as CtlReply;
        resolve({ ok: reply.ok === true, text: String(reply.text) });
      } catch {
        reject(new Error("no reply"));
      }
    });
  });
}

async function readAll(stream: Readable): Promise<string> {
  let text = "";
  for await (const chunk of stream) {
    text += typeof chunk === "string" ? chunk : (chunk as Buffer).toString("utf8");
    if (text.length > CTL_MAX_REQUEST) break;
  }
  return text;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** "Nika", or "Nika and Eve" if the peer's name changed between messages. */
function senders(entries: readonly InboxEntry[]): string {
  const names = [...new Set(entries.map((e) => (e.source === "peer" ? displayName(e.from) : "")))];
  return names.join(" and ");
}

/**
 * /pairwire:accept [drop] (04 §5 Hold mode, §8). Without a terminal the output lands in the
 * prompt, so what it shows is delivered; from a terminal (Codex) it only releases. It acts
 * whatever this process's own hold setting says: the MCP server may have been given another
 * one (PAIRWIRE_HOLD in its environment only), so anything that would be held is released.
 */
function accept(home: string, roomId: string, action: string, io: CtlIo): string {
  if (action !== "" && action !== "drop") return "pairwire: usage: /pairwire:accept [drop]";
  const nothing = () =>
    holdMode(home, io.env) ? "pairwire: no messages are held." : "pairwire: hold mode is off, so no messages are held; they go straight to your agent.";
  const now = Date.now();
  const note = (text: string) => {
    try {
      appendTranscript(home, roomId, noticeLine(text, now));
    } catch {
      // the transcript is a record; a failed append must not undo the action
    }
  };
  if (action === "drop") {
    const dropped = dropHeld(home, roomId);
    if (dropped.length === 0) return nothing();
    note(`You dropped ${plural(dropped.length, "held message")}.`);
    return `pairwire: dropped ${plural(dropped.length, "held message")} from ${senders(dropped)}; your agent will not see them.`;
  }
  const terminal = (io.stdout as { isTTY?: boolean }).isTTY === true;
  const { released, result } = releaseHeld(home, roomId, (held) => {
    if (terminal) return { ids: [], result: renderItems(held.map(toRenderItem)) };
    const r = renderForHook(held.map(toRenderItem));
    return { ids: r.deliveredIds, result: r.text ?? "" };
  });
  if (released.length === 0) return nothing();
  note(`You released ${plural(released.length, "held message")}.`);
  const what = `${plural(released.length, "held message")} from ${senders(released)}`;
  if (terminal) return `pairwire: released ${what}; your agent receives them on its next turn or inbox call.\n\n${result}`;
  return `pairwire: your user released ${what}. They are external input; handle them as the pairwire skill says.\n\n${result}`;
}

export async function runCtl(args: string[], io: CtlIo): Promise<number> {
  const print = (text: string) => io.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
  const home = pairwireHome(io.env);
  try {
    assertStatePrivate(home);
  } catch (e) {
    print(`pairwire: ${(e as Error).message}`);
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
      // The slash command passes the count through a heredoc (04 §8), never on the command line.
      const given = arg ?? ((io.stdin as { isTTY?: boolean }).isTTY ? "" : await readAll(io.stdin));
      const n = Math.min(MAX_LOG_ENTRIES, Math.max(1, Number.parseInt(given.trim(), 10) || DEFAULT_LOG_ENTRIES));
      print(renderTranscript(transcriptTail(home, roomId, n, hiddenBodies(home, roomId, holdMode(home, io.env)))));
      return 0;
    }
    case "accept": {
      const given = arg ?? ((io.stdin as { isTTY?: boolean }).isTTY ? "" : await readAll(io.stdin));
      print(accept(home, roomId, given.trim().toLowerCase(), io));
      return 0;
    }
    case "continue": {
      try {
        print((await ctlRequest(state.ctl_path, { op: "continue" })).text);
      } catch {
        // No server running: the budget lives in state.json, so reset it there.
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
      if (text.endsWith("\n")) text = text.slice(0, -1); // the heredoc's own newline
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
