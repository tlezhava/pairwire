// Spike S8: records exactly what a command's ! line passed in. Never evaluates anything.
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "out");
mkdirSync(out, { recursive: true });
const [label, ...args] = process.argv.slice(2);
let stdin = "";
if (!process.stdin.isTTY) {
  try {
    stdin = await new Promise((resolve) => {
      let s = "";
      process.stdin.on("data", (c) => (s += c));
      process.stdin.on("end", () => resolve(s));
      setTimeout(() => resolve(s), 500);
    });
  } catch {}
}
const rec = { t: new Date().toISOString(), label, args, stdin, cwd: process.cwd(), pluginRoot: process.env.CLAUDE_PLUGIN_ROOT ?? null };
appendFileSync(join(out, "calls.jsonl"), JSON.stringify(rec) + "\n");
process.stdout.write(`RECORDED ${label} args=${JSON.stringify(args)} stdin=${JSON.stringify(stdin)}\n`);
