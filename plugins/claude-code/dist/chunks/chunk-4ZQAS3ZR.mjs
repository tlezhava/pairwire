import { createRequire as __pwCreateRequire } from "node:module";
const require = __pwCreateRequire(import.meta.url);
import {
  createLogger,
  fileSink,
  roomTag
} from "./chunk-JWR3HKHJ.mjs";
import {
  PRIVATE_FILE_MODE,
  errorCode,
  withLock,
  writeFileAtomic
} from "./chunk-UOIJGI55.mjs";
import {
  hookErrorsPath,
  roomFile
} from "./chunk-GVGSGJLD.mjs";
import {
  envelopeSchema,
  external_exports
} from "./chunk-JC2XR7LP.mjs";

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
    event: external_exports.enum(["peer_joined", "peer_left", "peer_changed", "wrong_key", "held"]),
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
    const { ids, result } = pick(readInbox(home, roomId).filter((e) => !l.ids.has(e.id) && !isHeld(e, l, opts.hold)));
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
    const { ids, result } = pick(held);
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
function toRenderItem(e) {
  if (e.source === "local") return { source: "local", id: e.id, event: e.event, text: e.text };
  return { source: "peer", id: e.id, from: e.from, harness: e.harness, receivedAt: new Date(e.received_at).toISOString(), envelope: e.envelope };
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
  toRenderItem
};
