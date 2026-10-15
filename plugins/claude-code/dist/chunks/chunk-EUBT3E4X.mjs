import { createRequire as __pwCreateRequire } from "node:module";
const require = __pwCreateRequire(import.meta.url);
import {
  PRIVATE_FILE_MODE,
  envelopeSchema,
  errorCode,
  external_exports,
  withLock,
  writeFileAtomic
} from "./chunk-H4ULF7HQ.mjs";
import {
  roomFile
} from "./chunk-A6UKVX6D.mjs";

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
    event: external_exports.enum(["peer_joined", "peer_left", "peer_changed", "wrong_key"]),
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
var deliveredSchema = external_exports.strictObject({ ids: external_exports.array(external_exports.string()) });
function readDelivered(home, roomId) {
  try {
    return new Set(deliveredSchema.parse(JSON.parse(readFileSync(roomFile(home, roomId, "delivered.json"), "utf8"))).ids);
  } catch (e) {
    if (errorCode(e) === "ENOENT") return /* @__PURE__ */ new Set();
    return /* @__PURE__ */ new Set();
  }
}
function undelivered(home, roomId) {
  const seen = readDelivered(home, roomId);
  return readInbox(home, roomId).filter((e) => !seen.has(e.id));
}
function claimUndelivered(home, roomId, pick) {
  const path = roomFile(home, roomId, "delivered.json");
  return withLock(path, () => {
    const seen = readDelivered(home, roomId);
    const { ids, result } = pick(readInbox(home, roomId).filter((e) => !seen.has(e.id)));
    if (ids.length > 0) {
      for (const id of ids) seen.add(id);
      writeFileAtomic(path, JSON.stringify({ ids: [...seen] }) + "\n");
    }
    return result;
  });
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
  undelivered,
  claimUndelivered,
  toRenderItem
};
