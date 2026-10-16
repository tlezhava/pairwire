// transcript.md: the human-readable record of both directions (REQ-MSG-8, 04 §3).
import { appendFileSync, readFileSync } from "node:fs";
import { displayName, isCollabKind, redact, sanitizeText, type Envelope } from "@pairwire/core";
import type { ConnectionEvents } from "./connection.js";
import { errorCode, PRIVATE_FILE_MODE } from "./fs-util.js";
import { roomFile } from "./paths.js";
import type { InboxEntry } from "./room-files.js";
import { expiresAt, readState } from "./state.js";

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

const MINUTE = 60_000;
const hhmm = (ms: number) => new Date(ms).toISOString().slice(11, 16) + "Z";

/**
 * The heading fields of a structured message (04 §5, Structured kinds). `roomExpiresAt`
 * caps a claim's local expiry. Inline contract content is never copied here.
 */
function structuredFields(env: Envelope, at: number, roomExpiresAt: number): string[] {
  switch (env.kind) {
    case "heads_up":
      return env.data.paths.length > 0 ? [env.data.paths.join(", ")] : [];
    case "claim":
      return [env.data.paths.join(", "), `until ${hhmm(Math.min(at + env.data.ttl_min * MINUTE, roomExpiresAt))}`];
    case "contract_propose": {
      const d = env.data;
      return [`${d.name} v${d.version}`, d.path, ...(d.rev ? [`@ ${d.rev}`] : []), `sha256 ${d.sha256.slice(0, 8)}`, ...(d.content !== null ? ["inline"] : [])];
    }
    case "contract_response":
      return [env.data.decision, `${env.data.name} v${env.data.version}`, `sha256 ${env.data.sha256.slice(0, 8)}`];
    default:
      return [];
  }
}

interface EntryOptions {
  queued?: boolean;
  /** Ours, sent as a chat because the peer's client lacks `collab1` (02 §6.3.6). */
  asChat?: boolean;
  roomExpiresAt?: number;
}

function messageEntry(arrow: "→" | "←", at: number, who: string, env: Envelope, o: EntryOptions = {}): string {
  const peer = arrow === "←";
  const clean = (text: string) => (peer ? sanitizeText(redact(text)) : redact(text));
  const parts = [`### ${arrow} ${stamp(at)}`, who, env.kind, env.id];
  if (env.reply_to) parts.push(`re ${env.reply_to}`);
  // Peer fields are single-line by schema; the sanitizer and redact() still run on them.
  for (const f of structuredFields(env, at, o.roomExpiresAt ?? Number.MAX_SAFE_INTEGER)) parts.push(clean(f).replace(/\n/g, " "));
  if (o.queued) parts.push("queued");
  if (o.asChat) parts.push("as chat (peer's pairwire is older)");
  const body = env.body === null || env.body === "" ? "(no message)" : redact(env.body);
  return `${parts.join(" · ")}\n${quote(peer ? sanitizeText(body) : body)}\n\n`;
}

export function ourMessage(env: Envelope, at: number, queued: boolean, o: Omit<EntryOptions, "queued"> = {}): string {
  return messageEntry("→", at, `you (${env.author})`, env, { ...o, queued });
}

export function peerMessage(entry: Extract<InboxEntry, { source: "peer" }>, roomExpiresAt?: number): string {
  const who = `${displayName(entry.from)} (${displayName(entry.harness)}, ${entry.envelope.author})`;
  return messageEntry("←", entry.received_at, who, entry.envelope, roomExpiresAt === undefined ? {} : { roomExpiresAt });
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
export function transcriptEvents(
  home: string,
  roomId: string,
  now: () => number,
  onError: (e: unknown) => void,
  sessionHasCurrent: () => boolean,
  peerHasCollab: () => boolean = () => true,
): ConnectionEvents {
  const write = (text: string) => {
    try {
      appendTranscript(home, roomId, text);
    } catch (e) {
      onError(e);
    }
  };
  const roomExpiresAt = () => {
    try {
      const s = readState(home, roomId);
      return s ? expiresAt(s) : undefined;
    } catch {
      return undefined;
    }
  };
  return {
    sent: (env) => {
      const queued = !sessionHasCurrent();
      const asChat = !queued && isCollabKind(env.kind) && !peerHasCollab();
      const expires = roomExpiresAt();
      write(ourMessage(env, now(), queued, { asChat, ...(expires === undefined ? {} : { roomExpiresAt: expires }) }));
    },
    inbound: (entry) => {
      if (entry.source === "peer") return write(peerMessage(entry, roomExpiresAt()));
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
 * can never hide the real id field. The heading of a hidden entry ends at that field.
 */
export function transcriptTail(
  home: string,
  roomId: string,
  n: number,
  hidden: ReadonlyMap<string, "held" | "dropped" | "pending"> = new Map(),
  accept = "/pairwire:accept",
): string {
  const placeholder = {
    held: `> (held for your review: run ${accept})`,
    dropped: "> (dropped by your user)",
    pending: "> (not shown to your agent yet; it arrives with the next hook or inbox call)",
  } as const;
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
      const fields = heading.split(" · ");
      const at = fields.findIndex((f) => hidden.has(f));
      if (at < 0) return entry;
      // Cut after the id: a hidden message's structured fields (paths, names) don't show either.
      return `${fields.slice(0, at + 1).join(" · ")}\n${placeholder[hidden.get(fields[at]!)!]}`;
    })
    .join("\n\n");
}
