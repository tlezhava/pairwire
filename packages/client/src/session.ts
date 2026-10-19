// The MCP server's state for one agent session (04 §3–4, §7): project ownership, the room's
// connection, and the six tools. Tool methods return text for the agent and never throw.
import {
  CLAIM_TTL_MIN,
  COLLAB_CAP,
  DEFAULT_RELAY_HOST,
  MAX_PATHS,
  acceptHint,
  isCollabKind,
  noticeHeld,
  deriveRoomKeys,
  displayName,
  EnvelopeTooLargeError,
  encodeShareString,
  formatRelayAddress,
  generateSecret,
  HARNESSES,
  parseRelayAddress,
  parseShareString,
  relayUrl,
  renderForHook,
  renderItems,
  scanSecrets,
  serializeEnvelope,
  type Harness,
  type HelloPayload,
} from "@pairwire/core";
import { z } from "zod";
import { adoptOwnerSession, bindProject, claimProject, isProcessAlive, PassiveSessionError } from "./binding.js";
import { holdMode, loadConfig, pushes, resolveDisplayName, type Config } from "./config.js";
import { RoomConnection, type ConnectionEvents, type SendInput, type SocketFactory, type Timers, type Tuning } from "./connection.js";
import type { Logger } from "./log.js";
import { chooseCtlPath, roomFile } from "./paths.js";
import { assertStatePrivate } from "./permissions.js";
import { resolveProjectDir } from "./project.js";
import { claimUndelivered, inboxCounts, readCoordSent, readOutbox, type InboxCounts, type InboxEntry } from "./room-files.js";
import { createRoom, expiresAt, isOpen, readSecret, readState, updateState, type RoomState } from "./state.js";
import { CodexWake } from "./codex-wake.js";
import { CollabSendError, planStructured, type CollabPlan } from "./collab-send.js";
import { coordFooter, coordStatusLines, loadView, renderItemsFor } from "./coord.js";
import { transcriptEvents } from "./transcript.js";
import { CLIENT_VERSION } from "./version.js";
import { ensureCtlKey, readCtlKey } from "./ctl-key.js";
import { CTL_LISTEN_RETRIES, listenCtl, listenFresh, type CtlReply, type CtlRequest, type CtlServer, type WaitFrame } from "./ctl-server.js";
import type { Socket } from "node:net";

export interface ToolResult {
  text: string;
  isError?: boolean;
}

export interface SessionOptions {
  home: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
  log: Logger;
  /** This MCP server's pid (tests run several sessions in one process). */
  pid?: number;
  /** Its parent's pid, the harness (04 §10, harness-pid sidecar); default process.ppid. */
  ppid?: number;
  isAlive?: (pid: number) => boolean;
  now?: () => number;
  /** How long `join` waits for the handshake (04 §4: 30 s). */
  joinWaitMs?: number;
  /** How long `start` waits for the relay's `joined`. */
  startWaitMs?: number;
  socketFactory?: SocketFactory;
  timers?: Timers;
  tuning?: Partial<Tuning>;
  events?: ConnectionEvents;
  /** HELLO caps (tests stand in for an older client with them); default HELLO_CAPS. */
  helloCaps?: string[];
}

/** First line of a D3 wake (04 §6). */
export const WAKE_LEAD = "pairwire: new message(s) from your collaborator arrived while you were idle.";

/**
 * REQ-SAFE-5 in Cursor (04 §10): its hooks have no channel to the human and can't see auto-run,
 * so `status` says it.
 */
export const CURSOR_APPROVAL_WARNING =
  "Approval: Cursor asks you before each message your agent sends, unless auto-run or an MCP allowlist covers the pairwire send tool; " +
  "then messages go out without asking you first. pairwire cannot see that setting.";

/** 04 §7 step 5. */
const SENDS_PER_MINUTE = 20;
const MINUTE = 60_000;
const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

const SEND_KINDS = ["chat", "question", "answer", "heads_up", "claim", "release", "contract_propose", "contract_response"] as const;
type SendKind = (typeof SEND_KINDS)[number];

/**
 * Flat, so the approval prompt stays readable; the handler checks which fields each kind
 * takes (04 §4, Structured kinds in the tools).
 */
