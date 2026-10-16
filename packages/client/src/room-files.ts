// inbox.jsonl and outbox.jsonl of a room (04 §3, ADR-019).
import { appendFileSync, readFileSync } from "node:fs";
import { envelopeSchema, type RenderItem } from "@pairwire/core";
import { z } from "zod";
import { errorCode, PRIVATE_FILE_MODE, withLock, writeFileAtomic } from "./fs-util.js";
import { roomFile } from "./paths.js";

const millis = z.number().int().min(0);

export const inboxEntrySchema = z.discriminatedUnion("source", [
  z.strictObject({
    source: z.literal("peer"),
    id: z.string(),
    from: z.string(),
    harness: z.string(),
    received_at: millis,
    envelope: envelopeSchema,
  }),
  z.strictObject({
    source: z.literal("local"),
    id: z.string(),
    event: z.enum(["peer_joined", "peer_left", "peer_changed", "wrong_key", "held"]),
    text: z.string(),
    received_at: millis,
  }),
]);
export type InboxEntry = z.infer<typeof inboxEntrySchema>;

export const outboxEntrySchema = z.strictObject({
  envelope: envelopeSchema,
  status: z.enum(["queued", "sent", "delivered"]),
  sent_at: millis.nullable(),
  delivered_at: millis.nullable(),
});
export type OutboxEntry = z.infer<typeof outboxEntrySchema>;

/** Delivered outbox entries kept for the `inbox` tool's delivery status. */
export const KEEP_DELIVERED = 5;

function readLines(path: string): unknown[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    if (errorCode(e) === "ENOENT") return [];
    throw e;
  }
  const out: unknown[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // a torn last line after a crash: skip it
    }
  }
  return out;
}

/** Every valid inbox entry, oldest first. */
export function readInbox(home: string, roomId: string): InboxEntry[] {
  return readLines(roomFile(home, roomId, "inbox.jsonl")).flatMap((v) => {
    const p = inboxEntrySchema.safeParse(v);
    return p.success ? [p.data] : [];
  });
}

/** Appends `entry` unless an entry with the same id is already there. Returns whether it was added. */
export function appendInbox(home: string, roomId: string, entry: InboxEntry): boolean {
  const path = roomFile(home, roomId, "inbox.jsonl");
  return withLock(path, () => {
    if (readInbox(home, roomId).some((e) => e.id === entry.id)) return false;
    appendFileSync(path, JSON.stringify(inboxEntrySchema.parse(entry)) + "\n", { mode: PRIVATE_FILE_MODE });
    return true;
  });
}

export function readOutbox(home: string, roomId: string): OutboxEntry[] {
  return readLines(roomFile(home, roomId, "outbox.jsonl")).flatMap((v) => {
    const p = outboxEntrySchema.safeParse(v);
    return p.success ? [p.data] : [];
  });
}

