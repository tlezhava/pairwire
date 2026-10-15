// inbox.jsonl and outbox.jsonl of a room (04 §3, ADR-019).
import { appendFileSync, readFileSync } from "node:fs";
import { envelopeSchema } from "@pairwire/core";
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
