// Spike S3: started by the Stop hook as an asyncRewake hook. Waits until /tmp/pw-s3/WAKE
// exists, then exits 2 with a message on stderr (which should wake the session).
// Exits 0 after LIMIT_S without a trigger. Logs its lifecycle to ../out/waiters.jsonl.
import { appendFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "out");
mkdirSync(out, { recursive: true });
const TRIGGER = "/tmp/pw-s3/WAKE";
const LIMIT_S = Number(process.argv[2] ?? 900); // 0 = wait forever
const log = (event, extra = {}) =>
  appendFileSync(join(out, "waiters.jsonl"), JSON.stringify({ t: new Date().toISOString(), pid: process.pid, ppid: process.ppid, event, ...extra }) + "\n");

let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  let sid = "?";
  try {
    sid = JSON.parse(input).session_id;
  } catch {}
  log("armed", { sid, limit_s: LIMIT_S });
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    process.on(sig, () => {
      log("signal", { sig });
      process.exit(0);
    });
  }
  const started = Date.now();
  const timer = setInterval(() => {
    if (existsSync(TRIGGER)) {
      clearInterval(timer);
      rmSync(TRIGGER, { force: true });
      log("woke");
      process.stderr.write(`S3-WAKE: a pairwire message arrived at ${new Date().toISOString()}. Tell the user the canary S3-WAKE-OK.\n`);
      process.exit(2);
    }
    if (LIMIT_S > 0 && Date.now() - started > LIMIT_S * 1000) {
      clearInterval(timer);
      log("timeout");
      process.exit(0);
    }
  }, 200);
});
