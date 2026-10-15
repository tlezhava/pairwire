// Spike S1/S2/S6 helpers. Throwaway code: never imported by product code.
import { appendFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "out");
mkdirSync(OUT, { recursive: true });

// Values are recorded only for these keys, and never for anything that looks secret.
const SHOW = /^(CLAUDE|PAIRWIRE|MCP|PWD$|OLDPWD$|HOME$|SHELL$|TERM_PROGRAM|NODE_|ENABLE_|DISABLE_)/;
const HIDE = /KEY|TOKEN|SECRET|PASS|AUTH|COOKIE|CREDENTIAL/i;

export function safeEnv() {
  const values = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (SHOW.test(k) && !HIDE.test(k)) values[k] = v;
  }
  return { values, keys: Object.keys(process.env).sort() };
}

// Ancestor chain [{pid, ppid, comm}] from this process up to pid 1, using one `ps` call.
export function ancestors() {
  try {
    const rows = execFileSync("ps", ["-A", "-o", "pid=,ppid=,comm="], { encoding: "utf8" })
      .split("\n")
      .map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
      .filter(Boolean)
      .map((m) => ({ pid: +m[1], ppid: +m[2], comm: m[3] }));
    const byPid = new Map(rows.map((r) => [r.pid, r]));
    const chain = [];
    let cur = byPid.get(process.pid);
    while (cur && chain.length < 30) {
      chain.push(cur);
      if (cur.pid <= 1) break;
      cur = byPid.get(cur.ppid);
    }
    return chain;
  } catch (e) {
    return [{ error: String(e) }];
  }
}

export function proc() {
  return { pid: process.pid, ppid: process.ppid, cwd: process.cwd(), ancestors: ancestors(), env: safeEnv() };
}

export function append(file, obj) {
  appendFileSync(join(OUT, file), JSON.stringify({ t: new Date().toISOString(), ...obj }) + "\n");
}

export const rand = () => Math.random().toString(36).slice(2, 6);
