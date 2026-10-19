// Codex idle wake (04 §10, ADR-033): with PAIRWIRE_DELIVERY=wake, the MCP server that owns the
// room starts a turn in its idle Codex thread with `codex queue` and the fixed WAKE_PROMPT, never
// peer text. Thread and outstanding wake live in memory only (strict-schema files stay as they are).
import { execFile } from "node:child_process";
import type { Logger } from "./log.js";
import { isHeld, readInbox, readLedger } from "./room-files.js";
import { WAKE_PROMPT } from "./wake.js";

/** Never read as an option by `codex`: starts with a letter or digit (04 §10). */
const THREAD_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
export const CODEX_WAKE_TIMEOUT_MS = 10_000;

export interface CodexWakeOptions {
  /** The server's environment: `codex` is looked up on its PATH. */
  env: NodeJS.ProcessEnv;
  log: Logger;
}

/** The argv of one wake. */
export function codexWakeArgs(threadId: string): string[] {
  return ["queue", "--thread", threadId, "--message", WAKE_PROMPT];
}

export class CodexWake {
  readonly #o: CodexWakeOptions;
  #thread: string | null = null;
  /** The ids undelivered when the last wake went out; cleared once any of them is delivered. */
  #outstanding: { roomId: string; ids: readonly string[] } | null = null;
  /** Set by the first failure, for the rest of this server's life. */
  #off = false;

  constructor(options: CodexWakeOptions) {
    this.#o = options;
  }

  /** Keeps the first valid thread id seen; later ones are ignored. */
  noteThread(threadId: unknown): void {
    if (this.#thread !== null || typeof threadId !== "string" || !THREAD_ID.test(threadId)) return;
    this.#thread = threadId;
  }

  get thread(): string | null {
    return this.#thread;
  }

  /**
   * Called on each inbound item once the caller has checked delivery, harness and ownership.
   * Wakes when a thread is known, no earlier wake is outstanding, and some undelivered item is
   * not held. Returns whether a wake went out.
   */
  maybeWake(home: string, roomId: string, hold: boolean): boolean {
    if (this.#off || this.#thread === null) return false;
    const ledger = readLedger(home, roomId);
    const prior = this.#outstanding;
    if (prior && prior.roomId === roomId && !prior.ids.some((id) => ledger.ids.has(id))) return false;
    this.#outstanding = null;
    const pending = readInbox(home, roomId)
      .filter((e) => !ledger.ids.has(e.id) && !isHeld(e, ledger, hold))
      .map((e) => e.id);
    if (pending.length === 0) return false;
    this.#outstanding = { roomId, ids: pending };
    this.#run(this.#thread);
    return true;
  }

  #run(thread: string): void {
    try {
      execFile(
        "codex",
        codexWakeArgs(thread),
        { env: this.#o.env, timeout: CODEX_WAKE_TIMEOUT_MS, windowsHide: true, shell: false, maxBuffer: 1024 * 1024 },
        (err) => {
          if (!err) {
            this.#o.log.info("codex_wake", { exit_code: 0 });
            return;
          }
          this.#fail(err);
        },
      );
    } catch (e) {
      this.#fail(e as NodeJS.ErrnoException); // a synchronous spawn failure (e.g. EINVAL on Windows)
    }
  }

  /** Output is never logged: only how it ended. */
  #fail(err: { code?: unknown; signal?: unknown; killed?: unknown }): void {
    if (this.#off) return;
    this.#off = true;
    this.#o.log.warn("codex_wake_failed", {
      exit_code: typeof err.code === "number" ? err.code : null,
      error_code: typeof err.code === "string" ? err.code : null,
      signal: typeof err.signal === "string" ? err.signal : null,
      timed_out: err.killed === true,
      action: "codex wakes are off until this MCP server restarts",
    });
  }
}
