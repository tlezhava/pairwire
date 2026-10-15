// The MCP server's state for one agent session (04 §3–4, §7): project ownership, the room's
// connection, and the six tools. Tool methods return text for the agent and never throw.
import {
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
  renderItems,
  scanSecrets,
  serializeEnvelope,
  type Harness,
  type HelloPayload,
  type RenderItem,
} from "@pairwire/core";
import { z } from "zod";
import { bindProject, claimProject, isProcessAlive, PassiveSessionError } from "./binding.js";
import { loadConfig, resolveDisplayName, type Config } from "./config.js";
import { RoomConnection, type ConnectionEvents, type SocketFactory, type Timers, type Tuning } from "./connection.js";
import type { Logger } from "./log.js";
import { roomFile } from "./paths.js";
import { assertStatePrivate } from "./permissions.js";
import { resolveProjectDir } from "./project.js";
import { markDelivered, readOutbox, undelivered, type InboxEntry } from "./room-files.js";
import { createRoom, isOpen, readSecret, readState, updateState, type RoomState } from "./state.js";
import { transcriptEvents } from "./transcript.js";
import { CLIENT_VERSION } from "./version.js";

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
}

/** 04 §7 step 5. */
const SENDS_PER_MINUTE = 20;
const MINUTE = 60_000;
const ULID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

export const sendInputSchema = z.object({
  kind: z.enum(["chat", "question", "answer"]),
  body: z.string().min(1, "body is empty"),
  reply_to: z.string().regex(ULID, "reply_to must be a message id").optional(),
});
export const startInputSchema = z.object({ name: z.string().max(200).optional() });
export const joinInputSchema = z.object({ share: z.string().max(4096), name: z.string().max(200).optional() });
export const leaveInputSchema = z.object({ message: z.string().optional() });

class ToolError extends Error {}

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
  #sendTimes: number[] = [];

  constructor(options: SessionOptions) {
    this.#o = options;
    this.#pid = options.pid ?? process.pid;
    this.#now = options.now ?? (() => Date.now());
    this.projectDir = resolveProjectDir(options.env, options.cwd);
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
    this.#conn?.stop();
    this.#conn = null;
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
      this.#ready();
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
      if (!paired) return "Joined the room; waiting for your collaborator to come online. You'll get a notice when they do.";
      return `Paired with ${this.#peerLabel(state)}. Messages from them arrive as <pairwire_message> blocks; follow the pairwire skill.`;
    });
  }

  send(input: z.infer<typeof sendInputSchema>): Promise<ToolResult> {
    return this.#tool(async () => {
      const config = this.#ready();
      const state = this.#requireRoom();
      if (input.kind === "answer" && !input.reply_to) throw new ToolError("An answer needs reply_to: the id of the question it answers.");
      this.#checkOutbound(input.body, state, input.kind, input.reply_to ?? null);
      if (state.hop_count >= config.hopBudget) throw new ToolError("Hop budget reached. Ask your human whether to continue.");
      const now = this.#now();
      this.#sendTimes = this.#sendTimes.filter((t) => now - t < MINUTE);
      if (this.#sendTimes.length >= SENDS_PER_MINUTE) {
        const wait = Math.ceil((this.#sendTimes[0]! + MINUTE - now) / 1000);
        throw new ToolError(`Rate limit: at most ${SENDS_PER_MINUTE} messages per minute. Try again in ${wait} s.`);
      }
      const sent = this.#conn!.send({ kind: input.kind, body: input.body, reply_to: input.reply_to ?? null, author: "agent" });
      this.#sendTimes.push(now);
      updateState(this.#o.home, state.roomId, (s) => ({ ...s, hop_count: s.hop_count + 1 }));
      return sent.status === "sent"
        ? `Sent (id ${sent.id}). You'll see "delivered" in status once their client receives it.`
        : `Queued (id ${sent.id}): it goes out as soon as your collaborator connects.`;
    });
  }

  inbox(): Promise<ToolResult> {
    return this.#tool(async () => {
      this.#ready();
      // An ended room's last messages (the bye, the notice) must stay readable.
      const state = this.#roomState();
      if (!state) throw new ToolError("No pairwire room in this project. Your user can run /pairwire:start or /pairwire:join.");
      const items = undelivered(this.#o.home, state.roomId);
      const text = items.length > 0 ? renderItems(items.map(toRenderItem)) : "No new messages.";
      markDelivered(this.#o.home, state.roomId, items.map((i) => i.id));
      return `${text}\n\n${this.#recentSends(state.roomId)}`.trimEnd();
    });
  }

  status(): Promise<ToolResult> {
    return this.#tool(async () => {
      const config = this.#ready();
      const state = this.#roomState();
      if (!state) return "No pairwire room in this project. Your user can run /pairwire:start or /pairwire:join.";
      const conn = this.#conn?.status();
      const lines = [
        `Room: ${state.status}${state.error ? ` (${state.error})` : ""}`,
        `Peer: ${state.peer ? this.#peerLabel(state) : "not joined yet"}${conn?.peerConnected ? ", online" : state.peer ? ", offline" : ""}`,
        `Connection: ${conn?.halted ? `stopped (${conn.halted})` : (conn?.socket ?? "offline")}`,
        `Relay: ${state.relay ?? "default relay"}`,
        `Unread: ${undelivered(this.#o.home, state.roomId).length}`,
        `Hop budget: ${Math.max(0, config.hopBudget - state.hop_count)}/${config.hopBudget} left`,
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
      const known = e instanceof ToolError || e instanceof EnvelopeTooLargeError || e instanceof PassiveSessionError || (e as Error).name === "ShareStringError";
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
    const unread = undelivered(this.#o.home, state.roomId).length;
    const who = state.peer ? `paired with ${this.#peerLabel(state)}` : "waiting for your collaborator";
    return `[pairwire] ${who} · ${unread} unread · hop budget ${Math.max(0, budget - state.hop_count)}/${budget}`;
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

  #claimant() {
    return { pid: this.#pid, session: this.#o.env.CLAUDE_CODE_SESSION_ID || null, now: this.#now() };
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
      caps: ["ack", "say"],
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
        transcriptEvents(this.#o.home, roomId, this.#now, (e) => this.#o.log.error("transcript_failed", e), () => !!readState(this.#o.home, roomId)?.sessions.current),
        this.#o.events,
      ),
      ...(this.#o.socketFactory ? { socketFactory: this.#o.socketFactory } : {}),
      ...(this.#o.timers ? { timers: this.#o.timers } : {}),
      ...(this.#o.tuning ? { tuning: this.#o.tuning } : {}),
    });
    this.#conn.start();
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
    const findings = scanSecrets(body);
    if (findings.length > 0) {
      const where = findings.map((f) => `${f.rule} at character ${f.offset}`).join(", ");
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
    return ["Your recent messages:", ...recent.map((e) => `- ${e.envelope.id} (${e.envelope.kind}): ${e.status}`)].join("\n");
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

/** PAIRWIRE_HARNESS from the plugin config (e.g. "claude-code"); anything unknown is "other". */
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

function harnessOf(env: NodeJS.ProcessEnv): Harness {
  const h = env.PAIRWIRE_HARNESS?.trim() ?? "";
  return (HARNESSES as readonly string[]).includes(h) ? (h as Harness) : "other";
}

function toRenderItem(e: InboxEntry): RenderItem {
  if (e.source === "local") return { source: "local", id: e.id, event: e.event, text: e.text };
  return { source: "peer", id: e.id, from: e.from, harness: e.harness, receivedAt: new Date(e.received_at).toISOString(), envelope: e.envelope };
}
