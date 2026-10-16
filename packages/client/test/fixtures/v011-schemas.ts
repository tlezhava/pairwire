// 0.1.1's outbox schemas, copied from tag v0.1.1 (packages/core/src/envelope.ts and
// packages/client/src/room-files.ts), so tests can check that what an M5 client writes is
// still readable by a user who goes back to 0.1.1 in an open room (ADR-027, ADR-028).
import { z } from "zod";

const KINDS = ["chat", "question", "answer", "ack", "bye"] as const;
const ulid = z.string().regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
const counter = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const millis = z.number().int().min(0);

export const v011EnvelopeSchema = z
  .strictObject({
    v: z.literal(1),
    id: ulid,
    seq: counter,
    ts: z.iso.datetime(),
    author: z.enum(["agent", "human"]),
    kind: z.enum(KINDS),
    reply_to: ulid.nullable(),
    body: z.string().nullable(),
    acks: counter.nullable(),
  })
  .superRefine((env, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: "custom", message });
    if (env.kind === "ack") {
      if (env.seq !== 0) issue("ack must have seq 0");
      if (env.acks === null) issue("ack requires acks");
      if (env.body !== null) issue("ack has no body");
      if (env.reply_to !== null) issue("ack has no reply_to");
      return;
    }
    if (env.seq < 1) issue("seq starts at 1");
    if (env.acks !== null) issue("acks is only for ack");
    if (env.kind !== "bye" && (env.body === null || env.body === "")) issue(`${env.kind} requires a body`);
    if (env.kind === "answer" && env.reply_to === null) issue("answer requires reply_to");
  });

export const v011OutboxEntrySchema = z.strictObject({
  envelope: v011EnvelopeSchema,
  status: z.enum(["queued", "sent", "delivered"]),
  sent_at: millis.nullable(),
  delivered_at: millis.nullable(),
});
