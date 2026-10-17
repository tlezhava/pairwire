// Spike S10 recorder. Modes:
//   ups    UserPromptSubmit hook: logs the prompt it sees; for /s10:verify writes a grant file and
//          shows the human a code via systemMessage (the agent must not see it).
//   bang   run from the command's `!` block: logs whether the grant exists and its age, and TTYs.
//   agent  run by the agent's Bash tool: logs TTYs.
//   human  run by the human in a real terminal: logs TTYs.
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "out");
mkdirSync(out, { recursive: true });
const grant = join(out, "grant.json");
const mode = process.argv[2] ?? "unknown";
const now = Date.now();
const tty = { stdin: !!process.stdin.isTTY, stdout: !!process.stdout.isTTY, stderr: !!process.stderr.isTTY };
const log = (rec) => appendFileSync(join(out, "events.jsonl"), JSON.stringify({ t: new Date(now).toISOString(), ms: now, mode, pid: process.pid, ppid: process.ppid, tty, ...rec }) + "\n");

if (mode === "ups") {
  let input = "";
  process.stdin.on("data", (d) => (input += d));
  process.stdin.on("end", () => {
    let prompt = "";
    let session = "";
    try {
      const j = JSON.parse(input);
      prompt = String(j.prompt ?? "");
      session = String(j.session_id ?? "");
    } catch {}
    const isVerify = /s10:verify/.test(prompt);
    log({ prompt: prompt.slice(0, 300), session, isVerify });
    if (isVerify) {
      const code = String(100000 + Math.floor(Math.random() * 900000));
      writeFileSync(grant, JSON.stringify({ ms: now, code, session }));
      process.stdout.write(JSON.stringify({ systemMessage: `S10 CODE FOR THE HUMAN ONLY: ${code.slice(0, 3)} ${code.slice(3)}` }));
    }
  });
} else if (mode === "bang") {
  const g = existsSync(grant) ? JSON.parse(readFileSync(grant, "utf8")) : null;
  log({ grantSeen: !!g, grantAgeMs: g ? now - g.ms : null });
  process.stdout.write(`S10-BANG ran: grant ${g ? `seen (written ${now - g.ms} ms earlier)` : "NOT seen"}; stdin tty=${tty.stdin}, stdout tty=${tty.stdout}\n`);
} else {
  const g = existsSync(grant) ? statSync(grant).mtimeMs : null;
  log({ grantExists: g !== null });
  process.stdout.write(`S10 ${mode}: stdin tty=${tty.stdin}, stdout tty=${tty.stdout}, stderr tty=${tty.stderr}\n`);
}
