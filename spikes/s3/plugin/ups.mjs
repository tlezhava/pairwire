// Spike S3: logs UserPromptSubmit input, to tell a human prompt from a rewake turn.
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "out");
mkdirSync(out, { recursive: true });
let raw = "";
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  let input = {};
  try {
    input = JSON.parse(raw);
  } catch {}
  appendFileSync(
    join(out, "waiters.jsonl"),
    JSON.stringify({ t: new Date().toISOString(), event: "user-prompt", keys: Object.keys(input), prompt: String(input.prompt ?? "").slice(0, 300) }) + "\n",
  );
  process.exit(0);
});
