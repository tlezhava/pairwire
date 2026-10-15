// `pairwire doctor` and `pairwire purge` (04 §1).
import { existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { DEFAULT_RELAY_HOST, displayName, parseRelayAddress, relayUrl } from "@pairwire/core";
import { loadConfig } from "./config.js";
import { activeFlagPath, roomDir } from "./paths.js";
import { checkStatePermissions, StatePermissionError } from "./permissions.js";
import { expiresAt, isOpen, listRooms, readState, refreshActiveFlag } from "./state.js";

export const MIN_NODE_MAJOR = 20;

type Level = "ok" | "warn" | "FAIL";

export interface DoctorOptions {
  home: string;
  env: NodeJS.ProcessEnv;
  out: Writable;
  nodeVersion?: string;
  fetch?: typeof fetch;
  /** Directory of the running bundle (`dist/`), to check plugin wiring. */
  bundleDir?: string | null;
  now?: () => number;
}

/** REQ-INST-4: what to tell the user when Node is missing or too old. */
export function nodeAdvice(version: string | null): string | null {
  const major = version ? Number.parseInt(version.replace(/^v/, ""), 10) : NaN;
  if (major >= MIN_NODE_MAJOR) return null;
  const have = version ? `Node ${version} is installed` : "Node.js was not found";
  return `${have}, but pairwire needs Node ${MIN_NODE_MAJOR} or newer. Install the current LTS from https://nodejs.org (or with your version manager, e.g. \`nvm install --lts\`), then restart your agent session.`;
}

export async function runDoctor(o: DoctorOptions): Promise<number> {
  let failed = false;
  const line = (level: Level, text: string) => {
    if (level === "FAIL") failed = true;
    o.out.write(`${level.padEnd(4)}  ${text}\n`);
  };

  const version = o.nodeVersion ?? process.versions.node;
  const advice = nodeAdvice(version);
  if (advice) line("FAIL", advice);
  else line("ok", `Node ${version}`);

  let relays = new Set<string>();
  try {
    const { config, warnings } = loadConfig(o.home, o.env);
    line("ok", `config: relay ${config.relay ?? `${DEFAULT_RELAY_HOST ?? "(none)"} (default)`}, hop budget ${config.hopBudget}, delivery ${config.delivery}`);
    for (const w of warnings) line("warn", w);
    relays.add(config.relay ?? DEFAULT_RELAY_HOST ?? "");
  } catch (e) {
    line("FAIL", `config: ${(e as Error).message}`);
  }

  const problems = checkStatePermissions(o.home);
  if (problems.length > 0) line("FAIL", new StatePermissionError(o.home, problems).message);
  else line("ok", `state directory ${o.home} is private`);

  const now = (o.now ?? Date.now)();
  const rooms = listRooms(o.home);
  for (const id of rooms) {
    try {
      const s = readState(o.home, id);
      if (!s) continue;
      const peer = s.peer ? `${displayName(s.peer.name)} (${displayName(s.peer.harness)})` : "no peer yet";
      const until = isOpen(s) ? `, expires ${new Date(expiresAt(s)).toISOString()}` : "";
      line(s.error && isOpen(s) ? "warn" : "ok", `room ${id.slice(0, 6)}…: ${s.status}${s.error ? ` (${s.error})` : ""}, ${peer}${until}`);
      if (isOpen(s)) relays.add(s.relay ?? DEFAULT_RELAY_HOST ?? "");
      if (isOpen(s) && now >= expiresAt(s)) line("warn", `room ${id.slice(0, 6)}… is past its expiry; it is removed the next time a session opens it.`);
    } catch (e) {
      line("FAIL", `room ${id.slice(0, 6)}…: ${(e as Error).message}`);
    }
  }
  if (rooms.length === 0) line("ok", "no rooms stored");
  const hadFlag = existsSync(activeFlagPath(o.home));
  if (rooms.length > 0 || hadFlag) {
    const shouldHave = refreshActiveFlag(o.home);
    if (hadFlag !== shouldHave) line("warn", `the "active" flag was ${hadFlag ? "set" : "missing"}; repaired`);
  }

  relays = new Set([...relays].filter(Boolean));
  if (relays.size === 0) line("warn", "no relay configured: set PAIRWIRE_RELAY or relay in config.json");
  for (const host of relays) {
    const result = await checkRelay(host, o.fetch ?? fetch);
    line(result ? "FAIL" : "ok", `relay ${host}${result ? `: ${result}` : " answers /health"}`);
  }

  const bundle = o.bundleDir === undefined ? defaultBundleDir() : o.bundleDir;
  if (bundle) {
    const root = dirname(bundle);
    const missing = ["hooks/run.sh", "hooks/hooks.json"].filter((p) => !existsSync(join(root, p)));
    if (missing.length > 0) line("FAIL", `plugin at ${root} is missing ${missing.join(", ")}; reinstall the plugin`);
    else line("ok", `plugin hooks wired at ${root}`);
  }
  return failed ? 1 : 0;
}

/** null when the relay answers `ok` at /health within 5 s, else what went wrong. */
async function checkRelay(host: string, fetcher: typeof fetch): Promise<string | null> {
  let url: string;
  try {
    url = relayUrl(parseRelayAddress(host)).replace(/^ws/, "http") + "/health";
  } catch (e) {
    return (e as Error).message;
  }
  try {
    const res = await fetcher(url, { signal: AbortSignal.timeout(5000) });
    const body = await res.text();
    return res.ok && body.trim() === "ok" ? null : `unexpected answer (HTTP ${res.status})`;
  } catch (e) {
    return `unreachable (${(e as Error).name === "TimeoutError" ? "timed out" : (e as Error).message})`;
  }
}

/** When running from the plugin bundle (`<plugin>/dist/`, or a chunk in `dist/chunks/`), its `dist/`. */
function defaultBundleDir(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const dir of [here, dirname(here)]) {
    if (dir.endsWith("/dist") && existsSync(join(dir, "..", ".claude-plugin"))) return dir;
  }
  return null;
}

export interface PurgeOptions {
  home: string;
  out: Writable;
  all: boolean;
  force: boolean;
}

export function runPurge(o: PurgeOptions): number {
  const say = (t: string) => o.out.write(`${t}\n`);
  const rooms = listRooms(o.home).map((id) => {
    try {
      return { id, state: readState(o.home, id) };
    } catch {
      return { id, state: null };
    }
  });
  if (o.all) {
    const open = rooms.filter((r) => r.state && isOpen(r.state));
    if (open.length > 0 && !o.force) {
      say(`pairwire purge --all: ${open.length} room(s) still open; leave them first (/pairwire:leave) or add --force to abandon them.`);
      return 1;
    }
    rmSync(o.home, { recursive: true, force: true });
    say(`deleted ${o.home}`);
    return 0;
  }
  let n = 0;
  for (const r of rooms) {
    if (r.state && !isOpen(r.state)) {
      rmSync(roomDir(o.home, r.id), { recursive: true, force: true });
      say(`deleted room ${r.id.slice(0, 6)}… (${r.state.status})`);
      n++;
    }
  }
  if (n === 0) say("nothing to purge: no left or ended rooms");
  return 0;
}
