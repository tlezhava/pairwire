// S11 hook recorder: `node hook.mjs <harness> <event>`. Records stdin, env and process facts,
// then answers in the harness's own output format with a canary the agent is asked to repeat.
// `node hook.mjs <harness> bang` is run by the /s11:verify command's shell line instead.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OUT, append, proc } from "./lib.mjs";

const [harness = "unknown", event = "unknown"] = process.argv.slice(2);
const GRANT = join(OUT, "grant.json");

if (event === "bang") {
  let note = "grant NOT seen";
  if (existsSync(GRANT)) {
    const g = JSON.parse(readFileSync(GRANT, "utf8"));
    note = `grant seen (written ${Date.now() - g.ms} ms earlier)`;
  }
  append("events.jsonl", { harness, event, note, ...proc() });
  process.stdout.write(`S11-BANG ran: ${note}; stdin tty=${!!process.stdin.isTTY}, stdout tty=${!!process.stdout.isTTY}\n`);
  process.exit(0);
}

let raw = "";
try {
  raw = readFileSync(0, "utf8");
} catch {
  // no stdin
}
let input = {};
try {
  input = JSON.parse(raw);
} catch {
  input = { unparsed: raw.slice(0, 200) };
}
append("hooks.jsonl", { harness, event, input, ...proc() });

const session = input.session_id ?? input.conversation_id ?? "none";
const prompt = typeof input.prompt === "string" ? input.prompt : "";
const canary = `CANARY-${harness}-${event}`;
const once = (name) => {
  const f = join(OUT, `once-${name}-${String(session).replace(/[^\w-]/g, "_")}`);
  if (existsSync(f)) return false;
  writeFileSync(f, "");
  return true;
};
if (/\/s11:verify/.test(prompt)) writeFileSync(GRANT, JSON.stringify({ ms: Date.now(), session, event }));

let out = {};
if (harness === "gemini") {
  const ctx = (name) => ({ hookSpecificOutput: { hookEventName: name, additionalContext: `[S11] ${canary}: if asked, list every CANARY string you can see.` } });
  if (event === "SessionStart" || event === "AfterTool") out = ctx(event);
  if (event === "BeforeAgent") out = { ...ctx(event), systemMessage: "S11 BeforeAgent systemMessage: FOR THE HUMAN ONLY 482 913" };
  if (event === "AfterAgent" && once("afteragent")) out = { decision: "block", reason: `[S11] ${canary}: reply with the single word PINEAPPLE, then stop.` };
} else if (harness === "cursor") {
  if (event === "sessionStart" || event === "postToolUse") out = { additional_context: `[S11] ${canary}: if asked, list every CANARY string you can see.` };
  if (event === "stop" && once("stop")) out = { followup_message: `[S11] ${canary}: reply with the single word PINEAPPLE, then stop.` };
}
process.stdout.write(JSON.stringify(out));
