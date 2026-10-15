# Decisions

Newest last. Format: context, decision, consequences. Spike findings use the same format
with "Evidence". Status values: proposed, accepted, superseded by ADR-n.

## ADR-001 Spec-driven development

Status: accepted (2026-10-15)

The protocol and the safety rules must be exact before any code exists, and the project
will be built mostly by coding agents. Specs in `specs/` are the source of truth; code
follows them; changes go through the specs first (CLAUDE.md rules).

## ADR-002 Name: pairwire

Status: accepted (2026-10-15)

`pairwire` was free on npm on 2026-10-15. Plugin name `pairwire`, npm package `pairwire`,
marketplace `pairwire`. Slash commands appear as `/pairwire:<command>`.

## ADR-003 TypeScript monorepo, npm workspaces

Status: accepted

One language across relay (Workers), client (Node) and protocol library; the MCP SDK and
Cloudflare tooling are TypeScript-first. npm workspaces avoid extra tooling.

## ADR-004 Relay: Cloudflare Durable Objects (hosted) + Node (self-host)

Status: accepted

One Durable Object per room fits "two WebSockets in a room" exactly, with hibernation
keeping idle rooms nearly free. The Node relay shares the room state machine and serves
self-hosters who don't use Cloudflare, and our local tests. Users can always point the
client at their own relay; share strings carry the relay host.

## ADR-005 Crypto: PSK-authenticated ephemeral X25519, XChaCha20-Poly1305, noble libraries

Status: accepted — external review required before 1.0

A pure pre-shared-key design would let anyone who later finds the share string (chat logs,
agent transcripts) decrypt recorded traffic. Ephemeral X25519 mixed with the PSK prevents
that at the cost of a small, symmetric handshake. XChaCha20 allows random nonces safely.
`@noble/*` libraries are audited, dependency-free and run in Workers.

## ADR-006 Outbound approval through the harness's own tool prompt

Status: accepted

Building our own approval UI per harness is expensive. Every harness already prompts
before an MCP tool runs, showing its input. The plugin simply never pre-approves `send`.

## ADR-007 One room per project directory

Status: proposed — confirm after S2

Hooks and the MCP server are separate processes; tying a room to the project directory
gives both a shared key (`project_hash`) without needing the harness session id. Cost:
two sessions in the same directory can't both hold rooms (the second runs passive).

## ADR-008 State in `~/.pairwire`, not the harness plugin data dir

Status: accepted

Every harness (Claude Code, Codex, others) shares one layout and one set of tools
(`doctor`, `purge`). `PAIRWIRE_HOME` overrides it for tests.

## ADR-009 Delivery tiers D1/D2/D3

Status: proposed — D3 mechanism decided by S3/S4/S9

Pull (tool + footer) works everywhere; hooks give mid-turn and end-of-turn delivery in
Claude Code; idle wake depends on harness features still being verified. Channels is in
research preview and needs a development flag for third-party plugins, so it can't be
the default.

## ADR-010 Node >= 20 required for the client in v1

Status: accepted, revisit in M7

The plugin runs a bundled `pairwire.mjs` with `node`. Claude Code's native installer
doesn't guarantee Node is present, so `doctor`, the README and a clear error cover it
(REQ-INST-4). A single binary would remove the requirement but adds per-platform builds.

## ADR-011 License

Status: accepted (2026-10-15)

MIT. The human accepted the suggested default during the spec review (ADR-014). The
`LICENSE` file is added with the M1-1 scaffold.

## ADR-012 Reliable, ordered delivery with resend-until-acked

Status: accepted (2026-10-15, after spec review)

Review found several ways messages could be lost silently: a HELLO dropped while the peer
was offline, frames dropped by relay limits, half-open sockets. Senders now keep every
envelope until a cumulative ack covers it and resend under the newest session; receivers
accept strictly in order and re-ack duplicates (`02-protocol.md` §6). HELLOs are bound to
a relay-issued epoch so a stale HELLO can't pair with a new socket.

## ADR-013 Ended rooms are tombstoned

Status: accepted (2026-10-15, after spec review)

Freeing a slot on `leave` would have unsealed the room for anyone holding the share
string. `leave` now ends the room for both members; the relay keeps a tombstone until max
age and tells a returning member the room ended.

## ADR-014 Spec review fixes before M0

Status: accepted (2026-10-15)

The first full read of the spec kit found contradictions and gaps. Each one would have
made two implementers build different things, or opened a safety hole. The human
approved the fixes and the defaults for the open questions. What changed:

- **Envelope size** (`02` §6): the serialized envelope (28 KiB) is the binding limit,
  because JSON escaping can inflate a 24 KiB body several times over.
- **Rate limits** (`02` §6.2, `03`): clients pace at 8 binary frames per 10 s, safely
  below the relay's 60/min. The relay counts binary frames only, since pings never reach
  the Durable Object.
- **Unknown tokens and stale rooms** (`02` §5, `03`, `04` §3): an unknown token always
  gets 4002, even if a slot is free. `joined` carries `expires_at`, and clients delete
  the room at that time, so a stale client can't re-create a deleted room.
- **Local notices** (`04` §5): peer joined, peer left, peer changed and wrong key are
  rendered as `<pairwire_notice>` and delivered by every tier. Acks never trigger
  delivery.
- **Sanitizer** (`04` §5): strips all Cf characters except ZWJ, plus the Unicode tag
  block (invisible "ASCII smuggling").
- **Hooks** (`04` §6, §9): every hook runs through a POSIX wrapper, `hooks/run.sh`.
  If no room is active it exits without starting Node, and a missing Node no longer
  breaks the harness.
- **Bypass-mode warning**: shown once per session (`session_id`), not once per room,
  matching REQ-SAFE-5.
- **HELLOs** (`02` §4.1): one per epoch. The old "replace" rule could leave the two
  sides with different keys.
- **Tombstones** (`02` §5, `03`): no per-slot pending notice. Any join to an ended room
  gets `peer_left` (if left) then 4003. Tokens and buffers are discarded when the room
  ends.
- **`leave` message**: secret-scanned and validated like `send` (INV-5).
- **Traceability** (`07`): missing ids are warnings until M4-6, errors after.
- **Plugin bundle** (`04` §9): `dist/pairwire.mjs` stays current on `main`, because the
  marketplace installs from the default branch.
- **Idle expiry**: raised from 24 h to 72 h so a pair survives a weekend (REQ-ROOM-7,
  `03`).
- **Policy**: dev dependencies and spike code need no approval; runtime dependencies
  still do. Relays log through their own thin logger built on core `redact()`. Owner is
  `tlezhava`, author "Tazo Lezhava". License is MIT (ADR-011).

Still open: the hosted relay host (`workers.dev` vs. own domain), decided before M4-8;
repo visibility, decided before M4-7.

## Spike findings

(Add S1–S9 results here.)
