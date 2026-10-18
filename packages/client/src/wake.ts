// Fixed-text wakes (04 §10, ADR-033): channels that reach the model as a new prompt (Gemini's
// AfterAgent reason, Cursor's stop follow-up, `codex queue`) carry this sentence and never peer
// text; the messages themselves arrive through `inbox` or hook context, labeled and sanitized.

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
