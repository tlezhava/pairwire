# 03 — Relay

Status: draft v0.1 · Implemented in `packages/relay-worker` and `packages/relay-node`,
sharing the room state machine in `packages/core/src/relay-room.ts`

## Job

Match up the two members of a room and forward binary frames between them. Nothing else.
The relay never has the share secret, never decrypts anything, and stores nothing except
short-lived membership tokens and a small buffer of opaque frames for an offline member.

## HTTP surface

| Route | Behavior |
|---|---|
| `GET /v1/rooms/:room_id` (Upgrade: websocket) | Room connection. `room_id` must match `^[a-z2-7]{26}$`, otherwise HTTP 400. Without an `Upgrade: websocket` header: HTTP 426. |
| `GET /v1/info` | `{"protocol":[1],"relay":"<semver>","limits":{...}}` — the limits table below as JSON. |
| `GET /health` | `200 ok` |
| anything else | 404 |

No CORS, no cookies, no auth headers. Responses never include room ids in logs (see
Logging).

## Limits

All limits are constants in `packages/core/src/limits.ts`, shared by both relays and
reported at `/v1/info`.

| Limit | Value | On violation |
|---|---|---|
| Members per room | 2 | close 4001 `room_full` |
| Join deadline | 10 s after upgrade | close 4006 |
| Binary frame size | 64 KiB | `error too_large`, frame dropped |
| Control frame size | 1 KiB | close 4005 |
| Binary frames per member | 60 per minute, burst 20 | `error rate_limited` with `retry_after`, frame dropped |
| Offline buffer per member | 100 frames or 1 MiB, whichever first | `error buffer_full` to sender, frame dropped |
| Buffered frame lifetime | 72 h | silently discarded |
| Room idle expiry | 72 h with no connected member and no frame | room becomes a tombstone; joins get 4003 |
| Room max age | 7 days from creation | sockets closed with 4003; tombstone kept until max age, then all storage deleted |

The rate limit counts **binary** frames only. Control frames are bounded by the control
frame size and the join rules; pings can't be counted anyway, because on Cloudflare the
auto-response answers them without waking the object. The Durable Object keeps its token
bucket in memory, so it resets when the object hibernates. That errs toward leniency and
is acceptable.

Idle expiry is 72 h so a pair can close their laptops on Friday evening and resume on
Monday morning.

Clients must keep their own limits below these: at most 20 messages per minute from
`send` and at most 8 binary frames per 10 s on the wire (`02-protocol.md` §6.2,
`04-client.md`). A well-behaved client therefore never hits the relay's limits.

## Room state machine (`relay-room.ts`)

Pure logic with injected clock and storage, used by both implementations and tested once
with a shared conformance suite (`07-testing.md`).

State per room:

```ts
interface RoomState {
  createdAt: number;               // ms; the first accepted join creates the room
  lastActivityAt: number;          // ms; any frame, connect or disconnect
  epoch: number;                   // +1 on every accepted socket (02 §4.1)
  ended: null | { at: number; reason: "left" | "expired" };   // tombstone: no tokens, no buffers
  slots: { a?: Slot; b?: Slot };
}
interface Slot {
  token: string;                   // base64url(32 random bytes), issued by the relay
  connected: boolean;
  buffer: { at: number; bytes: Uint8Array }[];   // frames waiting for this member
}
```

Events: `connect`, `controlFrame(slot?, json)`, `binaryFrame(slot, bytes)`, `disconnect`,
`alarm`. Outputs: frames to send, sockets to close, state to persist, next alarm time.
Behavior is exactly the membership rules in `02-protocol.md` section 5 plus the limits
above.

## Cloudflare implementation (`relay-worker`)

- The Worker validates the path and forwards the upgrade to the Durable Object whose name
  is `room_id` (`idFromName(room_id)`).
- The Durable Object uses the **WebSocket Hibernation API** (`state.acceptWebSocket`, the
  `webSocketMessage` / `webSocketClose` handlers). It must never call `ws.accept()`
  directly: a plain accepted socket keeps the object billed for the whole connection time.
- Keepalive: `state.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"t":"ping"}', '{"t":"pong"}'))`
  so pings don't wake the object.
