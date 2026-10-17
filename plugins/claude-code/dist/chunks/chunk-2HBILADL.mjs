import { createRequire as __pwCreateRequire } from "node:module";
const require = __pwCreateRequire(import.meta.url);
import {
  PRIVATE_FILE_MODE,
  createLogger,
  errorCode,
  expiresAt,
  fileSink,
  isOpen,
  readState,
  roomTag,
  withLock,
  writeFileAtomic
} from "./chunk-NXFQKJ6Z.mjs";
import {
  hookErrorsPath,
  roomFile
} from "./chunk-GVGSGJLD.mjs";
import {
  contractPathProblem,
  coordView,
  envelopeSchema,
  external_exports,
  isCollabKind,
  pathsOverlap,
  sanitizeAttr,
  scanSecrets
} from "./chunk-GA7MQSBW.mjs";
import {
  bytesToHex,
  sha256
} from "./chunk-KARZWXGF.mjs";

// packages/client/src/room-files.ts
import { appendFileSync, readFileSync } from "node:fs";
var millis = external_exports.number().int().min(0);
var inboxEntrySchema = external_exports.discriminatedUnion("source", [
  external_exports.strictObject({
    source: external_exports.literal("peer"),
    id: external_exports.string(),
    from: external_exports.string(),
    harness: external_exports.string(),
    received_at: millis,
    envelope: envelopeSchema
  }),
  external_exports.strictObject({
    source: external_exports.literal("local"),
    id: external_exports.string(),
    event: external_exports.enum(["peer_joined", "peer_left", "peer_changed", "wrong_key", "held", "peer_unreadable"]),
    text: external_exports.string(),
    received_at: millis
  })
]);
var outboxEntrySchema = external_exports.strictObject({
  envelope: envelopeSchema,
  status: external_exports.enum(["queued", "sent", "delivered"]),
  sent_at: millis.nullable(),
  delivered_at: millis.nullable()
});
var KEEP_DELIVERED = 5;
function readLines(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if (errorCode(e) === "ENOENT") return [];
    throw e;
  }
  const out = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
    }
  }
  return out;
}
function readInbox(home, roomId) {
  return readLines(roomFile(home, roomId, "inbox.jsonl")).flatMap((v) => {
    const p = inboxEntrySchema.safeParse(v);
    return p.success ? [p.data] : [];
  });
}
function appendInbox(home, roomId, entry) {
  const path = roomFile(home, roomId, "inbox.jsonl");
  return withLock(path, () => {
    if (readInbox(home, roomId).some((e) => e.id === entry.id)) return false;
    appendFileSync(path, JSON.stringify(inboxEntrySchema.parse(entry)) + "\n", { mode: PRIVATE_FILE_MODE });
    return true;
  });
}
function readOutbox(home, roomId) {
  return readLines(roomFile(home, roomId, "outbox.jsonl")).flatMap((v) => {
    const p = outboxEntrySchema.safeParse(v);
    return p.success ? [p.data] : [];
  });
}
function updateOutbox(home, roomId, change) {
  const path = roomFile(home, roomId, "outbox.jsonl");
  return withLock(path, () => {
    const next = change(readOutbox(home, roomId)).sort((a, b) => a.envelope.seq - b.envelope.seq);
    const delivered = next.filter((e) => e.status === "delivered");
    const drop = new Set(delivered.slice(0, Math.max(0, delivered.length - KEEP_DELIVERED)));
    const kept = next.filter((e) => !drop.has(e));
    writeFileAtomic(path, kept.map((e) => JSON.stringify(outboxEntrySchema.parse(e)) + "\n").join(""));
    return kept;
  });
}
var unacked = (entries) => entries.filter((e) => e.status !== "delivered");
var deliveredSchema = external_exports.strictObject({
  ids: external_exports.array(external_exports.string()),
  released: external_exports.array(external_exports.string()).optional(),
  dropped: external_exports.array(external_exports.string()).optional()
});
var emptyLedger = () => ({ ids: /* @__PURE__ */ new Set(), released: /* @__PURE__ */ new Set(), dropped: /* @__PURE__ */ new Set() });
function failClosedLedger(home, roomId) {
  const peers = readInbox(home, roomId).filter((e) => e.source === "peer").map((e) => e.id);
  return { ids: new Set(peers), released: /* @__PURE__ */ new Set(), dropped: new Set(peers) };
}
function loadLedger(home, roomId) {
  let text;
  try {
    text = readFileSync(roomFile(home, roomId, "delivered.json"), "utf8");
  } catch (e) {
    if (errorCode(e) === "ENOENT") return { ledger: emptyLedger(), corrupt: false };
    return { ledger: failClosedLedger(home, roomId), corrupt: true };
  }
  try {
    const v = deliveredSchema.parse(JSON.parse(text));
    return { ledger: { ids: new Set(v.ids), released: new Set(v.released), dropped: new Set(v.dropped) }, corrupt: false };
  } catch {
    return { ledger: failClosedLedger(home, roomId), corrupt: true };
  }
}
function warnCorrupt(home, roomId) {
  createLogger({ sink: fileSink(hookErrorsPath(home)), level: "warn" }).warn("delivered_unreadable", {
    room: roomTag(roomId),
    action: "treated every peer message in the inbox as delivered and dropped"
  });
}
function readLedger(home, roomId) {
  const { ledger, corrupt } = loadLedger(home, roomId);
  if (!corrupt) return ledger;
  try {
    return withLedger(home, roomId, (l) => l);
  } catch {
    return ledger;
  }
}
function writeLedger(path, l) {
  writeFileAtomic(path, JSON.stringify({ ids: [...l.ids], released: [...l.released], dropped: [...l.dropped] }) + "\n");
}
function withLedger(home, roomId, fn) {
  const path = roomFile(home, roomId, "delivered.json");
  return withLock(path, () => {
    const { ledger, corrupt } = loadLedger(home, roomId);
    const save = () => writeLedger(path, ledger);
    if (corrupt) {
      warnCorrupt(home, roomId);
      save();
    }
    return fn(ledger, save);
  });
}
function isHeld(e, l, hold) {
  return hold && e.source === "peer" && !l.ids.has(e.id) && !l.released.has(e.id);
}
function inboxCounts(home, roomId, hold) {
  const l = readLedger(home, roomId);
  const counts = { messages: 0, notices: 0, held: 0 };
  for (const e of readInbox(home, roomId)) {
    if (l.ids.has(e.id)) continue;
    if (isHeld(e, l, hold)) counts.held++;
    else if (e.source === "peer") counts.messages++;
    else counts.notices++;
  }
  return counts;
}
function claimUndelivered(home, roomId, opts, pick) {
  return withLedger(home, roomId, (l, save) => {
    const { ids, result } = pick(
      readInbox(home, roomId).filter((e) => !l.ids.has(e.id) && !isHeld(e, l, opts.hold)),
      l
    );
    if (ids.length > 0) {
      for (const id of ids) l.ids.add(id);
      save();
    }
    return result;
  });
}
function heldAndNotices(home, roomId, l) {
  const inbox = readInbox(home, roomId);
  return {
    held: inbox.filter((e) => isHeld(e, l, true)),
    notices: inbox.filter((e) => e.source === "local" && e.event === "held" && !l.ids.has(e.id)).map((e) => e.id)
  };
}
function releaseHeld(home, roomId, pick) {
  return withLedger(home, roomId, (l, save) => {
    const { held, notices } = heldAndNotices(home, roomId, l);
    const { ids, result } = pick(held, l);
    if (held.length === 0) return { released: held, result };
    for (const e of held) l.released.add(e.id);
    for (const id of [...ids, ...notices]) l.ids.add(id);
    save();
    return { released: held, result };
  });
}
function dropHeld(home, roomId) {
  return withLedger(home, roomId, (l, save) => {
    const { held, notices } = heldAndNotices(home, roomId, l);
    if (held.length === 0) return held;
    for (const e of held) {
      l.dropped.add(e.id);
      l.ids.add(e.id);
    }
    for (const id of notices) l.ids.add(id);
    save();
    return held;
  });
}
function hiddenBodies(home, roomId, hold) {
  const l = readLedger(home, roomId);
  const out = /* @__PURE__ */ new Map();
  for (const e of readInbox(home, roomId)) if (isHeld(e, l, hold)) out.set(e.id, "held");
  for (const id of l.dropped) out.set(id, "dropped");
  return out;
}
function toRenderItem(e, coord) {
  if (e.source === "local") return { source: "local", id: e.id, event: e.event, text: e.text };
  const item = { source: "peer", id: e.id, from: e.from, harness: e.harness, receivedAt: new Date(e.received_at).toISOString(), envelope: e.envelope };
  return coord ? { ...item, coord } : item;
}
var coordSentSchema = external_exports.strictObject({
  envelope: envelopeSchema,
  sent_at: millis,
  /** contract_response with accept: our own copy of the contract, never sent. */
  local_path: external_exports.string().optional()
});
function readCoordSent(home, roomId) {
  return readLines(roomFile(home, roomId, "coord-sent.jsonl")).flatMap((v) => {
    const p = coordSentSchema.safeParse(v);
    return p.success ? [p.data] : [];
  });
}
function appendCoordSent(home, roomId, entry) {
  const path = roomFile(home, roomId, "coord-sent.jsonl");
  withLock(path, () => {
    if (readCoordSent(home, roomId).some((e) => e.envelope.id === entry.envelope.id)) return;
    appendFileSync(path, JSON.stringify(coordSentSchema.parse(entry)) + "\n", { mode: PRIVATE_FILE_MODE });
  });
}

