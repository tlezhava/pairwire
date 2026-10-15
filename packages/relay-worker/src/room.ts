// One Durable Object per room, driving the shared RelayRoom state machine (03, Cloudflare
// implementation). Uses the WebSocket Hibernation API only: never ws.accept(), pings are
// answered by the auto-response, and each socket's id and slot live in its attachment.
import { DurableObject } from "cloudflare:workers";
import { RelayRoom, type Member, type Output, type RoomState } from "@pairwire/core";
import type { Env } from "./env.js";

interface Attachment {
  id: string;
  member: Member | null;
}

const STATE_KEY = "state";

export class RoomObject extends DurableObject<Env> {
  #room!: RelayRoom;
  /** Last alarm time written to storage (undefined: not known since this instance started). */
  #alarmAt: number | null | undefined;
  /** webSocketMessage invocations since this instance started; for the hibernation test. */
  handled = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"t":"ping"}', '{"t":"pong"}'));
    void ctx.blockConcurrencyWhile(async () => {
      const state = (await ctx.storage.get<RoomState>(STATE_KEY)) ?? null;
      const sockets: Record<string, Member | null> = {};
      for (const ws of ctx.getWebSockets()) {
        const a = attachmentOf(ws);
        if (a) sockets[a.id] = a.member;
      }
      this.#room = new RelayRoom({ now: () => Date.now(), state, sockets });
    });
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("upgrade required", { status: 426 });
    const { 0: client, 1: server } = new WebSocketPair();
    const attachment: Attachment = { id: crypto.randomUUID(), member: null };
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(attachment);
    await this.#apply(this.#room.connect(attachment.id));
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    this.handled++;
    const a = attachmentOf(ws);
    if (!a) return;
    const out =
      typeof message === "string" ? this.#room.text(a.id, message) : this.#room.binary(a.id, new Uint8Array(message));
    await this.#apply(out);
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    const a = attachmentOf(ws);
    if (a) await this.#apply(this.#room.disconnect(a.id));
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws);
  }

  override async alarm(): Promise<void> {
    this.#alarmAt = null; // a fired alarm is gone
    await this.#apply(this.#room.alarm());
  }

  async #apply(out: Output): Promise<void> {
    const sockets = new Map<string, WebSocket>();
    for (const ws of this.ctx.getWebSockets()) {
      const a = attachmentOf(ws);
      if (a) sockets.set(a.id, ws);
    }
    for (const e of out.effects) {
      const ws = sockets.get(e.socket);
      if (!ws) continue;
      if (e.type === "send") {
        ws.send(e.data);
      } else {
        sockets.delete(e.socket);
        try {
          ws.close(e.code, e.reason);
        } catch {
          // already closing
        }
      }
    }
    // Keep each live socket's slot in its attachment so it survives hibernation.
    for (const [id, ws] of sockets) {
      const member = this.#room.memberOf(id);
      if (member !== undefined && attachmentOf(ws)?.member !== member) ws.serializeAttachment({ id, member } satisfies Attachment);
    }
    if (out.deleteAll) {
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
    } else if (out.persist) {
      if (this.#room.state) await this.ctx.storage.put(STATE_KEY, this.#room.state);
      else await this.ctx.storage.delete(STATE_KEY);
    }
    // Each alarm write is billed; only write when the time changes.
    if (out.deleteAll) this.#alarmAt = null;
    if (out.alarmAt !== this.#alarmAt) {
      if (out.alarmAt === null) await this.ctx.storage.deleteAlarm();
      else await this.ctx.storage.setAlarm(out.alarmAt);
      this.#alarmAt = out.alarmAt;
    }
  }
}

function attachmentOf(ws: WebSocket): Attachment | null {
  return (ws.deserializeAttachment() as Attachment | null) ?? null;
}
