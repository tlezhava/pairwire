// Fixed-text wakes (04 §10, ADR-033): channels that reach the model as a new prompt (Gemini's
// AfterAgent reason, Cursor's stop follow-up, `codex queue`) carry this sentence and never peer
// text; the messages themselves arrive through `inbox` or hook context, labeled and sanitized.
import { readFileSync } from "node:fs";
import { z } from "zod";
import { withLock, writeFileAtomic } from "./fs-util.js";
import { roomFile } from "./paths.js";
import { claimUndelivered } from "./room-files.js";

export const WAKE_PROMPT = "pairwire: new message(s) from your collaborator are waiting; call the pairwire inbox tool to read them.";

/** Claude Code submits D3 wakes and other background results as such prompts (S3). */
const TASK_NOTIFICATION = "<task-notification>";

/**
 * Whether a submitted prompt came from the human, so it resets the hop budget (04 §6, INV-6):
 * a `<task-notification>` prompt (a D3 wake) and the fixed wake text are not.
 */
export function isHumanPrompt(prompt: string): boolean {
  return !prompt.startsWith(TASK_NOTIFICATION) && prompt.trim() !== WAKE_PROMPT;
}

const promptedSchema = z.strictObject({ ids: z.array(z.string()) });

/**
 * Whether a fixed-text wake should go out now (04 §10): some undelivered item (never a held
 * one) has not been announced by an earlier wake. If so, records the undelivered ids in
 * `wake-prompted.json`, so the next turn end does not wake again for the same items. Marks
 * nothing delivered.
 */
export function announceWake(home: string, roomId: string, hold: boolean): boolean {
  const path = roomFile(home, roomId, "wake-prompted.json");
  return withLock(path, () => {
    const pending = claimUndelivered(home, roomId, { hold }, (items) => ({ ids: [], result: items.map((i) => i.id) }));
    const prompted = readPrompted(path);
    if (pending.every((id) => prompted.has(id))) return false;
    writeFileAtomic(path, JSON.stringify({ ids: pending }) + "\n");
    return true;
  });
}

function readPrompted(path: string): Set<string> {
  try {
    return new Set(promptedSchema.parse(JSON.parse(readFileSync(path, "utf8"))).ids);
  } catch {
    return new Set(); // missing or unreadable: at worst one extra wake
  }
}
