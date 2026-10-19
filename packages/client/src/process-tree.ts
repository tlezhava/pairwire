// Does this hook run in the harness that started the owning MCP server? (04 §10, ADR-033.) Only
// hooks import this module: it can run `ps`, which no inbound-path module may reach (INV-2).
import { execFileSync } from "node:child_process";

/** How far up the hook's ancestry the `ps` fallback looks. */
export const ANCESTOR_LEVELS = 4;

export interface HookProcess {
  env: NodeJS.ProcessEnv;
  /** The hook process's parent; default process.ppid. */
  ppid?: number;
  platform?: NodeJS.Platform;
  /** pid → parent pid for every process, or null when it can't be listed; default `ps`. */
  processTable?: () => Map<number, number> | null;
}

const PID = /^[1-9][0-9]{0,9}$/;

/**
 * Whether `harnessPid` is the hook's harness: `PAIRWIRE_HOOK_PPID` (run.sh's parent) or the
 * hook's own parent equals it, or, on macOS and Linux only and only when both differ, it is
 * among the hook's first ANCESTOR_LEVELS ancestors. Windows never runs `ps`.
 */
export function isHarnessProcess(harnessPid: number, p: HookProcess): boolean {
  const ppid = p.ppid ?? process.ppid;
  const given = p.env.PAIRWIRE_HOOK_PPID?.trim() ?? "";
  if (harnessPid === ppid || (PID.test(given) && Number(given) === harnessPid)) return true;
  if ((p.platform ?? process.platform) === "win32") return false;
  const table = (p.processTable ?? psTable)();
  if (!table) return false;
  let pid: number | undefined = ppid;
  for (let level = 1; level <= ANCESTOR_LEVELS && pid !== undefined && pid > 1; level++) {
    if (pid === harnessPid) return true;
    const parent: number | undefined = table.get(pid);
    pid = parent === pid ? undefined : parent;
  }
  return false;
}

/** One `ps -A` call (POSIX options), 1 s limit; null on any failure. */
function psTable(): Map<number, number> | null {
  try {
    const out = execFileSync("ps", ["-A", "-o", "pid=", "-o", "ppid="], {
      encoding: "utf8",
      timeout: 1000,
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 8 * 1024 * 1024,
    });
    return parseProcessTable(out);
  } catch {
    return null;
  }
}

/** Parses `ps -o pid= -o ppid=` output; lines that aren't two numbers are skipped. */
export function parseProcessTable(text: string): Map<number, number> {
  const table = new Map<number, number>();
  for (const line of text.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (m) table.set(Number(m[1]), Number(m[2]));
  }
  return table;
}