// packages/client/src/coord.ts
import { realpathSync, readFileSync as readFileSync2, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, sep } from "node:path";
function loadView(home, roomId, o) {
  const ledger = o.ledger ?? readLedger(home, roomId);
  const showing = new Set(o.showing ?? []);
  const state = readState(home, roomId);
  const messages = [];
  for (const e of readInbox(home, roomId)) {
    if (e.source !== "peer" || !isCollabKind(e.envelope.kind)) continue;
    const hidden = ledger.dropped.has(e.id) || isHeld(e, ledger, o.hold);
    if (hidden && !showing.has(e.id)) continue;
    messages.push({ side: "peer", envelope: e.envelope, at: e.received_at });
  }
  const sent = readCoordSent(home, roomId);
  for (const c of sent) messages.push({ side: "ours", envelope: c.envelope, at: c.sent_at });
  const view = coordView({ messages, roomOpen: !!state && isOpen(state), roomExpiresAt: state ? expiresAt(state) : 0, now: o.now });
  return { view, sent, ledger };
}
function coordAttrs(e, view) {
  if (e.source !== "peer" || !isCollabKind(e.envelope.kind)) return void 0;
  const env = e.envelope;
  const paths = env.kind === "claim" || env.kind === "heads_up" ? env.data.paths : [];
  const overlaps = view.claims.ours.filter((c) => c.paths.some((p) => paths.some((q) => pathsOverlap(p, q)))).map((c) => c.id);
  return { ...view.info("peer", e.id), ...overlaps.length > 0 ? { overlapsYours: overlaps } : {} };
}
function renderItemsFor(home, roomId, entries, o) {
  if (!entries.some((e) => e.source === "peer" && isCollabKind(e.envelope.kind))) return entries.map((e) => toRenderItem(e));
  const { view } = loadView(home, roomId, { ...o, showing: [...o.showing ?? [], ...entries.map((e) => e.id)] });
  return entries.map((e) => toRenderItem(e, coordAttrs(e, view)));
}
var MAX_CONTRACT_FILE_BYTES = 1024 * 1024;
var SENSITIVE = [/\.pem$/i, /\.key$/i, /^id_rsa/i, /^id_ed25519/i, /\.p12$/i, /\.pfx$/i, /^credentials/i, /^secrets/i];
var ContractFileError = class extends Error {
  constructor(rule, message) {
    super(message);
    this.rule = rule;
  }
  rule;
  name = "ContractFileError";
};
function readContractFile(projectDir, relPath) {
  const fail = (rule, why) => {
    throw new ContractFileError(rule, `${relPath}: ${why}`);
  };
  const problem = contractPathProblem(relPath);
  if (problem) fail("bad_path", `the path ${problem}`);
  const root = realpathSync(projectDir);
  let real = "";
  try {
    real = realpathSync(join(root, relPath));
  } catch (e) {
    fail(errorCode(e) === "ENOENT" ? "missing" : "not_a_file", errorCode(e) === "ENOENT" ? "no such file in this project" : "can't be resolved");
  }
  const rel = relative(root, real);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) fail("outside_project", "resolves to a file outside this project");
  if (contractPathProblem(rel.split(sep).join("/"))) fail("dot_path", "resolves to a dot-file, a dot-directory or an unusable path");
  if ([basename(relPath), basename(real)].some((n) => SENSITIVE.some((re) => re.test(n)))) fail("sensitive_name", "has a name that usually holds keys or credentials");
  const st = statSync(real);
  if (!st.isFile()) fail("not_a_file", "is not a regular file");
  if (st.size > MAX_CONTRACT_FILE_BYTES) fail("too_large", "is larger than 1 MiB");
  const bytes = readFileSync2(real);
  if (bytes.length > MAX_CONTRACT_FILE_BYTES) fail("too_large", "is larger than 1 MiB");
  let text = "";
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    fail("not_utf8", "is not UTF-8 text");
  }
  const found = scanSecrets(text);
  if (found.length > 0) fail("secret", `looks like it contains a secret (${found.map((f) => `${f.rule} at character ${f.offset}`).join(", ")})`);
  return { text, sha256: bytesToHex(sha256(bytes)) };
}
function fileState(projectDir, path, sha) {
  try {
    return readContractFile(projectDir, path).sha256 === sha ? "in sync" : "changed locally";
  } catch (e) {
    if (e instanceof ContractFileError) return e.rule === "missing" ? "missing" : `unreadable (${e.rule})`;
    return "unreadable";
  }
}
var hhmm = (ms) => new Date(ms).toISOString().slice(11, 16) + "Z";
var attr = (s) => sanitizeAttr(s);
function coordStatusLines(loaded, o) {
  const { view, sent } = loaded;
  if (view.claims.peer.length === 0 && view.claims.ours.length === 0 && view.contracts.length === 0) return [];
  const claimLine = (c) => `${c.paths.map(attr).join(", ")} \xB7 claim ${c.id} \xB7 until ${hhmm(c.expiresAt)}`;
  const lines = ["Claims (advisory; pairwire locks nothing):"];
  if (view.claims.peer.length === 0) lines.push(`  ${o.peer}'s agent: none`);
  for (const c of view.claims.peer) lines.push(`  ${o.peer}'s agent (external input): ${claimLine(c)}`);
  if (view.claims.ours.length === 0) lines.push("  yours: none");
  for (const c of view.claims.ours) lines.push(`  yours: ${claimLine(c)}`);
  if (view.contracts.length > 0) lines.push("Contracts:");
  for (const p of view.contracts) lines.push(`  ${contractLine(p, sent, o)}`);
  return lines;
}
function contractLine(p, sent, o) {
  const ours = p.side === "ours";
  const parts = [`${attr(p.name)} v${p.version}`, `sha256 ${p.sha256.slice(0, 8)}\u2026`, ours ? `proposed by you ${p.id}` : `proposed by ${o.peer} ${p.id} (external input)`];
  if (p.answer) {
    const who = p.answer.side === "ours" ? "you" : o.peer;
    parts.push(`${p.answer.decision === "accept" ? "accepted" : "rejected"} by ${who} ${hhmm(p.answer.at)}`);
  } else {
    parts.push(ours ? `awaiting ${o.peer}'s answer` : "awaiting your answer");
  }
  const localPath = ours ? p.path : sent.find((s) => s.envelope.id === p.answer?.id && s.local_path)?.local_path;
  if (localPath) parts.push(`your file: ${fileState(o.projectDir, localPath, p.sha256)}`);
  return parts.join(" \xB7 ");
}
function coordFooter(view) {
  const claims = view.claims.peer.length;
  const awaiting = view.contracts.filter((p) => p.side === "peer" && p.state === "pending").length;
  let out = "";
  if (claims > 0) out += ` \xB7 ${claims} peer claim${claims === 1 ? "" : "s"}`;
  if (awaiting > 0) out += ` \xB7 ${awaiting} contract${awaiting === 1 ? "" : "s"} awaiting your answer`;
  return out;
}

export {
  appendInbox,
  readOutbox,
  updateOutbox,
  unacked,
  inboxCounts,
  claimUndelivered,
  releaseHeld,
  dropHeld,
  hiddenBodies,
  readCoordSent,
  appendCoordSent,
  loadView,
  renderItemsFor,
  ContractFileError,
  readContractFile,
  coordStatusLines,
  coordFooter
};
