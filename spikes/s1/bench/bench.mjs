// p50/p95 wall time of 50 cold spawns per variant, stdin = a typical hook payload.
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const input = JSON.stringify({ session_id: "x", hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "ls" }, tool_response: { stdout: "a\n".repeat(200) } });
const empty = mkdtempSync(join(tmpdir(), "pwb-"));
const active = mkdtempSync(join(tmpdir(), "pwb-")); writeFileSync(join(active, "active"), "");
const variants = {
  "node noop.mjs": ["node", [join(here, "noop.mjs")], {}],
  "sh run.sh (no active room)": ["sh", [join(here, "run.sh")], { PAIRWIRE_HOME: empty }],
  "sh run.sh (active room -> node)": ["sh", [join(here, "run.sh")], { PAIRWIRE_HOME: active }],
};
const pct = (a, p) => a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))];
for (const [name, [cmd, args, env]] of Object.entries(variants)) {
  spawnSync(cmd, args, { input, env: { ...process.env, ...env } }); // warm the FS cache once
  const ms = [];
  for (let i = 0; i < 50; i++) {
    const t = process.hrtime.bigint();
    const r = spawnSync(cmd, args, { input, env: { ...process.env, ...env } });
    ms.push(Number(process.hrtime.bigint() - t) / 1e6);
    if (r.status !== 0) throw new Error(`${name} exited ${r.status}`);
  }
  ms.sort((a, b) => a - b);
  console.log(`${name.padEnd(34)} p50 ${pct(ms, 50).toFixed(1).padStart(6)} ms   p95 ${pct(ms, 95).toFixed(1).padStart(6)} ms   max ${ms.at(-1).toFixed(1)} ms`);
}
console.log(`node ${process.version}, ${process.platform}/${process.arch}`);
