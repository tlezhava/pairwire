import { createRequire as __pwCreateRequire } from "node:module";
const require = __pwCreateRequire(import.meta.url);
import {
  ANONYMOUS,
  errorCode,
  external_exports,
  formatRelayAddress,
  parseRelayAddress
} from "./chunk-H4ULF7HQ.mjs";
import {
  configPath
} from "./chunk-A6UKVX6D.mjs";

// packages/client/src/config.ts
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
var DEFAULT_CONFIG = {
  name: null,
  relay: null,
  autoContinue: true,
  hopBudget: 8,
  delivery: "auto",
  channels: false
};
var fileSchema = external_exports.object({
  name: external_exports.string().trim().min(1).max(200).optional(),
  relay: external_exports.string().optional(),
  auto_continue: external_exports.boolean().optional(),
  hop_budget: external_exports.number().int().min(1).max(1e3).optional(),
  delivery: external_exports.enum(["auto", "pull"]).optional(),
  channels: external_exports.boolean().optional()
});
var KNOWN_KEYS = new Set(Object.keys(fileSchema.shape));
var ConfigError = class extends Error {
  name = "ConfigError";
};
function loadConfig(home, env = process.env) {
  const path = configPath(home);
  const warnings = [];
  let raw = {};
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    if (errorCode(e) !== "ENOENT") {
      throw new ConfigError(e instanceof SyntaxError ? `${path} is not valid JSON.` : `Cannot read ${path}.`);
    }
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new ConfigError(`${path} must contain a JSON object.`);
  for (const key of Object.keys(raw)) if (!KNOWN_KEYS.has(key)) warnings.push(`${path}: unknown key "${key}" ignored.`);
  const parsed = fileSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ConfigError(`${path}: "${issue.path.join(".")}" ${issue.message.toLowerCase()}.`);
  }
  const file = parsed.data;
  const config = {
    name: env.PAIRWIRE_NAME?.trim() || file.name || null,
    relay: normalizeRelay(env.PAIRWIRE_RELAY || file.relay, env.PAIRWIRE_RELAY ? "PAIRWIRE_RELAY" : `${path}: "relay"`),
    autoContinue: file.auto_continue ?? DEFAULT_CONFIG.autoContinue,
    hopBudget: file.hop_budget ?? DEFAULT_CONFIG.hopBudget,
    delivery: env.PAIRWIRE_DELIVERY ? parseDelivery(env.PAIRWIRE_DELIVERY) : file.delivery ?? DEFAULT_CONFIG.delivery,
    channels: env.PAIRWIRE_CHANNELS ? parseFlag(env.PAIRWIRE_CHANNELS, "PAIRWIRE_CHANNELS") : file.channels ?? DEFAULT_CONFIG.channels
  };
  return { config, warnings };
}
function normalizeRelay(value, where) {
  if (!value?.trim()) return null;
  try {
    return formatRelayAddress(parseRelayAddress(value));
  } catch (e) {
    throw new ConfigError(`${where}: ${e.message}`);
  }
}
function parseDelivery(value) {
  const v = value.trim().toLowerCase();
  if (v === "auto" || v === "pull") return v;
  throw new ConfigError('PAIRWIRE_DELIVERY must be "auto" or "pull".');
}
function parseFlag(value, name) {
  const v = value.trim().toLowerCase();
  if (v === "1" || v === "true") return true;
  if (v === "0" || v === "false") return false;
  throw new ConfigError(`${name} must be 1, 0, true or false.`);
}
function resolveDisplayName(config, cwd, env = process.env) {
  if (config.name) return config.name;
  try {
    const git = spawnSync("git", ["config", "user.name"], { cwd, env, encoding: "utf8", timeout: 2e3, stdio: ["ignore", "pipe", "ignore"] });
    const name = git.status === 0 ? git.stdout.trim() : "";
    if (name) return name;
  } catch {
  }
  return env.USER?.trim() || env.USERNAME?.trim() || ANONYMOUS;
}

export {
  DEFAULT_CONFIG,
  loadConfig,
  resolveDisplayName
};
