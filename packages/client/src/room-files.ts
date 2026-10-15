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
    event: z.enum(["peer_joined", "peer_left", "peer_changed", "wrong_key"]),
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

const deliveredSchema = z.strictObject({ ids: z.array(z.string()) });

/** Ids of inbox entries already shown to the agent (04 §3). */
export function readDelivered(home: string, roomId: string): Set<string> {
  try {
    return new Set(deliveredSchema.parse(JSON.parse(readFileSync(roomFile(home, roomId, "delivered.json"), "utf8"))).ids);
  } catch (e) {
    if (errorCode(e) === "ENOENT") return new Set();
    return new Set(); // corrupt: worst case the agent sees an item twice
  }
}

export function markDelivered(home: string, roomId: string, ids: readonly string[]): void {
  if (ids.length === 0) return;
  const path = roomFile(home, roomId, "delivered.json");
  withLock(path, () => {
    const all = readDelivered(home, roomId);
    for (const id of ids) all.add(id);
    writeFileAtomic(path, JSON.stringify({ ids: [...all] }) + "\n");
  });
}

/** Inbox entries the agent hasn't seen yet, oldest first. */
export function undelivered(home: string, roomId: string): InboxEntry[] {
  const seen = readDelivered(home, roomId);
  return readInbox(home, roomId).filter((e) => !seen.has(e.id));
}

/**
 * Atomically picks undelivered items to show and marks exactly those delivered, under the
 * delivered.json lock, so two delivery paths (a hook and the inbox tool) never show one item
 * twice. `pick` returns the ids it rendered.
 */
export function claimUndelivered<T>(home: string, roomId: string, pick: (items: InboxEntry[]) => { ids: readonly string[]; result: T }): T {
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

/** The renderer's view of an inbox entry (core render.ts). */
export function toRenderItem(e: InboxEntry): RenderItem {
  if (e.source === "local") return { source: "local", id: e.id, event: e.event, text: e.text };
  return { source: "peer", id: e.id, from: e.from, harness: e.harness, receivedAt: new Date(e.received_at).toISOString(), envelope: e.envelope };
}
