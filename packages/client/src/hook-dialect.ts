// Hook dialects (04 §10, ADR-033): PAIRWIRE_HOOK_DIALECT maps a harness's hook input and output
// fields, so the hook logic in hooks.ts is shared. Claude Code ("claude") is the default and its
// output is what pairwire has always printed.
import { WAKE_PROMPT } from "./wake.js";

export const HOOK_DIALECTS = ["claude", "gemini", "cursor"] as const;
export type HookDialectName = (typeof HOOK_DIALECTS)[number];

export type DialectEvent = "session-start" | "user-prompt-submit" | "post-tool-use" | "stop";

/** The fields the shared logic reads. */
export interface HookInput {
  session_id?: string;
  cwd?: string;
  permission_mode?: string;
  prompt?: string;
}

/** What the shared logic decided; the dialect turns it into the harness's JSON. */
export interface HookOutcome {
  /** REQ-SAFE-5's warning for the human (dialects with `warns`). */
  warning?: string;
  /** Context for the model: the reminder or rendered items. */
  context?: string;
  /** Claude Code's Stop: block with this reason (rendered items). */
  blockReason?: string;
  /** A fixed-text wake (dialects with `wakeText`): items are waiting, never their text. */
  wake?: boolean;
}

export interface HookDialect {
  readonly name: HookDialectName;
  input(raw: Record<string, unknown>): HookInput;
  /** Whether the event can show context; when it can't, no item is claimed there. */
  canShow(event: DialectEvent): boolean;
  /** `stop` wakes with WAKE_PROMPT instead of showing rendered items. */
  readonly wakeText: boolean;
  /** Whether the harness shows `warning` to the human. */
  readonly warns: boolean;
  /** The JSON to print, or null for none. `outcome` is null when the hook does nothing. */
  output(event: DialectEvent, outcome: HookOutcome | null): Record<string, unknown> | null;
}

const CLAUDE_EVENTS: Record<DialectEvent, string> = {
  "session-start": "SessionStart",
  "user-prompt-submit": "UserPromptSubmit",
  "post-tool-use": "PostToolUse",
  stop: "Stop",
};

/** Gemini CLI's names for the events its hooks.json maps to ours (04 §10). */
const GEMINI_EVENTS: Record<DialectEvent, string> = {
  "session-start": "SessionStart",
  "user-prompt-submit": "BeforeAgent",
  "post-tool-use": "AfterTool",
  stop: "AfterAgent",
};

const nonEmpty = (out: Record<string, unknown>) => (Object.keys(out).length > 0 ? out : null);
const text = (v: unknown) => (typeof v === "string" ? v : undefined);

/** Claude Code's format, which Gemini CLI shares (hookSpecificOutput, decision, systemMessage). */
function claudeLike(names: Record<DialectEvent, string>) {
  return (event: DialectEvent, o: HookOutcome | null): Record<string, unknown> | null => {
    if (!o) return null;
    const out: Record<string, unknown> = {};
    if (o.warning) out.systemMessage = o.warning;
    if (o.context !== undefined) out.hookSpecificOutput = { hookEventName: names[event], additionalContext: o.context };
    if (o.blockReason !== undefined) {
      out.decision = "block";
      out.reason = o.blockReason;
    } else if (o.wake) {
      out.decision = "block";
      out.reason = WAKE_PROMPT;
    }
    return nonEmpty(out);
  };
}

const claude: HookDialect = {
  name: "claude",
  input: (raw) => raw as HookInput,
  canShow: () => true,
  wakeText: false,
  warns: true,
  output: claudeLike(CLAUDE_EVENTS),
};

/** Input is Claude Code's; `AfterAgent`'s reason is sent as a new prompt, so it is WAKE_PROMPT. */
const gemini: HookDialect = {
  name: "gemini",
  input: (raw) => raw as HookInput,
  canShow: () => true,
  wakeText: true,
  warns: true,
  output: claudeLike(GEMINI_EVENTS),
};

/**
 * Cursor: `conversation_id` and `workspace_roots[0]` stand in for `session_id` and `cwd`;
 * context is `additional_context`; `stop` answers with a `followup_message`; `beforeSubmitPrompt`
 * can only allow or block, so it always allows and shows nothing; no `systemMessage` channel.
 */
const cursor: HookDialect = {
  name: "cursor",
  input: (raw) => {
    const roots = raw.workspace_roots;
    const root = Array.isArray(roots) && typeof roots[0] === "string" && roots[0] !== "" ? roots[0] : undefined;
    const input: HookInput = {};
    const session = text(raw.conversation_id);
    const cwd = root ?? text(raw.cwd);
    const prompt = text(raw.prompt);
    if (session !== undefined) input.session_id = session;
    if (cwd !== undefined) input.cwd = cwd;
    if (prompt !== undefined) input.prompt = prompt;
    return input;
  },
  canShow: (event) => event !== "user-prompt-submit",
  wakeText: true,
  warns: false,
  output: (event, o) => {
    if (event === "user-prompt-submit") return { continue: true };
    if (!o) return null;
    if (event === "stop") return o.wake ? { followup_message: WAKE_PROMPT } : null;
    return o.context !== undefined ? { additional_context: o.context } : null;
  },
};

const DIALECTS: Record<HookDialectName, HookDialect> = { claude, gemini, cursor };

/** PAIRWIRE_HOOK_DIALECT; anything else, or nothing, is Claude Code's. */
export function hookDialect(env: NodeJS.ProcessEnv): HookDialect {
  const name = env.PAIRWIRE_HOOK_DIALECT?.trim() ?? "";
  return (HOOK_DIALECTS as readonly string[]).includes(name) ? DIALECTS[name as HookDialectName] : claude;
}
