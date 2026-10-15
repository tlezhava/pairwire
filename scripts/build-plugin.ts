// `npm run build:plugin` (04 §9): bundles the client into plugins/claude-code/dist/pairwire.mjs
// and generates the skill from specs/06-agent-guide.md section 2. The output is committed, and
// CI fails when it differs from a fresh build, so it must be deterministic.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("..", import.meta.url));
const plugin = join(root, "plugins/claude-code");

/** The fenced ````markdown block of 06 §2 is SKILL.md verbatim (06 §1). */
export function extractSkill(guide: string): string {
  const section = guide.slice(guide.indexOf("## 2. SKILL.md"));
  const m = section.match(/````markdown\n([\s\S]*?)\n````/);
  if (!m) throw new Error("06-agent-guide.md: no ````markdown block in section 2");
  return m[1]! + "\n";
}

async function main(): Promise<void> {
  rmSync(join(plugin, "dist"), { recursive: true, force: true });
  await build({
    entryPoints: { pairwire: join(root, "packages/client/src/main.ts") },
    outdir: join(plugin, "dist"),
    outExtension: { ".js": ".mjs" },
    // Each subcommand is its own chunk (main.ts imports them lazily), so hooks skip the MCP SDK.
    splitting: true,
    chunkNames: "chunks/[name]-[hash]",
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    conditions: ["source"],
    // ws loads these optional native helpers in a try/catch.
    external: ["bufferutil", "utf-8-validate"],
    // Bundled CommonJS (ws, ajv) calls require() for Node built-ins.
    banner: { js: 'import { createRequire as __pwCreateRequire } from "node:module";\nconst require = __pwCreateRequire(import.meta.url);' },
    legalComments: "eof",
    logLevel: "warning",
  });
  const skill = extractSkill(readFileSync(join(root, "specs/06-agent-guide.md"), "utf8"));
  mkdirSync(join(plugin, "skills/pairwire"), { recursive: true });
  writeFileSync(
    join(plugin, "skills/pairwire/SKILL.md"),
    skill.replace(/^(---\n[\s\S]*?\n---\n)/, "$1\n<!-- Generated from specs/06-agent-guide.md section 2 by npm run build:plugin. Do not edit. -->\n"),
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
