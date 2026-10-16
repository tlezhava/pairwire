import { createRequire as __pwCreateRequire } from "node:module";
const require = __pwCreateRequire(import.meta.url);
import {
  PRIVATE_FILE_MODE,
  ensurePrivateDir
} from "./chunk-STXFRAI5.mjs";
import {
  hookErrorsPath
} from "./chunk-GVGSGJLD.mjs";
import {
  redact
} from "./chunk-5TF4YXFP.mjs";

// packages/client/src/log.ts
import { appendFileSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";
var LOG_LEVELS = ["debug", "info", "warn", "error"];
var SENSITIVE_NAME = /secret|token|key|psk|share|password/i;
var RESERVED = /* @__PURE__ */ new Set(["t", "level", "event"]);
var HOOK_LOG_MAX_BYTES = 1024 * 1024;
function parseLogLevel(value) {
  const v = value?.trim().toLowerCase();
  return LOG_LEVELS.includes(v ?? "") ? v : "info";
}
function clean(name, value) {
  if (SENSITIVE_NAME.test(name)) return "[redacted]";
  if (typeof value === "string") return redact(value);
  if (value === null || value === void 0 || typeof value === "number" || typeof value === "boolean") return value;
  return "[unsupported]";
}
function errorFields(err) {
  if (err === void 0) return {};
  if (!(err instanceof Error)) return { error_message: String(err) };
  const code = err.code;
  return {
    error_name: err.name,
    error_code: typeof code === "string" || typeof code === "number" ? code : void 0,
    error_message: err.message,
    error_stack: err.stack
  };
}
var stderrSink = (line) => {
  process.stderr.write(line + "\n");
};
function createLogger(options = {}) {
  const sink = options.sink ?? stderrSink;
  const min = LOG_LEVELS.indexOf(options.level ?? parseLogLevel(process.env.PAIRWIRE_LOG));
  const now = options.now ?? (() => /* @__PURE__ */ new Date());
  const write = (level, event, fields = {}) => {
    if (LOG_LEVELS.indexOf(level) < min) return;
    try {
      const line = { t: now().toISOString(), level, event: redact(event) };
      for (const [name, value] of Object.entries(fields)) {
        if (!RESERVED.has(name) && value !== void 0) line[name] = clean(name, value);
      }
      sink(JSON.stringify(line));
    } catch {
    }
  };
  return {
    debug: (event, fields) => write("debug", event, fields),
    info: (event, fields) => write("info", event, fields),
    warn: (event, fields) => write("warn", event, fields),
    error: (event, err, fields) => write("error", event, { ...fields, ...errorFields(err) })
  };
}
function fileSink(path, maxBytes = HOOK_LOG_MAX_BYTES) {
  return (line) => {
    try {
      ensurePrivateDir(dirname(path));
      try {
        if (statSync(path).size > maxBytes) renameSync(path, `${path}.1`);
      } catch {
      }
      appendFileSync(path, line + "\n", { mode: PRIVATE_FILE_MODE });
    } catch {
    }
  };
}
function hookErrorLogger(home) {
  return createLogger({ sink: fileSink(hookErrorsPath(home)), level: "error" });
}

export {
  createLogger,
  hookErrorLogger
};
