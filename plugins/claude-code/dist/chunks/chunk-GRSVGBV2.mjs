import { createRequire as __pwCreateRequire } from "node:module";
const require = __pwCreateRequire(import.meta.url);
import {
  errorCode,
  withLock,
  writeFileAtomic
} from "./chunk-PKJEAGAD.mjs";
import {
  roomFile
} from "./chunk-H3AY57FF.mjs";
import {
  envelopeSchema,
  external_exports
} from "./chunk-NJ2ULMK2.mjs";

// packages/client/src/group-files.ts
import { readFileSync } from "node:fs";
var hex = external_exports.string().regex(/^(?:[0-9a-f]{2})+$/);
var counter = external_exports.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
var millis = external_exports.number().int().min(0);
var index = external_exports.number().int().min(0).max(7);
var sessionSchema = external_exports.strictObject({ sid: hex, send_key: hex, recv_key: hex });
var groupPeerSchema = external_exports.strictObject({
  /** From the peer's first accepted HELLO; null until then. */
  name: external_exports.string().nullable(),
  harness: external_exports.string().nullable(),
  instance: external_exports.string().nullable(),
  sessions: external_exports.strictObject({ current: sessionSchema.nullable(), previous: sessionSchema.nullable() }),
  caps: external_exports.array(external_exports.string().max(32)).max(16),
  /** The seq of the last envelope we sent to this peer (02 §8.5). */
  my_seq: counter,
  peer_max_seq: counter,
  left: external_exports.boolean()
});
var groupFileSchema = external_exports.strictObject({
  v: external_exports.literal(1),
  /** null for a joiner until its first `joined`. */
  capacity: external_exports.number().int().min(3).max(8).nullable(),
  /** We started the room: our tokenless join carries `capacity`. */
  starter: external_exports.boolean(),
  member: index.nullable(),
  peers: external_exports.record(external_exports.string().regex(/^[0-7]$/), groupPeerSchema)
});
var newPeer = () => ({
  name: null,
  harness: null,
  instance: null,
  sessions: { current: null, previous: null },
  caps: [],
  my_seq: 0,
  peer_max_seq: 0,
  left: false
});
var groupPath = (home, key) => roomFile(home, key, "group.json");
function createGroup(home, key, capacity) {
  writeGroup(home, key, { v: 1, capacity, starter: capacity !== null, member: null, peers: {} });
}
function writeGroup(home, key, group) {
  writeFileAtomic(groupPath(home, key), JSON.stringify(groupFileSchema.parse(group), null, 2) + "\n");
}
function readGroup(home, key) {
  let text;
  try {
    text = readFileSync(groupPath(home, key), "utf8");
  } catch (e) {
    if (errorCode(e) === "ENOENT") return null;
    throw e;
  }
  return groupFileSchema.parse(JSON.parse(text));
}
var isGroupRoom = (home, key) => {
  try {
    return readGroup(home, key) !== null;
  } catch {
    return true;
  }
};
function updateGroup(home, key, change) {
  const path = groupPath(home, key);
  return withLock(path, () => {
    const current = readGroup(home, key);
    if (!current) throw new Error("not a group room");
    const next = change(structuredClone(current));
    writeGroup(home, key, next);
    return next;
  });
}
function wipeGroupSessions(home, key) {
  try {
    updateGroup(home, key, (g) => ({
      ...g,
      peers: Object.fromEntries(Object.entries(g.peers).map(([i, p]) => [i, { ...p, sessions: { current: null, previous: null } }]))
    }));
  } catch {
  }
}
function peerList(group) {
  return Object.entries(group.peers).map(([i, p]) => [Number(i), p]).sort((a, b) => a[0] - b[0]);
}
var groupOutboxEntrySchema = external_exports.strictObject({
  to: index,
  envelope: envelopeSchema,
  status: external_exports.enum(["queued", "sent", "delivered"]),
  sent_at: millis.nullable(),
  delivered_at: millis.nullable()
});
var KEEP_DELIVERED_PER_PEER = 5;
var outboxPath = (home, key) => roomFile(home, key, "group-outbox.jsonl");
function readGroupOutbox(home, key) {
  let text;
  try {
    text = readFileSync(outboxPath(home, key), "utf8");
  } catch (e) {
    if (errorCode(e) === "ENOENT") return [];
    throw e;
  }
  return text.split("\n").flatMap((line) => {
    if (!line.trim()) return [];
    try {
      const p = groupOutboxEntrySchema.safeParse(JSON.parse(line));
      return p.success ? [p.data] : [];
    } catch {
      return [];
    }
  });
}
function updateGroupOutbox(home, key, change) {
  const path = outboxPath(home, key);
  return withLock(path, () => {
    const next = change(readGroupOutbox(home, key)).sort((a, b) => a.to - b.to || a.envelope.seq - b.envelope.seq);
    const drop = /* @__PURE__ */ new Set();
    for (const to of new Set(next.map((e) => e.to))) {
      const delivered = next.filter((e) => e.to === to && e.status === "delivered");
      for (const e of delivered.slice(0, Math.max(0, delivered.length - KEEP_DELIVERED_PER_PEER))) drop.add(e);
    }
    const kept = next.filter((e) => !drop.has(e));
    writeFileAtomic(path, kept.map((e) => JSON.stringify(groupOutboxEntrySchema.parse(e)) + "\n").join(""));
    return kept;
  });
}
function peopleLabel(home, key, state, show) {
  let group;
  try {
    group = readGroup(home, key);
  } catch {
    return null;
  }
  if (!group) return state.peer ? `${show(state.peer.name)} (${show(state.peer.harness)})` : null;
  const named = peerList(group).filter(([, p]) => !p.left && p.name !== null);
  return named.length > 0 ? named.map(([, p]) => `${show(p.name)} (${show(p.harness ?? "other")})`).join(", ") : null;
}
function groupFill(home, key) {
  try {
    const group = readGroup(home, key);
    if (!group || group.capacity === null) return null;
    const members = 1 + peerList(group).filter(([, p]) => !p.left).length;
    return `${members} of ${group.capacity} joined`;
  } catch {
    return null;
  }
}

export {
  newPeer,
  createGroup,
  readGroup,
  isGroupRoom,
  updateGroup,
  wipeGroupSessions,
  peerList,
  readGroupOutbox,
  updateGroupOutbox,
  peopleLabel,
  groupFill
};