export const sendInputSchema = z.object({
  kind: z
    .enum(SEND_KINDS)
    .describe(
      "chat, question, answer; or a coordination record: heads_up (a change that affects the peer), claim / release (ask the peer not to edit paths for a while), contract_propose / contract_response (agree on a contract file by its SHA-256)",
    ),
  body: z.string().optional().describe("The message. Required except for release and an accepting contract_response."),
  reply_to: z
    .string()
    .regex(ULID, "reply_to must be a message id")
    .optional()
    .describe("answer: the question's id; release: your claim's id; contract_response: the proposal's id; contract_propose: a proposal it counters (optional)"),
  paths: z.array(z.string()).max(MAX_PATHS).optional().describe("heads_up (optional), claim (required): project-relative paths or globs, first segment literal"),
  ttl_minutes: z.number().int().optional().describe(`claim only: minutes until it expires, ${CLAIM_TTL_MIN.min} to ${CLAIM_TTL_MIN.max} (default ${CLAIM_TTL_MIN.default})`),
  contract_name: z.string().optional().describe("contract_propose only: lowercase name, e.g. orders-api"),
  contract_path: z.string().optional().describe("contract_propose only: the contract file in this project (no globs); pairwire hashes it"),
  contract_content: z.string().optional().describe("contract_propose only: the file's exact text, to send it inline; otherwise only its hash is sent"),
  rev: z.string().optional().describe("contract_propose only: the git commit that has the file (7 to 40 hex)"),
  decision: z.enum(["accept", "reject"]).optional().describe("contract_response only"),
  local_path: z.string().optional().describe("contract_response with accept only: your copy of the contract file; it must match the proposal's hash. Not sent."),
});

/** Which optional fields each kind takes; any other one is an error that names it. */
const KIND_FIELDS: Record<SendKind, readonly string[]> = {
  chat: ["body", "reply_to"],
  question: ["body", "reply_to"],
  answer: ["body", "reply_to"],
  heads_up: ["body", "paths"],
  claim: ["body", "paths", "ttl_minutes"],
  release: ["body", "reply_to"],
  contract_propose: ["body", "reply_to", "contract_name", "contract_path", "contract_content", "rev"],
  contract_response: ["body", "reply_to", "decision", "local_path"],
};
const OPTIONAL_FIELDS = Object.keys(sendInputSchema.shape).filter((k) => k !== "kind");

/** The HELLO caps of an M5 client (02 §6.3.2). */
export const HELLO_CAPS = ["ack", "say", COLLAB_CAP];
export const startInputSchema = z.object({ name: z.string().max(200).optional() });
export const joinInputSchema = z.object({ share: z.string().max(4096), name: z.string().max(200).optional() });
export const leaveInputSchema = z.object({ message: z.string().optional() });

class ToolError extends Error {}

type StructuredSend = Extract<SendInput, { fallbackBody: string }>;

export class ClientSession {
  readonly #o: SessionOptions;
  readonly #pid: number;
  readonly #now: () => number;
  readonly projectDir: string;
  #fatal: string | null = null;
  #config: Config | null = null;
  #passiveOwner: number | null = null;
  #roomId: string | null = null;
  #conn: RoomConnection | null = null;
  #ctl: Promise<CtlServer | null> | null = null;
  /** D3 waiters by harness session id: at most one each (04 §6). */
  #waiters = new Map<string, Socket>();
  #sendTimes: number[] = [];
  /** A session id learned from a tool call's _meta (Codex), when the env gives none. */
  #learnedSession: string | null = null;
  /** The Codex idle wake (04 §10): thread id and outstanding wake, in memory only. */
  readonly #codex: CodexWake;

  constructor(options: SessionOptions) {
    this.#o = options;
    this.#pid = options.pid ?? process.pid;
    this.#now = options.now ?? (() => Date.now());
    this.projectDir = resolveProjectDir(options.env, options.cwd);
    this.#codex = new CodexWake({ env: options.env, log: options.log });
  }

