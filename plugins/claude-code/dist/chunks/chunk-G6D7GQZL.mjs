import { createRequire as __pwCreateRequire } from "node:module";
const require = __pwCreateRequire(import.meta.url);
import {
  PRIVATE_FILE_MODE,
  errorCode,
  expiresAt,
  readState
} from "./chunk-V6BBUVLD.mjs";
import {
  roomFile
} from "./chunk-GVGSGJLD.mjs";
import {
  displayName,
  isCollabKind,
  redact,
  sanitizeText
} from "./chunk-7VVD7K5U.mjs";

// packages/client/src/transcript.ts
import { appendFileSync, readFileSync } from "node:fs";
var stamp = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z").replace("T", " ");
var quote = (body) => body.split("\n").map((line) => `> ${line}`).join("\n");
function appendTranscript(home, roomId, text) {
  appendFileSync(roomFile(home, roomId, "transcript.md"), text.endsWith("\n") ? text : `${text}
`, { mode: PRIVATE_FILE_MODE });
}
var MINUTE = 6e4;
var hhmm = (ms) => new Date(ms).toISOString().slice(11, 16) + "Z";
function structuredFields(env, at, roomExpiresAt) {
  switch (env.kind) {
    case "heads_up":
      return env.data.paths.length > 0 ? [env.data.paths.join(", ")] : [];
    case "claim":
      return [env.data.paths.join(", "), `until ${hhmm(Math.min(at + env.data.ttl_min * MINUTE, roomExpiresAt))}`];
    case "contract_propose": {
      const d = env.data;
      return [`${d.name} v${d.version}`, d.path, ...d.rev ? [`@ ${d.rev}`] : [], `sha256 ${d.sha256.slice(0, 8)}`, ...d.content !== null ? ["inline"] : []];
    }
    case "contract_response":
      return [env.data.decision, `${env.data.name} v${env.data.version}`, `sha256 ${env.data.sha256.slice(0, 8)}`];
    default:
      return [];
  }
}
function messageEntry(arrow, at, who, env, o = {}) {
  const peer = arrow === "\u2190";
  const clean = (text) => peer ? sanitizeText(redact(text)) : redact(text);
  const parts = [`### ${arrow} ${stamp(at)}`, who, env.kind, env.id];
  if (env.reply_to) parts.push(`re ${env.reply_to}`);
  for (const f of structuredFields(env, at, o.roomExpiresAt ?? Number.MAX_SAFE_INTEGER)) parts.push(clean(f).replace(/\n/g, " "));
  if (o.queued) parts.push("queued");
  if (o.asChat) parts.push("as chat (peer's pairwire is older)");
  const body = env.body === null || env.body === "" ? "(no message)" : redact(env.body);
  return `${parts.join(" \xB7 ")}
${quote(peer ? sanitizeText(body) : body)}

`;
}
function ourMessage(env, at, queued, o = {}) {
  return messageEntry("\u2192", at, `you (${env.author})`, env, { ...o, queued });
}
function peerMessage(entry, roomExpiresAt) {
  const who = `${displayName(entry.from)} (${displayName(entry.harness)}, ${entry.envelope.author})`;
  return messageEntry("\u2190", entry.received_at, who, entry.envelope, roomExpiresAt === void 0 ? {} : { roomExpiresAt });
}
function noticeLine(text, at) {
  return `\xB7 ${stamp(at)} \xB7 ${sanitizeText(text).replace(/\n/g, " ")}
`;
}
function warningLine(text, at) {
  return `! ${stamp(at)} \xB7 ${sanitizeText(text).replace(/\n/g, " ")}
`;
}
function deliveredLine(ids, at) {
  return ids.map((id) => `\u2713 ${stamp(at)} \xB7 delivered ${id}
`).join("");
}
function transcriptEvents(home, roomId, now, onError, sessionHasCurrent, peerHasCollab = () => true) {
  const write = (text) => {
    try {
      appendTranscript(home, roomId, text);
    } catch (e) {
      onError(e);
    }
  };
  const roomExpiresAt = () => {
    try {
      const s = readState(home, roomId);
      return s ? expiresAt(s) : void 0;
    } catch {
      return void 0;
    }
  };
  return {
    sent: (env) => {
      const queued = !sessionHasCurrent();
      const asChat = !queued && isCollabKind(env.kind) && !peerHasCollab();
      const expires = roomExpiresAt();
      write(ourMessage(env, now(), queued, { asChat, ...expires === void 0 ? {} : { roomExpiresAt: expires } }));
    },
    inbound: (entry) => {
      if (entry.source === "peer") return write(peerMessage(entry, roomExpiresAt()));
      if (entry.event === "peer_changed") return;
      write((entry.event === "wrong_key" ? warningLine : noticeLine)(entry.text, entry.received_at));
    },
    // A changed peer identity is a warning for the human, every time (04 §3, ADR-030).
    peerChanged: (notice) => write(warningLine(notice.text, now())),
    delivered: (ids) => write(deliveredLine(ids, now()))
  };
}
function transcriptTail(home, roomId, n, hidden = /* @__PURE__ */ new Map(), accept = "/pairwire:accept") {
  const placeholder = {
    held: `> (held for your review: run ${accept})`,
    dropped: "> (dropped by your user)",
    pending: "> (not shown to your agent yet; it arrives with the next hook or inbox call)"
  };
  let text;
  try {
    text = readFileSync(roomFile(home, roomId, "transcript.md"), "utf8");
  } catch (e) {
    if (errorCode(e) === "ENOENT") return "";
    throw e;
  }
  const entries = [];
  for (const line of text.split("\n")) {
    if (line === "") continue;
    if (line.startsWith("> ") && entries.length > 0) entries[entries.length - 1] += `
${line}`;
    else entries.push(line);
  }
  return entries.slice(-n).map((entry) => {
    const heading = entry.split("\n", 1)[0];
    if (hidden.size === 0 || !heading.startsWith("### \u2190")) return entry;
    const fields = heading.split(" \xB7 ");
    const at = fields.findIndex((f) => hidden.has(f));
    if (at < 0) return entry;
    return `${fields.slice(0, at + 1).join(" \xB7 ")}
${placeholder[hidden.get(fields[at])]}`;
  }).join("\n\n");
}

export {
  appendTranscript,
  noticeLine,
  transcriptEvents,
  transcriptTail
};
