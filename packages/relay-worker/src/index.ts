// Worker entry (03, Cloudflare implementation): validates the path and forwards room
// upgrades to the Durable Object named by room_id. Nothing else is stateful.
import { relayInfo } from "@pairwire/core";
import type { Env } from "./env.js";
import { RELAY_VERSION } from "./version.js";

export { RoomObject } from "./room.js";

const ROOM_PATH = /^\/v1\/rooms\/([^/]*)$/;
const ROOM_ID = /^[a-z2-7]{26}$/;

const text = (status: number, body: string) => new Response(body, { status, headers: { "content-type": "text/plain" } });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (request.method === "GET" && pathname === "/health") return text(200, "ok");
    if (request.method === "GET" && pathname === "/v1/info") {
      return new Response(JSON.stringify(relayInfo(RELAY_VERSION)), { headers: { "content-type": "application/json" } });
    }
    const room = pathname.match(ROOM_PATH);
    if (!room) return text(404, "not found");
    const roomId = room[1]!;
    if (!ROOM_ID.test(roomId)) return text(400, "bad room id");
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return text(426, "upgrade required");
    return env.ROOMS.get(env.ROOMS.idFromName(roomId)).fetch(request);
  },
} satisfies ExportedHandler<Env>;