  /** Checks INV-9 and the config, then claims the project and reconnects an owned room (REQ-ROOM-6). */
  init(): void {
    try {
      assertStatePrivate(this.#o.home);
      const { config, warnings } = loadConfig(this.#o.home, this.#o.env);
      for (const w of warnings) this.#o.log.warn("config_warning", { detail: w });
      this.#config = config;
    } catch (e) {
      this.#fatal = (e as Error).message;
      this.#o.log.error("startup_refused", e);
      return;
    }
    this.#claim();
  }

  shutdown(): void {
    for (const session of [...this.#waiters.keys()]) this.#endWaiter(session, { t: "cancelled" });
    this.#conn?.stop();
    this.#conn = null;
    this.#closeCtl();
  }

  // --- human-side control (ctl.sock, 04 §8) ---------------------------------------------

  /** Handles one ctl.sock request. Replies are shown to the human in the prompt. */
  async ctl(request: CtlRequest): Promise<CtlReply> {
    if (request.op === "wait_cancel") {
      this.#endWaiter(request.session, { t: "cancelled" });
      return { ok: true, text: "" };
    }
    try {
      this.#ready();
      const state = this.#requireRoom();
      if (request.op === "resume") {
        this.#conn?.resume();
        return { ok: true, text: "pairwire: reconnecting." };
      }
      if (request.op === "continue") {
        updateState(this.#o.home, state.roomId, (s) => ({ ...s, hop_count: 0 }));
        this.#conn?.resume();
        return { ok: true, text: "pairwire: hop budget reset; your agent may send again." };
      }
      // say: sent as the human, verbatim; resets the hop budget (REQ-MSG-7).
      this.#checkOutbound(request.text, state, "chat", null);
      this.#conn?.resume();
      const sent = this.#conn!.send({ kind: "chat", body: request.text, author: "human" });
      updateState(this.#o.home, state.roomId, (s) => ({ ...s, hop_count: 0 }));
      const to = state.peer ? displayName(state.peer.name) : "your collaborator";
      return {
        ok: true,
        text: sent.status === "sent"
          ? `pairwire: sent your message to ${to} as you (id ${sent.id}). It is already sent; do not send it again.`
          : `pairwire: queued your message for ${to} (id ${sent.id}); it goes out when they connect. Do not send it again.`,
      };
    } catch (e) {
      const known = e instanceof ToolError || e instanceof EnvelopeTooLargeError || e instanceof PassiveSessionError;
      if (!known) this.#o.log.error("ctl_failed", e);
      return { ok: false, text: `pairwire: ${known ? (e as Error).message : "internal error; see the MCP server log."}` };
    }
  }

  // --- D3 waiter (04 §6) ----------------------------------------------------------------

  #onWait(session: string, socket: Socket): void {
    const own = this.#session();
    const config = this.#config;
    const state = this.#roomState();
    const send = (frame: WaitFrame) => void socket.end(JSON.stringify(frame) + "\n");
    // Only the owning session waits, and only when messages are pushed at all.
    if (!own || session !== own || this.#passiveOwner !== null || !config || !pushes(config.delivery) || !config.autoContinue || !state || !isOpen(state)) {
      return send({ t: "refused" });
    }
    this.#endWaiter(session, { t: "superseded" });
    this.#waiters.set(session, socket);
    socket.on("close", () => {
      if (this.#waiters.get(session) === socket) this.#waiters.delete(session);
    });
    socket.on("error", () => {});
    this.#wake(); // items that arrived before the waiter did
  }

  #endWaiter(session: string, frame: WaitFrame): void {
    const socket = this.#waiters.get(session);
    if (!socket) return;
    this.#waiters.delete(session);
    socket.end(JSON.stringify(frame) + "\n");
  }

  /** Hands undelivered items to a pending waiter, which wakes the session with them. */
  #wake(): void {
    const state = this.#roomState();
    if (this.#waiters.size === 0 || !state) return;
    for (const [session, socket] of this.#waiters) {
      const hold = this.#hold();
      const rendered = claimUndelivered(this.#o.home, state.roomId, { hold }, (items, ledger) => {
        const r = renderForHook(renderItemsFor(this.#o.home, state.roomId, items, { hold, now: this.#now(), ledger }));
        return { ids: r.deliveredIds, result: r.text };
      });
      if (rendered === null) return;
      this.#waiters.delete(session);
      socket.end(JSON.stringify({ t: "wake", text: `${WAKE_LEAD}\n\n${rendered}` } satisfies WaitFrame) + "\n");
      return;
    }
  }

  /**
   * The Codex idle wake (04 §10): after the D3 handoff, an item nothing took wakes the idle
   * thread with WAKE_PROMPT, when PAIRWIRE_DELIVERY=wake and this server owns the open room.
   */
  #codexWake(): void {
    const config = this.#config;
    const roomId = this.#roomId;
    if (!config || config.delivery !== "wake" || !config.autoContinue || harnessOf(this.#o.env) !== "codex") return;
    if (this.#passiveOwner !== null || !roomId || !this.#roomOpen()) return;
    try {
      this.#codex.maybeWake(this.#o.home, roomId, this.#hold());
    } catch (e) {
      this.#o.log.error("codex_wake_check_failed", e);
    }
  }

  /** Hold mode, read afresh for every delivery decision (04 §2). */
  #hold(): boolean {
    return holdMode(this.#o.home, this.#o.env);
  }

  /**
   * Hold mode (04 §5): the first message held tells the human through a `held` notice, which
   * flows (and wakes) like any notice. Later ones add none until the human accepts or drops.
   */
  #noteHeld(entry: InboxEntry): void {
    const roomId = this.#roomId;
    if (entry.source !== "peer" || !roomId || !this.#hold()) return;
    if (inboxCounts(this.#o.home, roomId, true).held !== 1) return;
    this.#conn?.notice(noticeHeld(entry.from, harnessOf(this.#o.env)));
  }

  #closeCtl(): void {
    const ctl = this.#ctl;
    this.#ctl = null;
    void ctl?.then((c) => c?.close());
  }

  /** Resolves once the control socket listens (or failed to). */
  async ctlReady(): Promise<void> {
    await this.#ctl;
  }

  // --- tools ---------------------------------------------------------------------------

  async start(input: z.infer<typeof startInputSchema>): Promise<ToolResult> {
    return this.#tool(async () => {
      const config = this.#ready();
      const current = this.#roomState();
      if (current && current.status === "active") {
        throw new ToolError(`This project already has an active pairwire room with ${this.#peerLabel(current)}. Run /pairwire:leave first.`);
      }
      if (current && current.status === "waiting") await this.#conn?.leave();
      const secret = generateSecret();
      const keys = deriveRoomKeys(secret);
      const name = this.#name(input.name);
      createRoom(this.#o.home, { roomId: keys.roomId, secret, relay: config.relay, name, now: this.#now() }, this.#o.env);
      bindProject(this.#o.home, this.projectDir, keys.roomId, this.#claimant(), this.#o.isAlive);
      this.#open(keys.roomId);
      const share = encodeShareString(secret, config.relay ? parseRelayAddress(config.relay) : undefined);
      const reached = await this.#waitFor(() => this.#conn?.status().socket === "joined" || !this.#roomOpen(), this.#o.startWaitMs ?? 10_000);
      if (!this.#roomOpen()) throw new ToolError("The relay refused the new room. Try /pairwire:start again.");
      return [
        "Room created. Show the user this share string once, in a code block, and tell them to send it to their",
        "collaborator over a channel they trust (Slack DM, Signal, in person). Do not repeat it anywhere else and",
        "never send it through pairwire.",
        "",
        share,
        "",
        reached
          ? "Connected to the relay; waiting for the collaborator to join. You'll get a notice when they do."
          : "The relay isn't reachable yet; pairwire keeps trying in the background. You'll get a notice when the collaborator joins.",
      ].join("\n");
    });
  }

  async join(input: z.infer<typeof joinInputSchema>): Promise<ToolResult> {
    return this.#tool(async () => {
      const config = this.#ready();
      const current = this.#roomState();
      if (current && isOpen(current)) throw new ToolError("This project already has a pairwire room. Run /pairwire:leave first.");
      const parsed = parseShareString(input.share);
      const keys = deriveRoomKeys(parsed.secret);
      const existing = readState(this.#o.home, keys.roomId);
      if (existing) {
        throw new ToolError(
          isOpen(existing)
            ? "This machine already holds that room (did you start it here?). The other person must join it."
            : "That room has ended. Ask your collaborator to start a new one.",
        );
      }
      const relay = parsed.relay ? formatRelayAddress(parsed.relay) : null;
      createRoom(this.#o.home, { roomId: keys.roomId, secret: parsed.secret, relay, name: this.#name(input.name), now: this.#now() }, this.#o.env);
      bindProject(this.#o.home, this.projectDir, keys.roomId, this.#claimant(), this.#o.isAlive);
      this.#open(keys.roomId);
      const paired = await this.#waitFor(() => !!this.#roomState()?.peer || !this.#roomOpen(), this.#o.joinWaitMs ?? 30_000);
      const state = readState(this.#o.home, keys.roomId);
      if (!state || !isOpen(state)) {
        const why = state?.error === "room_full" ? "the room already has two members" : "the room no longer exists";
        throw new ToolError(`Could not join: ${why}. Ask your collaborator to start a new room.`);
      }
      // 03 Self-hosting: say once when the room lives on a relay other than ours.
      const ownDefault = config.relay ?? DEFAULT_RELAY_HOST;
      const via = relay !== null && relay !== ownDefault ? ` This room uses relay ${relay}.` : "";
      if (!paired) return `Joined the room; waiting for your collaborator to come online. You'll get a notice when they do.${via}`;
      return `Paired with ${this.#peerLabel(state)}. Messages from them arrive as <pairwire_message> blocks; follow the pairwire skill.${via}`;
    });
  }

  send(input: z.infer<typeof sendInputSchema>): Promise<ToolResult> {
    return this.#tool(async () => {
      const config = this.#ready();
      const state = this.#requireRoom();
      const given = input as Record<string, unknown>;
      const extra = OPTIONAL_FIELDS.filter((k) => given[k] !== undefined && !KIND_FIELDS[input.kind].includes(k));
      if (extra.length > 0) throw new ToolError(`${extra.join(", ")} ${extra.length === 1 ? "doesn't" : "don't"} apply to kind "${input.kind}"; nothing was sent.`);
      const now = this.#now();
      let plan: CollabPlan | null = null;
      if (isCollabKind(input.kind)) {
        plan = planStructured({ ...input, kind: input.kind }, {
          loaded: loadView(this.#o.home, state.roomId, { hold: this.#hold(), now }),
          projectDir: this.projectDir,
          peerName: state.peer ? displayName(state.peer.name) : "your collaborator",
          now,
          roomExpiresAt: expiresAt(state),
          nextSeq: state.my_seq + 1,
        });
        this.#scan(plan.scan);
      } else {
        if (input.kind === "answer" && !input.reply_to) throw new ToolError("An answer needs reply_to: the id of the question it answers.");
        if (!input.body) throw new ToolError("body is empty; nothing was sent.");
        this.#checkOutbound(input.body, state, input.kind, input.reply_to ?? null);
      }
      if (state.hop_count >= config.hopBudget) throw new ToolError("Hop budget reached. Ask your human whether to continue.");
      this.#sendTimes = this.#sendTimes.filter((t) => now - t < MINUTE);
      if (this.#sendTimes.length >= SENDS_PER_MINUTE) {
        const wait = Math.ceil((this.#sendTimes[0]! + MINUTE - now) / 1000);
        throw new ToolError(`Rate limit: at most ${SENDS_PER_MINUTE} messages per minute. Try again in ${wait} s.`);
      }
      const sent = plan
        ? this.#conn!.send({
            kind: plan.kind,
            data: plan.data,
            body: plan.body,
            reply_to: plan.reply_to,
            author: "agent",
            fallbackBody: plan.fallbackBody,
            sentAt: now,
            ...(plan.localPath ? { localPath: plan.localPath } : {}),
          } as StructuredSend)
        : this.#conn!.send({ kind: input.kind as "chat" | "question" | "answer", body: input.body!, reply_to: input.reply_to ?? null, author: "agent" });
      this.#sendTimes.push(now);
      updateState(this.#o.home, state.roomId, (s) => ({ ...s, hop_count: s.hop_count + 1 }));
      const lines = [
        sent.status === "sent"
          ? `Sent (id ${sent.id}). You'll see "delivered" in status once their client receives it.`
          : `Queued (id ${sent.id}): it goes out as soon as your collaborator connects.`,
        ...(plan?.lines ?? []),
        ...(sent.encoding === "chat" ? ["Your collaborator's pairwire is older, so this went out as a chat message with a header line."] : []),
      ];
      return lines.join("\n");
    });
  }

  inbox(): Promise<ToolResult> {
    return this.#tool(async () => {
      this.#ready();
      // An ended room's last messages (the bye, the notice) must stay readable.
      const state = this.#roomState();
      if (!state) throw new ToolError("No pairwire room in this project. Your user can run /pairwire:start or /pairwire:join.");
      const hold = this.#hold();
      const text = claimUndelivered(this.#o.home, state.roomId, { hold }, (items, ledger) => ({
        ids: items.map((i) => i.id),
        result: items.length > 0 ? renderItems(renderItemsFor(this.#o.home, state.roomId, items, { hold, now: this.#now(), ledger })) : "No new messages.",
      }));
      return `${text}\n\n${this.#recentSends(state.roomId)}`.trimEnd();
    });
  }

  status(): Promise<ToolResult> {
    return this.#tool(async () => {
      const config = this.#ready();
      const state = this.#roomState();
      if (!state) return "No pairwire room in this project. Your user can run /pairwire:start or /pairwire:join.";
      const conn = this.#conn?.status();
      const hold = this.#hold();
      const lines = [
        `Room: ${state.status}${state.error ? ` (${state.error})` : ""}`,
        `Peer: ${state.peer ? this.#peerLabel(state) : "not joined yet"}${conn?.peerConnected ? ", online" : state.peer ? ", offline" : ""}`,
        `Connection: ${conn?.halted ? `stopped (${conn.halted})` : (conn?.socket ?? "offline")}`,
        `Relay: ${state.relay ?? "default relay"}`,
        `Inbox: ${unreadText(inboxCounts(this.#o.home, state.roomId, hold), harnessOf(this.#o.env))}`,
        ...(hold ? [`Hold mode: on (peer messages wait until your user runs ${acceptHint(harnessOf(this.#o.env))})`] : []),
        ...(harnessOf(this.#o.env) === "cursor" && isOpen(state) ? [CURSOR_APPROVAL_WARNING] : []),
        `Hop budget: ${Math.max(0, config.hopBudget - state.hop_count)}/${config.hopBudget} left (every message your agent sends uses one; resets when your user writes to you)`,
        ...coordStatusLines(loadView(this.#o.home, state.roomId, { hold, now: this.#now() }), {
          peer: state.peer ? displayName(state.peer.name) : "your collaborator",
          projectDir: this.projectDir,
        }),
        `Transcript: ${roomFile(this.#o.home, state.roomId, "transcript.md")}`,
      ];
      return `${lines.join("\n")}\n\n${this.#recentSends(state.roomId)}`.trimEnd();
    });
  }

  leave(input: z.infer<typeof leaveInputSchema>): Promise<ToolResult> {
    return this.#tool(async () => {
      this.#ready();
      const state = this.#requireRoom();
      const message = input.message?.trim() ? input.message : null;
      if (message !== null) this.#checkOutbound(message, state, "bye", null);
      await this.#conn?.leave(message);
      return "Left the room. Your collaborator has been told; the room's keys are deleted.";
    });
  }

  // --- helpers -------------------------------------------------------------------------

  async #tool(fn: () => Promise<string>): Promise<ToolResult> {
    let result: ToolResult;
    try {
      result = { text: await fn() };
    } catch (e) {
      const known =
        e instanceof ToolError ||
        e instanceof CollabSendError ||
        e instanceof EnvelopeTooLargeError ||
        e instanceof PassiveSessionError ||
        (e as Error).name === "ShareStringError";
      if (!known) this.#o.log.error("tool_failed", e);
      result = { text: known ? (e as Error).message : "pairwire hit an internal error; details are in its log.", isError: true };
    }
    return { ...result, text: `${result.text}\n\n${this.footer()}` };
  }

  /** The status line every tool result ends with (04 §4, delivery tier D1). */
  footer(): string {
    if (this.#fatal) return "[pairwire] not running: see the error above";
    if (this.#passiveOwner !== null) return `[pairwire] another session (pid ${this.#passiveOwner}) owns this project's room`;
    const state = this.#roomState();
    if (!state) return "[pairwire] not in a room";
    if (!isOpen(state)) return `[pairwire] room ${state.status}`;
    const budget = this.#config?.hopBudget ?? 8;
    const who = state.peer ? `paired with ${this.#peerLabel(state)}` : "waiting for your collaborator";
    const hold = this.#hold();
    const coord = coordFooter(loadView(this.#o.home, state.roomId, { hold, now: this.#now() }).view);
    return `[pairwire] ${who} · ${unreadText(inboxCounts(this.#o.home, state.roomId, hold), harnessOf(this.#o.env))} · hop budget ${Math.max(0, budget - state.hop_count)}/${budget} (resets when your user writes)${coord}`;
  }

  #ready(): Config {
    if (this.#fatal) throw new ToolError(this.#fatal);
    this.#claim();
    if (this.#passiveOwner !== null) throw new PassiveSessionError(this.#passiveOwner);
    return this.#config!;
  }

  /** Re-checks ownership on every call, so a passive session takes over once the owner dies. */
  #claim(): void {
    const own = claimProject(this.#o.home, this.projectDir, this.#claimant(), this.#o.isAlive ?? isProcessAlive);
    if (own.kind === "passive") {
      this.#passiveOwner = own.ownerPid;
      return;
    }
    this.#passiveOwner = null;
    if (own.kind === "owner" && (this.#roomId !== own.roomId || !this.#conn)) {
      if (own.tookOver) this.#o.log.info("took_over");
      this.#open(own.roomId);
    }
    if (own.kind === "idle" && this.#roomId && !this.#roomOpen()) {
      this.#conn?.stop();
      this.#conn = null;
    }
  }

  /** The harness session this server belongs to, if known (04 §3, §10). */
  #session(): string | null {
    return this.#o.env.CLAUDE_CODE_SESSION_ID || this.#learnedSession;
  }

  #claimant() {
    return { pid: this.#pid, session: this.#session(), harness: harnessOf(this.#o.env), harnessPid: this.#o.ppid ?? process.ppid, now: this.#now() };
  }

  /**
   * Codex passes the session only as `_meta.sessionId` on tool calls (04 §10). The first one
   * seen becomes this server's session, and is recorded on a binding that has none.
   */
  noteHarnessSession(id: unknown): void {
    if (this.#o.env.CLAUDE_CODE_SESSION_ID || this.#learnedSession || typeof id !== "string" || id === "" || id.length > 200) return;
    this.#learnedSession = id;
    if (this.#roomId && this.#passiveOwner === null) adoptOwnerSession(this.#o.home, this.projectDir, this.#roomId, this.#pid, id);
  }

  /**
   * Codex's `_meta.threadId` (04 §10, Codex idle wake): the first one seen on a call from this
   * server's own session (or one that names no session) is the thread a wake goes to.
   */
  noteHarnessThread(sessionId: unknown, threadId: unknown): void {
    if (sessionId !== undefined && sessionId !== this.#session()) return;
    this.#codex.noteThread(threadId);
  }

  #open(roomId: string): void {
    this.#conn?.stop();
    const secret = readSecret(this.#o.home, roomId);
    const state = readState(this.#o.home, roomId);
    if (!secret || !state) throw new ToolError("The room's local state is missing.");
    const keys = deriveRoomKeys(secret);
    const hello: HelloPayload = {
      v: 1,
      name: state.name,
      harness: harnessOf(this.#o.env),
      client: `pairwire/${CLIENT_VERSION}`,
      instance: state.instance,
      caps: this.#o.helloCaps ?? HELLO_CAPS,
    };
    const url = `${relayUrl(state.relay ? parseRelayAddress(state.relay) : null)}/v1/rooms/${roomId}`;
    this.#roomId = roomId;
    this.#conn = new RoomConnection({
      home: this.#o.home,
      keys,
      url,
      hello,
      log: this.#o.log,
      events: mergeEvents(
        // Messages and notices (never acks) wake an idle session (D3, or the Codex wake).
        {
          inbound: () => {
            this.#wake();
            this.#codexWake();
          },
        },
        transcriptEvents(
          this.#o.home,
          roomId,
          this.#now,
          (e) => this.#o.log.error("transcript_failed", e),
          () => !!readState(this.#o.home, roomId)?.sessions.current,
          () => this.#conn?.peerHasCollab() ?? false,
        ),
        // After the transcript has the message, so the notice's line follows it.
        { inbound: (entry) => this.#noteHeld(entry) },
        this.#o.events,
      ),
      ...(this.#o.socketFactory ? { socketFactory: this.#o.socketFactory } : {}),
      ...(this.#o.timers ? { timers: this.#o.timers } : {}),
      ...(this.#o.tuning ? { tuning: this.#o.tuning } : {}),
    });
    this.#conn.start();
    this.#closeCtl();
    // start() ends a room that is past its expiry before it returns, deleting secret and
    // ctl.key: no key and no control channel for it then (ADR-029).
    const after = readState(this.#o.home, roomId);
    if (!after || !isOpen(after)) return;
    this.#ctl = this.#listenCtl(roomId, state.ctl_path, keys.roomIdBytes).catch((e: unknown) => {
      this.#o.log.error("ctl_listen_failed", e);
      return null;
    });
  }

  /**
   * The room's control channel (04 §8): ctl.key first (ADR-029), so a client never finds a
   * listener of ours without one, then the listener, which proves itself with that key.
   */
  async #listenCtl(roomId: string, ctlPath: string, roomIdBytes: Uint8Array): Promise<CtlServer> {
    ensureCtlKey(this.#o.home, roomId);
    const key = readCtlKey(this.#o.home, roomId);
    if (!key) throw new Error("ctl.key vanished");
    // Windows: a fresh pipe name on every open, so a name seen while an earlier server ran is
    // useless, and again for each retry when listening fails (04 §8).
    const fresh =
      process.platform === "win32"
        ? () => {
            const path = chooseCtlPath(this.#o.home, roomId, this.#o.env);
            updateState(this.#o.home, roomId, (s) => ({ ...s, ctl_path: path }));
            return path;
          }
        : null;
    return listenFresh(
      fresh ? fresh() : ctlPath,
      fresh,
      (path) => listenCtl(path, (req) => this.ctl(req), this.#o.log, (req, socket) => this.#onWait(req.session, socket), { key, roomIdBytes }),
      CTL_LISTEN_RETRIES,
      (e) => this.#o.log.warn("ctl_listen_retry", { error_message: (e as Error).message }),
    );
  }

  #roomState(): (RoomState & { roomId: string }) | null {
    if (!this.#roomId) return null;
    const s = readState(this.#o.home, this.#roomId);
    return s ? { ...s, roomId: this.#roomId } : null;
  }

  #roomOpen(): boolean {
    const s = this.#roomState();
    return !!s && isOpen(s);
  }

  #requireRoom(): RoomState & { roomId: string } {
    const s = this.#roomState();
    if (!s || !isOpen(s)) throw new ToolError("No open pairwire room in this project. Your user can run /pairwire:start or /pairwire:join.");
    return s;
  }

  /** Size limits and the secret scan (04 §7 steps 2–3), shared by `send` and `leave`. */
  #checkOutbound(body: string, state: RoomState, kind: "chat" | "question" | "answer" | "bye", replyTo: string | null): void {
    serializeEnvelope({
      v: 1,
      id: "0".repeat(26),
      seq: state.my_seq + 1,
      ts: new Date(this.#now()).toISOString(),
      author: "agent",
      kind,
      reply_to: replyTo,
      body,
      acks: null,
    });
    this.#scan([["body", body]]);
  }

  /** The secret scan over every labeled text (04 §7 step 3, INV-5); names rules and offsets, never the match. */
  #scan(texts: readonly [label: string, text: string][]): void {
    for (const [label, text] of texts) {
      const findings = scanSecrets(text);
      if (findings.length === 0) continue;
      const where = findings.map((f) => `${f.rule} at character ${f.offset}`).join(", ") + (label === "body" ? "" : ` in ${label}`);
      throw new ToolError(`Blocked: the message looks like it contains a secret (${where}). Remove it and send again; nothing was sent.`);
    }
  }

  #name(requested: string | undefined): string {
    return requested?.trim() || resolveDisplayName(this.#config!, this.projectDir, this.#o.env);
  }

  #peerLabel(state: RoomState): string {
    return state.peer ? `${displayName(state.peer.name)} (${displayName(state.peer.harness)})` : "your collaborator";
  }

  #recentSends(roomId: string): string {
    const recent = readOutbox(this.#o.home, roomId)
      .filter((e) => e.envelope.kind !== "ack")
      .slice(-5)
      .reverse();
    if (recent.length === 0) return "";
    // The outbox holds a structured kind as its fallback chat; name the kind that was sent.
    const kinds = new Map(readCoordSent(this.#o.home, roomId).map((c) => [c.envelope.id, c.envelope.kind]));
    return ["Your recent messages:", ...recent.map((e) => `- ${e.envelope.id} (${kinds.get(e.envelope.id) ?? e.envelope.kind}): ${e.status}`)].join("\n");
  }

  async #waitFor(cond: () => boolean, ms: number): Promise<boolean> {
    const deadline = this.#now() + ms;
    while (!cond()) {
      if (this.#now() >= deadline) return false;
      await new Promise((r) => setTimeout(r, 25));
    }
    return true;
  }
}

/**
 * "2 unread messages, 1 notice": notices (joins, warnings) are not messages from the peer, and
 * held messages (04 §5, Hold mode) are not unread for the agent. The held part names the
 * human's command in this harness.
 */
function unreadText({ messages, notices, held }: InboxCounts, harness: Harness): string {
  let text = `${messages} unread message${messages === 1 ? "" : "s"}`;
  if (notices > 0) text += `, ${notices} notice${notices === 1 ? "" : "s"}`;
  if (held > 0) text += `, ${held} held for your user's review (${acceptHint(harness)})`;
  return text;
}

/** Calls every handler of each event set, in order. */
function mergeEvents(...sets: (ConnectionEvents | undefined)[]): ConnectionEvents {
  const out: ConnectionEvents = {};
  const keys = ["inbound", "sent", "delivered", "peerChanged", "status", "ended"] as const;
  for (const key of keys) {
    const fns = sets.flatMap((s) => (s?.[key] ? [s[key]] : [])) as ((arg: never) => void)[];
    if (fns.length > 0) (out as Record<string, (arg: never) => void>)[key] = (arg: never) => fns.forEach((fn) => fn(arg));
  }
  return out;
}

/** PAIRWIRE_HARNESS from the plugin config (e.g. "claude-code"); anything unknown is "other". */
function harnessOf(env: NodeJS.ProcessEnv): Harness {
  const h = env.PAIRWIRE_HARNESS?.trim() ?? "";
  return (HARNESSES as readonly string[]).includes(h) ? (h as Harness) : "other";
}
