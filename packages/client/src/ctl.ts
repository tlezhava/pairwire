// `pairwire ctl <say|continue|log>`: the human-side commands, run by slash commands through `!`
// (04 §8). Output lands in the prompt, so expected failures print `pairwire: …` and exit 0.
import { createConnection } from "node:net";
import type { Readable, Writable } from "node:stream";
import { renderTranscript } from "@pairwire/core";
import { readBinding } from "./binding.js";
import { CTL_MAX_REQUEST, type CtlReply, type CtlRequest } from "./ctl-server.js";
import { pairwireHome } from "./paths.js";
import { assertStatePrivate } from "./permissions.js";
import { resolveProjectDir } from "./project.js";
import { isOpen, readState, updateState } from "./state.js";
import { transcriptTail } from "./transcript.js";

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
      const n = Math.min(MAX_LOG_ENTRIES, Math.max(1, Number.parseInt(arg ?? "", 10) || DEFAULT_LOG_ENTRIES));
      print(renderTranscript(transcriptTail(home, roomId, n)));
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
      print("pairwire: usage: pairwire ctl <say|continue|log [n]>");
      return 0;
  }
}