/** Read-modify-write of the outbox under its lock; keeps only the newest delivered entries. */
export function updateOutbox(home: string, roomId: string, change: (entries: OutboxEntry[]) => OutboxEntry[]): OutboxEntry[] {
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

export const unacked = (entries: readonly OutboxEntry[]) => entries.filter((e) => e.status !== "delivered");

const deliveredSchema = z.strictObject({
  ids: z.array(z.string()),
  released: z.array(z.string()).optional(),
  dropped: z.array(z.string()).optional(),
});

/**
 * delivered.json (04 §3): `ids` shown to the agent (or dropped), and hold mode's `released`
 * and `dropped` ids (04 §5, Hold mode).
 */
export interface DeliveryLedger {
  ids: Set<string>;
  released: Set<string>;
  dropped: Set<string>;
}

export function readLedger(home: string, roomId: string): DeliveryLedger {
  try {
    const v = deliveredSchema.parse(JSON.parse(readFileSync(roomFile(home, roomId, "delivered.json"), "utf8")));
    return { ids: new Set(v.ids), released: new Set(v.released), dropped: new Set(v.dropped) };
  } catch {
    // missing, or corrupt: worst case the agent sees an item twice; held items stay held
    return { ids: new Set(), released: new Set(), dropped: new Set() };
  }
}

function writeLedger(path: string, l: DeliveryLedger): void {
  writeFileAtomic(path, JSON.stringify({ ids: [...l.ids], released: [...l.released], dropped: [...l.dropped] }) + "\n");
}

/** Read-modify-write of delivered.json under its lock. */
function withLedger<T>(home: string, roomId: string, fn: (l: DeliveryLedger, save: () => void) => T): T {
  const path = roomFile(home, roomId, "delivered.json");
  return withLock(path, () => {
    const l = readLedger(home, roomId);
    return fn(l, () => writeLedger(path, l));
  });
}

/** Ids of inbox entries already shown to the agent (04 §3). */
export function readDelivered(home: string, roomId: string): Set<string> {
  return readLedger(home, roomId).ids;
}

export function markDelivered(home: string, roomId: string, ids: readonly string[]): void {
  if (ids.length === 0) return;
  withLedger(home, roomId, (l, save) => {
    for (const id of ids) l.ids.add(id);
    save();
  });
}

/** A peer message the human hasn't released yet, in hold mode (04 §5, Hold mode). */
function isHeld(e: InboxEntry, l: DeliveryLedger, hold: boolean): boolean {
  return hold && e.source === "peer" && !l.ids.has(e.id) && !l.released.has(e.id);
}

export interface InboxCounts {
  /** Unread peer messages the agent may see. */
  messages: number;
  /** Unread local notices. */
  notices: number;
  /** Peer messages waiting for the human's /pairwire:accept. */
  held: number;
}

export function inboxCounts(home: string, roomId: string, hold: boolean): InboxCounts {
  const l = readLedger(home, roomId);
  const counts: InboxCounts = { messages: 0, notices: 0, held: 0 };
  for (const e of readInbox(home, roomId)) {
    if (l.ids.has(e.id)) continue;
    if (isHeld(e, l, hold)) counts.held++;
    else if (e.source === "peer") counts.messages++;
    else counts.notices++;
  }
  return counts;
}

/**
 * Atomically picks undelivered items to show and marks exactly those delivered, under the
 * delivered.json lock, so two delivery paths (a hook and the inbox tool) never show one item
 * twice. Held messages are never offered to `pick` (04 §5, Hold mode). `pick` returns the ids
 * it rendered.
 */
export function claimUndelivered<T>(
  home: string,
  roomId: string,
  opts: { hold: boolean },
  pick: (items: InboxEntry[]) => { ids: readonly string[]; result: T },
): T {
  return withLedger(home, roomId, (l, save) => {
    const { ids, result } = pick(readInbox(home, roomId).filter((e) => !l.ids.has(e.id) && !isHeld(e, l, opts.hold)));
    if (ids.length > 0) {
      for (const id of ids) l.ids.add(id);
      save();
    }
    return result;
  });
}

/**
 * Held messages (as if hold mode were on), and the unread `held` notices about them: once the
 * human has acted on the messages, those notices are stale and are retired with them.
 */
function heldAndNotices(home: string, roomId: string, l: DeliveryLedger): { held: InboxEntry[]; notices: string[] } {
  const inbox = readInbox(home, roomId);
  return {
    held: inbox.filter((e) => isHeld(e, l, true)),
    notices: inbox.filter((e) => e.source === "local" && e.event === "held" && !l.ids.has(e.id)).map((e) => e.id),
  };
}

/**
 * /pairwire:accept (04 §5, §8): releases every message that would be held with hold mode on,
 * under the delivered.json lock. `pick` sees the released messages, oldest first, and returns
 * the ids it showed to the agent, which are marked delivered in the same step, as are unread
 * `held` notices; the rest reach the agent by the normal paths. Returns the released messages
 * and pick's result.
 */
export function releaseHeld<T>(
  home: string,
  roomId: string,
  pick: (released: InboxEntry[]) => { ids: readonly string[]; result: T },
): { released: InboxEntry[]; result: T } {
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

/**
 * /pairwire:accept drop: no path ever shows these messages, and unread `held` notices are
 * retired in the same step. Returns the dropped messages.
 */
export function dropHeld(home: string, roomId: string): InboxEntry[] {
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

/** Peer message ids whose bodies /pairwire:log must not show (04 §8): held and dropped ones. */
export function hiddenBodies(home: string, roomId: string, hold: boolean): Map<string, "held" | "dropped"> {
  const l = readLedger(home, roomId);
  const out = new Map<string, "held" | "dropped">();
  for (const e of readInbox(home, roomId)) if (isHeld(e, l, hold)) out.set(e.id, "held");
  for (const id of l.dropped) out.set(id, "dropped");
  return out;
}

/** The renderer's view of an inbox entry (core render.ts). */
export function toRenderItem(e: InboxEntry): RenderItem {
  if (e.source === "local") return { source: "local", id: e.id, event: e.event, text: e.text };
  return { source: "peer", id: e.id, from: e.from, harness: e.harness, receivedAt: new Date(e.received_at).toISOString(), envelope: e.envelope };
}
