// INV-2 static check (07-testing.md): modules on the inbound path, from decryption to
// rendering, must never reach anything that can run a process or change configuration or
// permissions. Walks the relative-import graph from each inbound module.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

/** Where peer bytes travel: decrypt, envelope, inbox, transcript, render. */
export const INBOUND_MODULES = [
  "packages/core/src/envelope.ts",
  "packages/core/src/handshake.ts",
  "packages/core/src/render.ts",
  "packages/core/src/sanitize.ts",
  "packages/client/src/connection.ts",
  "packages/client/src/room-files.ts",
  "packages/client/src/transcript.ts",
];

/** Node modules that can start processes or evaluate code. */
const FORBIDDEN_BUILTINS = new Set(["child_process", "vm", "worker_threads", "cluster"]);
/** Client modules that spawn processes, write config, or act for the human. */
const FORBIDDEN_MODULES = new Set(
  ["config.ts", "ctl.ts", "doctor.ts", "mcp.ts", "session.ts", "main.ts", "install.ts"].map((f) => `packages/client/src/${f}`),
);

const IMPORT = /(?:^|\n)\s*(?:import|export)\s[^;]*?from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|^\s*import\s*["']([^"']+)["']/gm;

export interface Violation {
  from: string;
  chain: string[];
  forbidden: string;
}

export function checkInboundImports(root: string): Violation[] {
  const violations: Violation[] = [];
  for (const entry of INBOUND_MODULES) {
    const seen = new Set<string>();
    const walk = (file: string, chain: string[]) => {
      if (seen.has(file)) return;
      seen.add(file);
      const rel = relative(root, file);
      if (FORBIDDEN_MODULES.has(rel)) {
        violations.push({ from: entry, chain, forbidden: rel });
        return;
      }
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(IMPORT)) {
        const spec = m[1] ?? m[2] ?? m[3]!;
        const bare = spec.replace(/^node:/, "");
        if (FORBIDDEN_BUILTINS.has(bare)) {
          violations.push({ from: entry, chain: [...chain, rel], forbidden: spec });
          continue;
        }
        if (spec === "@pairwire/core") {
          walk(join(root, "packages/core/src/index.ts"), [...chain, rel]);
          continue;
        }
        if (!spec.startsWith(".")) continue; // other packages: ws, zod, noble, ulid
        const target = resolve(dirname(file), spec.replace(/\.js$/, ".ts"));
        if (existsSync(target)) walk(target, [...chain, rel]);
      }
    };
    walk(join(root, entry), []);
  }
  return violations;
}
