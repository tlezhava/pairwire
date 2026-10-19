import { createRequire as __pwCreateRequire } from "node:module";
const require = __pwCreateRequire(import.meta.url);
import {
  claimUndelivered
} from "./chunk-KTPG7IL3.mjs";
import {
  withLock,
  writeFileAtomic
} from "./chunk-4NNITFK4.mjs";
import {
  roomFile
} from "./chunk-GVGSGJLD.mjs";
import {
  external_exports
} from "./chunk-7VVD7K5U.mjs";

// packages/client/src/wake.ts
import { readFileSync } from "node:fs";
var WAKE_PROMPT = "pairwire: new message(s) from your collaborator are waiting; call the pairwire inbox tool to read them.";
var TASK_NOTIFICATION = "<task-notification>";
function isHumanPrompt(prompt) {
  return !prompt.startsWith(TASK_NOTIFICATION) && prompt.trim() !== WAKE_PROMPT;
}
var promptedSchema = external_exports.strictObject({ ids: external_exports.array(external_exports.string()) });
function announceWake(home, roomId, hold) {
  const path = roomFile(home, roomId, "wake-prompted.json");
  return withLock(path, () => {
    const pending = claimUndelivered(home, roomId, { hold }, (items) => ({ ids: [], result: items.map((i) => i.id) }));
    const prompted = readPrompted(path);
    if (pending.every((id) => prompted.has(id))) return false;
    writeFileAtomic(path, JSON.stringify({ ids: pending }) + "\n");
    return true;
  });
}
function readPrompted(path) {
  try {
    return new Set(promptedSchema.parse(JSON.parse(readFileSync(path, "utf8"))).ids);
  } catch {
    return /* @__PURE__ */ new Set();
  }
}

export {
  WAKE_PROMPT,
  isHumanPrompt,
  announceWake
};
