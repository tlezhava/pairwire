import { createRequire as __pwCreateRequire } from "node:module";
const require = __pwCreateRequire(import.meta.url);
import {
  PRIVATE_FILE_MODE,
  ensurePrivateDir,
  errorCode,
  removeFile
} from "./chunk-5XLM2UC5.mjs";
import {
  isNamedPipePath,
  roomFile
} from "./chunk-GVGSGJLD.mjs";
import {
  displayName,
  redact,
  sanitizeText
} from "./chunk-WZNRRE4K.mjs";

// packages/client/src/transcript.ts
import { appendFileSync, readFileSync } from "node:fs";
var stamp = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z").replace("T", " ");
var quote = (body) => body.split("\n").map((line) => `> ${line}`).join("\n");
function appendTranscript(home, roomId, text) {
  appendFileSync(roomFile(home, roomId, "transcript.md"), text.endsWith("\n") ? text : `${text}
`, { mode: PRIVATE_FILE_MODE });
}
function messageEntry(arrow, at, who, env, queued = false) {
  const parts = [`### ${arrow} ${stamp(at)}`, who, env.kind, env.id];
  if (env.reply_to) parts.push(`re ${env.reply_to}`);
  if (queued) parts.push("queued");
  const body = env.body === null || env.body === "" ? "(no message)" : redact(env.body);
  return `${parts.join(" \xB7 ")}
${quote(arrow === "\u2190" ? sanitizeText(body) : body)}

`;
}
function ourMessage(env, at, queued) {
  return messageEntry("\u2192", at, `you (${env.author})`, env, queued);
}
function peerMessage(entry) {
  const who = `${displayName(entry.from)} (${displayName(entry.harness)}, ${entry.envelope.author})`;
  return messageEntry("\u2190", entry.received_at, who, entry.envelope);
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
function transcriptEvents(home, roomId, now, onError, sessionHasCurrent) {
  const write = (text) => {
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
      const warn = entry.event === "peer_changed" || entry.event === "wrong_key";
      write((warn ? warningLine : noticeLine)(entry.text, entry.received_at));
    },
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
    const why = heading.split(" \xB7 ").map((f) => hidden.get(f)).find((w) => w !== void 0);
    return why ? `${heading}
${placeholder[why]}` : entry;
  }).join("\n\n");
}

// packages/client/src/ctl-server.ts
import { chmodSync, lstatSync } from "node:fs";
import { createServer } from "node:net";
import { dirname } from "node:path";
var CTL_MAX_REQUEST = 64 * 1024;
var REQUEST_TIMEOUT_MS = 1e4;
function parseCtlRequest(line) {
  let v;
  try {
    v = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof v !== "object" || v === null) return null;
  const r = v;
  if (r.op === "say" && typeof r.text === "string") return { op: "say", text: r.text };
  if (r.op === "continue" || r.op === "resume") return { op: r.op };
  if ((r.op === "wait" || r.op === "wait_cancel") && typeof r.session === "string") return { op: r.op, session: r.session };
  return null;
}
function preparePrivateDir(dir) {
  ensurePrivateDir(dir);
  const st = lstatSync(dir);
  const uid = process.getuid?.();
  if (!st.isDirectory() || uid !== void 0 && st.uid !== uid || (st.mode & 63) !== 0) {
    throw new Error(`The control socket directory ${dir} is not private to you.`);
  }
}
async function listenCtl(path, handle, log, wait) {
  const pipe = isNamedPipePath(path);
  if (!pipe) {
    preparePrivateDir(dirname(path));
    removeFile(path);
  }
  const server = createServer((socket) => {
    let buf = "";
    let done = false;
    socket.setEncoding("utf8");
    socket.setTimeout(REQUEST_TIMEOUT_MS, () => socket.destroy());
    const reply = (r) => {
      done = true;
      socket.end(JSON.stringify(r) + "\n");
    };
    socket.on("data", (chunk) => {
      if (done) return;
      buf += chunk;
      if (buf.length > CTL_MAX_REQUEST) return reply({ ok: false, text: "pairwire: request too large." });
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      const request = parseCtlRequest(buf.slice(0, nl));
      if (!request) return reply({ ok: false, text: "pairwire: bad control request." });
      socket.setTimeout(0);
      if (request.op === "wait") {
        done = true;
        if (wait) return wait(request, socket);
        return void socket.end(JSON.stringify({ t: "refused" }) + "\n");
      }
      handle(request).then(reply, (e) => {
        log.error("ctl_failed", e);
        reply({ ok: false, text: "pairwire: internal error; see the MCP server log." });
      });
    });
    socket.on("error", () => {
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      resolve();
    });
  });
  if (!pipe) chmodSync(path, 384);
  server.on("error", (e) => log.error("ctl_server_error", e));
  return {
    close: () => new Promise((resolve) => {
      server.close(() => resolve());
      if (!pipe) removeFile(path);
    })
  };
}

export {
  appendTranscript,
  noticeLine,
  transcriptEvents,
  transcriptTail,
  CTL_MAX_REQUEST,
  listenCtl
};
