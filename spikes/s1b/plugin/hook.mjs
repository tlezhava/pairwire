// Spike S1b: each event tries one way of showing text to the human; markers are numbered.
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "out");
mkdirSync(out, { recursive: true });
const event = process.argv[2];
let raw = "";
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  const input = JSON.parse(raw || "{}");
  const sid = String(input.session_id || "x").replace(/[^\w-]/g, "");
  const once = (name) => {
    const f = join(out, `${name}-${sid}`);
    if (existsSync(f)) return false;
    writeFileSync(f, "");
    return true;
  };
  let res = null;
  if (event === "session-start") res = { systemMessage: "SEE-ME-1: SessionStart systemMessage" };
  if (event === "user-prompt-submit" && once("ups")) res = { systemMessage: "SEE-ME-2: UserPromptSubmit systemMessage (alone)" };
  if (event === "post-tool-use" && once("ptu")) {
    res = {
      systemMessage: "SEE-ME-3: PostToolUse systemMessage",
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: "Tell the user, word for word on its own line: SEE-ME-5 (relayed by the agent).",
      },
    };
  }
  if (event === "stop" && once("stop")) res = { systemMessage: "SEE-ME-4: Stop systemMessage (no block)" };
  appendFileSync(join(out, "hooks.jsonl"), JSON.stringify({ t: new Date().toISOString(), event, output: res }) + "\n");
  if (res) process.stdout.write(JSON.stringify(res));
  process.exit(0);
});
