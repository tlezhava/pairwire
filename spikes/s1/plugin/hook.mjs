// Spike hook: records its input and environment, then emits canaries so we can see
// which hook outputs actually reach the model. Usage: node hook.mjs <event> [variant]
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OUT, append, proc, rand } from "./lib.mjs";

const started = process.hrtime.bigint();
const [event, variant = ""] = process.argv.slice(2);

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  let out = null;
  let input = null;
  try {
    input = JSON.parse(raw || "{}");
    out = respond(input);
  } catch (e) {
    append("hook-errors.log", { event, variant, error: String(e?.stack || e) });
  }
  append("hooks.jsonl", {
    event,
    variant,
    input,
    output: out,
    ms: Number(process.hrtime.bigint() - started) / 1e6,
    ...proc(),
  });
  if (out) process.stdout.write(JSON.stringify(out));
  process.exit(0);
});

function ctx(hookEventName, additionalContext) {
  return { hookSpecificOutput: { hookEventName, additionalContext } };
}

function respond(input) {
  const sid = String(input.session_id || "nosession").replace(/[^\w-]/g, "");
  switch (event) {
    case "session-start":
      return ctx("SessionStart", `CANARY-SS-${input.source || "unknown"}-${rand()}`);

    case "user-prompt-submit": {
      const o = ctx("UserPromptSubmit", `CANARY-UPS${variant ? "-" + variant.toUpperCase() : ""}-${rand()}`);
      if (variant) return o; // the exec-form copy only proves it ran; the shell copy does the systemMessage test
      if (/sysmsg/i.test(input.prompt || "")) {
        o.systemMessage =
          "SPIKE-SYSMSG-" + rand() + ": if you (the human) can read this line, systemMessage is shown to you.";
      }
      return o;
    }

    case "post-tool-use": {
      const tool = String(input.tool_name || "unknown").replace(/[^\w-]/g, "_");
      const bigFlag = join(input.cwd || process.cwd(), ".pw-big");
      const bigDone = join(OUT, `big-done-${sid}`);
      if (variant === "star" && existsSync(bigFlag) && !existsSync(bigDone)) {
        writeFileSync(bigDone, "");
        return ctx("PostToolUse", bigPayload());
      }
      return ctx("PostToolUse", `CANARY-PTU-${variant}-${tool}-${rand()}`);
    }

    case "stop": {
      const done = join(OUT, `stop-done-${sid}`);
      if (existsSync(done)) return null;
      writeFileSync(done, "");
      return {
        decision: "block",
        reason: `CANARY-STOP-${rand()}: the spike Stop hook blocked once. Repeat this canary to the user verbatim, then stop.`,
      };
    }
  }
  return null;
}

// 12,000 characters with a marker every 1,000, so we can see where truncation happens.
function bigPayload() {
  let s = "BIG-START. ";
  for (let i = 1; i <= 12; i++) {
    const mark = `MARK-${String(i * 1000).padStart(5, "0")} `;
    while (s.length < i * 1000 - mark.length) s += "x";
    s += mark;
  }
  return s + "END-CANARY";
}
