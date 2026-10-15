// Client configuration (04 §2): ~/.pairwire/config.json, overridden by environment variables.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { ANONYMOUS, formatRelayAddress, parseRelayAddress } from "@pairwire/core";
import { z } from "zod";
import { errorCode } from "./fs-util.js";
import { configPath } from "./paths.js";
export const DEFAULT_CONFIG = {
    name: null,
    relay: null,
    autoContinue: true,
    hopBudget: 8,
    delivery: "auto",
    channels: false,
};
const fileSchema = z.object({
    name: z.string().trim().min(1).max(200).optional(),
    relay: z.string().optional(),
    auto_continue: z.boolean().optional(),
    hop_budget: z.number().int().min(1).max(1000).optional(),
    delivery: z.enum(["auto", "pull"]).optional(),
    channels: z.boolean().optional(),
});
const KNOWN_KEYS = new Set(Object.keys(fileSchema.shape));
export class ConfigError extends Error {
    name = "ConfigError";
}
/** Reads `<home>/config.json` (all keys optional) and applies the environment overrides. */
export function loadConfig(home, env = process.env) {
    const path = configPath(home);
    const warnings = [];
    let raw = {};
    try {
        raw = JSON.parse(readFileSync(path, "utf8"));
    }
    catch (e) {
        if (errorCode(e) !== "ENOENT") {
            throw new ConfigError(e instanceof SyntaxError ? `${path} is not valid JSON.` : `Cannot read ${path}.`);
        }
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw))
        throw new ConfigError(`${path} must contain a JSON object.`);
    for (const key of Object.keys(raw))
        if (!KNOWN_KEYS.has(key))
            warnings.push(`${path}: unknown key "${key}" ignored.`);
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
        delivery: env.PAIRWIRE_DELIVERY ? parseDelivery(env.PAIRWIRE_DELIVERY) : (file.delivery ?? DEFAULT_CONFIG.delivery),
        channels: env.PAIRWIRE_CHANNELS ? parseFlag(env.PAIRWIRE_CHANNELS, "PAIRWIRE_CHANNELS") : (file.channels ?? DEFAULT_CONFIG.channels),
    };
    return { config, warnings };
}
function normalizeRelay(value, where) {
    if (!value?.trim())
        return null;
    try {
        return formatRelayAddress(parseRelayAddress(value));
    }
    catch (e) {
        throw new ConfigError(`${where}: ${e.message}`);
    }
}
function parseDelivery(value) {
    const v = value.trim().toLowerCase();
    if (v === "auto" || v === "pull")
        return v;
    throw new ConfigError('PAIRWIRE_DELIVERY must be "auto" or "pull".');
}
function parseFlag(value, name) {
    const v = value.trim().toLowerCase();
    if (v === "1" || v === "true")
        return true;
    if (v === "0" || v === "false")
        return false;
    throw new ConfigError(`${name} must be 1, 0, true or false.`);
}
/** The configured name, else `git config user.name`, else `$USER`, else "anonymous". */
export function resolveDisplayName(config, cwd, env = process.env) {
    if (config.name)
        return config.name;
    try {
        const git = spawnSync("git", ["config", "user.name"], { cwd, env, encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] });
        const name = git.status === 0 ? git.stdout.trim() : "";
        if (name)
            return name;
    }
    catch {
        // git missing: fall through
    }
    return env.USER?.trim() || env.USERNAME?.trim() || ANONYMOUS;
}
//# sourceMappingURL=config.js.map