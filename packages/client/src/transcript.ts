// transcript.md: the human-readable record of both directions (REQ-MSG-8, 04 §3).
import { appendFileSync, readFileSync } from "node:fs";
import { displayName, redact, sanitizeText, type Envelope } from "@pairwire/core";
import type { ConnectionEvents } from "./connection.js";
import { errorCode, PRIVATE_FILE_MODE } from "./fs-util.js";
import { roomFile } from "./paths.js";
import type { InboxEntry } from "./room-files.js";

const stamp = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z").replace("T", " ");

/** Every body line quoted, so no message can forge an entry heading. */
const quote = (body: string) =>
  body
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");

export function appendTranscript(home: string, roomId: string, text: string): void {
  appendFileSync(roomFile(home, roomId, "transcript.md"), text.endsWith("\n") ? text : `${text}\n`, { mode: PRIVATE_FILE_MODE });
}

function messageEntry(arrow: "→" | "←", at: number, who: string, env: Envelope, queued = false): string {
  const parts = [`### ${arrow} ${stamp(at)}`, who, env.kind, env.id];
  if (env.reply_to) parts.push(`re ${env.reply_to}`);
  if (queued) parts.push("queued");
  const body = env.body === null || env.body === "" ? "(no message)" : redact(env.body);
  return `${parts.join(" · ")}\n${quote(arrow === "←" ? sanitizeText(body) : body)}\n\n`;
}

export function ourMessage(env: Envelope, at: number, queued: boolean): string {
  return messageEntry("→", at, `you (${env.author})`, env, queued);
}

export function peerMessage(entry: Extract<InboxEntry, { source: "peer" }>): string {
  const who = `${displayName(entry.from)} (${displayName(entry.harness)}, ${entry.envelope.author})`;
  return messageEntry("←", entry.received_at, who, entry.envelope);
}

export function noticeLine(text: string, at: number): string {
  return `· ${stamp(at)} · ${sanitizeText(text).replace(/\n/g, " ")}\n`;
}

export function warningLine(text: string, at: number): string {
  return `! ${stamp(at)} · ${sanitizeText(text).replace(/\n/g, " ")}\n`;
}

export function deliveredLine(ids: readonly string[], at: number): string {
  return ids.map((id) => `✓ ${stamp(at)} · delivered ${id}\n`).join("");
}

/**
 * Connection events that append to the room's transcript. Errors are swallowed: a full disk
 * must not break messaging; the logger reports them.
 */
export function transcriptEvents(home: string, roomId: string, now: () => number, onError: (e: unknown) => void, sessionHasCurrent: () => boolean): ConnectionEvents {
  const write = (text: string) => {
    try {
      appendTranscript(home, roomId, text);
    } catch (e) {
      onError(e);
    }
  };
  return {
    sent: (env) => write(ourMessage(env, now(), !sessionHasCurrent())),
    inbound: (entry) => {
      if (entry.source === "peer") return write(peerMessage(entry));
      // A changed peer identity or a wrong key is a warning for the human (04 §3, 02 §4.2).
      const warn = entry.event === "peer_changed" || entry.event === "wrong_key";
      write((warn ? warningLine : noticeLine)(entry.text, entry.received_at));
    },
    delivered: (ids) => write(deliveredLine(ids, now())),
  };
}

/**
 * The last `n` entries (an entry is a heading line plus its quoted body, or a single line).
 * Peer entries whose id is in `hidden` get a placeholder body (hold mode, 04 §8) that names
 * `accept`, the human's release command in their harness. An entry is matched when any ` · `
 * field of its heading equals the id, so a display name imitating an id can hide more, but
 * can never hide the real id field.
 */
export function transcriptTail(
  home: string,
  roomId: string,
  n: number,
  hidden: ReadonlyMap<string, "held" | "dropped"> = new Map(),
  accept = "/pairwire:accept",
): string {
  const placeholder = { held: `> (held for your review: run ${accept})`, dropped: "> (dropped by your user)" } as const;
  let text: string;
  try {
    text = readFileSync(roomFile(home, roomId, "transcript.md"), "utf8");
  } catch (e) {
    if (errorCode(e) === "ENOENT") return "";
    throw e;
  }
  const entries: string[] = [];
  for (const line of text.split("\n")) {
    if (line === "") continue;
    if (line.startsWith("> ") && entries.length > 0) entries[entries.length - 1] += `\n${line}`;
    else entries.push(line);
  }
  return entries
    .slice(-n)
    .map((entry) => {
      const heading = entry.split("\n", 1)[0]!;
      if (hidden.size === 0 || !heading.startsWith("### ←")) return entry;
      const why = heading
        .split(" · ")
        .map((f) => hidden.get(f))
        .find((w) => w !== undefined);
      return why ? `${heading}\n${placeholder[why]}` : entry;
    })
    .join("\n\n");
}
