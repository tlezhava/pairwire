// A group room's per-peer state (04 §4, Group rooms; 02 §8; ADR-037): group.json and
// group-outbox.jsonl. state.json keeps its pair-room schema, which 0.3.x parses strictly.
import { readFileSync } from "node:fs";
import { envelopeSchema } from "@pairwire/core";
import { z } from "zod";
import { errorCode, withLock, writeFileAtomic } from "./fs-util.js";
import { roomFile } from "./paths.js";

const hex = z.string().regex(/^(?:[0-9a-f]{2})+$/);
const counter = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const millis = z.number().int().min(0);
const index = z.number().int().min(0).max(7);

const sessionSchema = z.strictObject({ sid: hex, send_key: hex, recv_key: hex });

export const groupPeerSchema = z.strictObject({
  /** From the peer's first accepted HELLO; null until then. */
  name: z.string().nullable(),
  harness: z.string().nullable(),
  instance: z.string().nullable(),
  sessions: z.strictObject({ current: sessionSchema.nullable(), previous: sessionSchema.nullable() }),
  caps: z.array(z.string().max(32)).max(16),
  /** The seq of the last envelope we sent to this peer (02 §8.5). */
  my_seq: counter,
  peer_max_seq: counter,
  left: z.boolean(),
});
export type GroupPeer = z.infer<typeof groupPeerSchema>;

export const groupFileSchema = z.strictObject({
  v: z.literal(1),
  /** null for a joiner until its first `joined`. */
  capacity: z.number().int().min(3).max(8).nullable(),
  /** We started the room: our tokenless join carries `capacity`. */
  starter: z.boolean(),
  member: index.nullable(),
  peers: z.record(z.string().regex(/^[0-7]$/), groupPeerSchema),
});
export type GroupFile = z.infer<typeof groupFileSchema>;

export const newPeer = (): GroupPeer => ({
  name: null,
  harness: null,
  instance: null,
  sessions: { current: null, previous: null },
  caps: [],
  my_seq: 0,
  peer_max_seq: 0,
  left: false,
});

const groupPath = (home: string, key: string) => roomFile(home, key, "group.json");

/** Marks room `key` as a group room (04 §4): `capacity` for the starter, null for a joiner. */
export function createGroup(home: string, key: string, capacity: number | null): void {
  writeGroup(home, key, { v: 1, capacity, starter: capacity !== null, member: null, peers: {} });
}

function writeGroup(home: string, key: string, group: GroupFile): void {
  writeFileAtomic(groupPath(home, key), JSON.stringify(groupFileSchema.parse(group), null, 2) + "\n");
}

/** The group file, or null for a pair room. Throws on a file that exists but is invalid. */
export function readGroup(home: string, key: string): GroupFile | null {
  let text: string;
  try {
    text = readFileSync(groupPath(home, key), "utf8");
  } catch (e) {
    if (errorCode(e) === "ENOENT") return null;
    throw e;
  }
  return groupFileSchema.parse(JSON.parse(text));
}

export const isGroupRoom = (home: string, key: string): boolean => {
  try {
    return readGroup(home, key) !== null;
  } catch {
    return true; // a broken group file is still a group room: never speak v1 for it
  }
};

export function updateGroup(home: string, key: string, change: (g: GroupFile) => GroupFile): GroupFile {
  const path = groupPath(home, key);
  return withLock(path, () => {
    const current = readGroup(home, key);
    if (!current) throw new Error("not a group room");
    const next = change(structuredClone(current));
    writeGroup(home, key, next);
    return next;
  });
}

/** Wipes every peer's session keys (leave, end, expiry: 04 §3). */
export function wipeGroupSessions(home: string, key: string): void {
  try {
    updateGroup(home, key, (g) => ({
      ...g,
      peers: Object.fromEntries(Object.entries(g.peers).map(([i, p]) => [i, { ...p, sessions: { current: null, previous: null } }])),
    }));
  } catch {
    // not a group room, or already unreadable: nothing to wipe that a reader could use
  }
}

/** Peers by index, in index order. */
export function peerList(group: GroupFile): [number, GroupPeer][] {
  return Object.entries(group.peers)
    .map(([i, p]) => [Number(i), p] as [number, GroupPeer])
    .sort((a, b) => a[0] - b[0]);
}

// --- group-outbox.jsonl: one line per recipient copy (04 §4, Group rooms) ----------------

export const groupOutboxEntrySchema = z.strictObject({
  to: index,
  envelope: envelopeSchema,
  status: z.enum(["queued", "sent", "delivered"]),
  sent_at: millis.nullable(),
  delivered_at: millis.nullable(),
});
export type GroupOutboxEntry = z.infer<typeof groupOutboxEntrySchema>;

/** Delivered copies kept per peer, for the `inbox` tool's delivery status. */
const KEEP_DELIVERED_PER_PEER = 5;

const outboxPath = (home: string, key: string) => roomFile(home, key, "group-outbox.jsonl");

export function readGroupOutbox(home: string, key: string): GroupOutboxEntry[] {
  let text: string;
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
      return []; // a torn last line after a crash
    }
  });
}

export function updateGroupOutbox(home: string, key: string, change: (entries: GroupOutboxEntry[]) => GroupOutboxEntry[]): GroupOutboxEntry[] {
  const path = outboxPath(home, key);
  return withLock(path, () => {
    const next = change(readGroupOutbox(home, key)).sort((a, b) => a.to - b.to || a.envelope.seq - b.envelope.seq);
    const drop = new Set<GroupOutboxEntry>();
    for (const to of new Set(next.map((e) => e.to))) {
      const delivered = next.filter((e) => e.to === to && e.status === "delivered");
      for (const e of delivered.slice(0, Math.max(0, delivered.length - KEEP_DELIVERED_PER_PEER))) drop.add(e);
    }
    const kept = next.filter((e) => !drop.has(e));
    writeFileAtomic(path, kept.map((e) => JSON.stringify(groupOutboxEntrySchema.parse(e)) + "\n").join(""));
    return kept;
  });
}

/**
 * Who is in room `key` besides us, for footers, status, hooks and doctor (04 §4): the pair
 * room's peer, or a group room's named members that haven't left. Null while nobody is known.
 */
export function peopleLabel(home: string, key: string, state: { peer: { name: string; harness: string } | null }, show: (s: string) => string): string | null {
  let group: GroupFile | null;
  try {
    group = readGroup(home, key);
  } catch {
    return null;
  }
  if (!group) return state.peer ? `${show(state.peer.name)} (${show(state.peer.harness)})` : null;
  const named = peerList(group).filter(([, p]) => !p.left && p.name !== null);
  return named.length > 0 ? named.map(([, p]) => `${show(p.name!)} (${show(p.harness ?? "other")})`).join(", ") : null;
}

/** "3 of 4 joined" for a group room (us included), else null. */
export function groupFill(home: string, key: string): string | null {
  try {
    const group = readGroup(home, key);
    if (!group || group.capacity === null) return null;
    const members = 1 + peerList(group).filter(([, p]) => !p.left).length;
    return `${members} of ${group.capacity} joined`;
  } catch {
    return null;
  }
}
