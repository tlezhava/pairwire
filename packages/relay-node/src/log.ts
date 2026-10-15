// Relay logger (03, Logging): counts and error codes only, never room ids, tokens, IP
// addresses or frame contents. Every line also passes through core's redact().
import { createHash } from "node:crypto";
import { redact } from "@pairwire/core";

export type LogFields = Record<string, string | number | boolean>;
export type LogSink = (line: string) => void;

export interface Logger {
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
}

export function createLogger(sink: LogSink = (line) => process.stderr.write(line + "\n")): Logger {
  const write = (level: string, event: string, fields: LogFields = {}) =>
    sink(redact(JSON.stringify({ t: new Date().toISOString(), level, event, ...fields })));
  return { info: (e, f) => write("info", e, f), warn: (e, f) => write("warn", e, f) };
}

/** Correlation id for a room: the first 4 hex characters of SHA-256(room_id). */
export function roomTag(roomId: string): string {
  return createHash("sha256").update(roomId).digest("hex").slice(0, 4);
}