- The slot each socket belongs to is stored with `ws.serializeAttachment({ slot })` so it
  survives hibernation.
- Persistent state (tokens, buffers, timestamps) lives in the object's SQLite-backed
  storage. Use the SQLite storage backend for the class (required on the Workers Free plan).
- An alarm enforces idle expiry and max age. When checking idle expiry it treats
  `state.getWebSockets().length > 0` as activity, because auto-answered pings never reach
  the object. Idle expiry and `leave` turn the room into a tombstone (`ended`, no tokens,
  no buffers). At max age the object calls `deleteAll()`. After that, a join **with** a
  token is closed with 4002, because the token matches no slot (`02-protocol.md` §5 rule
  2). Clients treat 4002 like 4003, and they also delete the room locally at the
  `expires_at` reported in `joined`. A token-less join after `deleteAll()` creates a fresh
  room. That is harmless: the original members are gone, and the room's traffic was
  protected by ephemeral session keys.
- `wrangler.toml` contains no account id or secrets; a fresh fork deploys with the button.
  It aliases `@pairwire/core` to `../core/src/index.ts`, so deploying needs only `npm ci`, not a
  prior build of core.
- Cost target: one pairing session (2 connections, about 200 messages) uses well under
  1 GB-s of duration. Hibernation is what makes this true. S5 confirmed in workerd that
  pings never invoke the object and that eviction keeps sockets, slots, tokens and
  buffers; the duration figure itself is read after the first deploy (M2-6).

## Node implementation (`relay-node`)

- `ws` server on `PORT` (default 8787), `HOST` (default `0.0.0.0`).
- State in memory by default. Optional `PAIRWIRE_RELAY_STATE=sqlite:/data/relay.db` for
  restarts without dropping rooms (M7; in-memory is fine for MVP).
- Timers replace Durable Object alarms. The server factory takes an injectable clock so
  tests can exercise expiry and max age (REQ-ROOM-7) without waiting.
- Expects to sit behind a TLS-terminating proxy in production; logs a warning at startup
  if `PAIRWIRE_RELAY_INSECURE_OK` is not set and the server is not bound to localhost,
  reminding the operator that clients require `wss://`.
- Dockerfile: multi-stage, `node:20-alpine` runtime, non-root user, `EXPOSE 8787`,
  `HEALTHCHECK` on `/health`. Image published as `ghcr.io/tlezhava/pairwire-relay` by the
  release workflow (`04` §9), for linux/amd64 and linux/arm64, tagged with the release
  version and `latest`.

## Logging

- Our code logs counts and error codes, never `room_id`, tokens, IP addresses or frame
  contents.
- If a correlation id is needed, log the first 4 characters of `SHA-256(room_id)`.
- Each relay has its own thin logger built on `redact()` from `packages/core` (core does
  no I/O and never logs itself). No `console.log` outside that logger.
- Platform request logs (Cloudflare, a reverse proxy) may record the URL path and so the
  `room_id`. That is acceptable: `room_id` reveals nothing about the keys. Don't add
  anything else sensitive to URLs.

## Self-hosting (REQ-INST-2, REQ-INST-3)

- README section "Run your own relay" with:
  - a **Deploy to Cloudflare** button pointing at `packages/relay-worker`, and
  - `docker run -p 8787:8787 ghcr.io/tlezhava/pairwire-relay` plus a reverse-proxy example
    (Caddy, two lines) for TLS.
- Clients pick up the relay with `PAIRWIRE_RELAY=relay.example.com` or
  `"relay": "relay.example.com"` in `~/.pairwire/config.json`. Share strings created
  against a custom relay carry `@relay.example.com`, so the joining engineer needs no
  configuration.
- A client joining a share string whose relay differs from its own default shows the relay
  host once ("This room uses relay relay.example.com") and proceeds; messages stay
  end-to-end encrypted regardless of who runs the relay.

## Hosted default relay (maintainer)

- Runs `relay-worker` on the maintainer's Cloudflare account, Workers Free plan at first.
- Free-plan limits fail closed (requests error out rather than bill), so the expected
  failure mode under heavy use is temporary refusal, not cost. Move to Workers Paid
  ($5/month minimum) once daily usage approaches free limits.
- Published status: `GET /v1/info` and `GET /health`.
