// Client logger (04 §1, Logging; INV-7). JSON lines; every string value passes through core's
// redact(), and fields with sensitive names are dropped whatever their value. Never throws.
import { appendFileSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { redact } from "@pairwire/core";
import { ensurePrivateDir, PRIVATE_FILE_MODE } from "./fs-util.js";
import { hookErrorsPath } from "./paths.js";

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export type LogValue = string | number | boolean | null | undefined;
export type LogFields = Record<string, LogValue>;
export type LogSink = (line: string) => void;

export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, err?: unknown, fields?: LogFields): void;
}

/** Raw keys and member tokens look like random text no scanner can recognize, so names decide. */
const SENSITIVE_NAME = /secret|token|key|psk|share|password/i;
const RESERVED = new Set(["t", "level", "event"]);
/** hook-errors.log is moved to hook-errors.log.1 above this size. */
export const HOOK_LOG_MAX_BYTES = 1024 * 1024;

export function parseLogLevel(value: string | undefined): LogLevel {
  const v = value?.trim().toLowerCase();
  return (LOG_LEVELS as readonly string[]).includes(v ?? "") ? (v as LogLevel) : "info";
}

/** Correlation tag for a room: the first 4 hex characters of SHA-256(room_id), as in the relays. */
export function roomTag(roomId: string): string {
  return bytesToHex(sha256(utf8ToBytes(roomId))).slice(0, 4);
}

function clean(name: string, value: LogValue): LogValue {
  if (SENSITIVE_NAME.test(name)) return "[redacted]";
  if (typeof value === "string") return redact(value);
  if (value === null || value === undefined || typeof value === "number" || typeof value === "boolean") return value;
  return "[unsupported]";
}

function errorFields(err: unknown): LogFields {
  if (err === undefined) return {};
  if (!(err instanceof Error)) return { error_message: String(err) };
  const code = (err as { code?: unknown }).code;
  return {
    error_name: err.name,
    error_code: typeof code === "string" || typeof code === "number" ? code : undefined,
    error_message: err.message,
    error_stack: err.stack,
  };
}

export interface LoggerOptions {
  sink?: LogSink;
  level?: LogLevel;
  now?: () => Date;
}

export const stderrSink: LogSink = (line) => {
  process.stderr.write(line + "\n");
};

export function createLogger(options: LoggerOptions = {}): Logger {
  const sink = options.sink ?? stderrSink;
  const min = LOG_LEVELS.indexOf(options.level ?? parseLogLevel(process.env.PAIRWIRE_LOG));
  const now = options.now ?? (() => new Date());

  const write = (level: LogLevel, event: string, fields: LogFields = {}) => {
    if (LOG_LEVELS.indexOf(level) < min) return;
    try {
      const line: Record<string, LogValue> = { t: now().toISOString(), level, event: redact(event) };
      for (const [name, value] of Object.entries(fields)) {
        if (!RESERVED.has(name) && value !== undefined) line[name] = clean(name, value);
      }
      sink(JSON.stringify(line));
    } catch {
      // logging must never break the client or a hook
    }
  };

  return {
    debug: (event, fields) => write("debug", event, fields),
    info: (event, fields) => write("info", event, fields),
    warn: (event, fields) => write("warn", event, fields),
    error: (event, err, fields) => write("error", event, { ...fields, ...errorFields(err) }),
  };
}

/** Appends lines to a 0600 file, moving it to `<path>.1` once it exceeds `maxBytes`. Never throws. */
export function fileSink(path: string, maxBytes = HOOK_LOG_MAX_BYTES): LogSink {
  return (line) => {
    try {
      ensurePrivateDir(dirname(path));
      try {
        if (statSync(path).size > maxBytes) renameSync(path, `${path}.1`);
      } catch {
        // no file yet
      }
      appendFileSync(path, line + "\n", { mode: PRIVATE_FILE_MODE });
    } catch {
      // nowhere left to report it
    }
  };
}

/** The hooks' logger: errors only, to `<home>/hook-errors.log` (04 §6). */
export function hookErrorLogger(home: string): Logger {
  return createLogger({ sink: fileSink(hookErrorsPath(home)), level: "error" });
}
