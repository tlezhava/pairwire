# 01 — Architecture

Status: draft v0.1

## Components

```
 Engineer A's machine                                        Engineer B's machine
┌──────────────────────────────┐                           ┌──────────────────────────────┐
│ Claude Code session          │                           │ Codex / Claude Code session  │
│  ├─ skill (agent guide)      │                           │  ├─ skill / AGENTS.md        │
│  ├─ hooks ──┐ reads inbox    │                           │  ├─ hooks ──┐                │
│  └─ MCP ────┴─ pairwire      │      WebSocket (TLS)      │  └─ MCP ────┴─ pairwire      │
│      client (stdio)  ◄───────┼──── encrypted frames ─────┼───────►  client (stdio)      │
│      ~/.pairwire/ state      │            │              │      ~/.pairwire/ state      │
└──────────────────────────────┘            ▼              └──────────────────────────────┘
                                ┌───────────────────────┐
                                │ Relay                 │
                                │ one room = 2 members  │
                                │ forwards opaque bytes │
                                └───────────────────────┘
```

1. **core** (`packages/core`) — isomorphic TypeScript library: share-string codec, key
   derivation, handshake, AEAD framing, envelope schema, inbound sanitizer, outbound secret
   scanner, and the relay room state machine. No I/O.
2. **relay-worker** (`packages/relay-worker`) — Cloudflare Worker + one Durable Object per
   room, using the WebSocket Hibernation API. The hosted default relay runs this.
3. **relay-node** (`packages/relay-node`) — the same room logic on Node with the `ws`
   package, plus a Dockerfile. For self-hosting outside Cloudflare and for local tests.
4. **client** (`packages/client`) — published to npm as `pairwire`. One executable with
   subcommands:
   - `pairwire mcp` — the MCP server (stdio). Owns the relay connection for its session.
   - `pairwire hook <event>` — hook entrypoints that read the inbox and print hook JSON.
   - `pairwire ctl <continue|say|log>` — human-side control used by slash commands.
   - `pairwire doctor` — checks runtime, config, relay reachability.
   - `pairwire purge` — deletes local state of ended rooms.
   - `pairwire install [--codex|--print-config <harness>]` — non-plugin setups (M6).
   Full list in `04-client.md` section 1.
5. **Claude Code plugin** (`plugins/claude-code`) — manifest, slash commands, skill,
   hooks, and `.mcp.json` pointing at a bundled build of the client.
6. **Marketplace** — `.claude-plugin/marketplace.json` at the repo root, so the GitHub
   repo itself is the plugin marketplace.

## Data flow: sending a message

1. Agent A calls the `send` tool of the `pairwire` MCP server. Claude Code shows its normal approval prompt
   with the message text (INV-4).
2. Client A validates the envelope, runs the secret scanner (INV-5), checks the hop budget
   (REQ-SAFE-4), encrypts with the session send key, and sends a `data` frame.
3. The relay forwards the frame to member B, or buffers it if B is offline.
4. Client B decrypts, validates, checks sequence numbers, writes to its inbox and
   transcript, and sends an encrypted `ack` envelope back.
5. Agent B sees the message through its delivery tier (`04-client.md`): a hook injects a
   wrapped, sanitized copy into context, or the agent reads it with the `inbox` tool.

## Repository layout

```
pairwire/
├── CLAUDE.md
├── README.md
├── KICKOFF.md                    # delete once the project is running
├── specs/                        # source of truth (this folder)
├── packages/
│   ├── core/                     # isomorphic protocol library
│   ├── relay-worker/             # Cloudflare Worker + Durable Object
│   ├── relay-node/               # Node relay + Dockerfile
│   └── client/                   # `pairwire` npm package: MCP server, hooks, CLI
├── plugins/
│   └── claude-code/
│       ├── .claude-plugin/plugin.json
│       ├── commands/             # start, join, status, say, log, leave, continue
│       ├── skills/pairwire/SKILL.md   # generated from specs/06-agent-guide.md
│       ├── hooks/hooks.json
│       ├── .mcp.json
│       └── dist/pairwire.mjs     # bundled client (`npm run build:plugin`), committed on release
├── .claude-plugin/marketplace.json
├── spikes/                       # M0 throwaway code, never imported
└── tests/e2e/
```

## Tech stack

| Concern | Choice | Notes |
|---|---|---|
| Language | TypeScript 5.x, strict, ESM | |
| Runtime | Node >= 20 (client, relay-node); Workers runtime (relay-worker) | |
| Monorepo | npm workspaces | No extra tooling |
| Build | `tsc` for libraries; `esbuild` to bundle the client into one `.mjs` for the plugin | |
| Tests | `vitest`; `@cloudflare/vitest-pool-workers` for the Durable Object | |
| MCP | `@modelcontextprotocol/sdk` | |
| Crypto | `@noble/curves` (X25519), `@noble/hashes` (SHA-256, HKDF), `@noble/ciphers` (XChaCha20-Poly1305) | Audited, pure JS, work in Workers |
| Validation | `zod` | |
| WebSocket (Node) | `ws` | Client and relay-node |
| IDs | `ulid` | Message IDs |

Allowed runtime dependencies are exactly the ones above. Adding another needs the human's
approval (CLAUDE.md rule 6).

## Process model and state

- One MCP server process per agent session. It owns at most **one** room connection.
- A room is **bound to a project directory**: at most one live room per directory per
  machine. This keeps hook ↔ MCP correlation simple (see spike S2 in `tasks.md`).
- All local state lives under `~/.pairwire/` (override with `PAIRWIRE_HOME`), not in the
  harness's plugin data directory, so every harness shares one layout. Details in
  `04-client.md`.

## Versioning

- Wire protocol version is in the share string prefix (`pw1_`) and in every relay URL
  (`/v1/`). A breaking protocol change bumps both.
- The npm package, plugin and relay follow semver independently; the relay advertises the
  protocol versions it speaks at `GET /v1/info`.
