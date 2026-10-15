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

Status: accepted (2026-10-15, after S2)

Hooks and the MCP server are separate processes; tying a room to the project directory
gives both a shared key (`project_hash`). Cost: two sessions in the same directory can't
both hold rooms (the second runs passive). S2 showed Claude Code gives the MCP server
`CLAUDE_CODE_SESSION_ID`, equal to its hooks' `session_id`, so hooks tell the owning
session apart by session id rather than by walking the process tree.

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

## ADR-015 Toolchain pins (M1-1)

Status: accepted (2026-10-15)

- **TypeScript ~5.9.3.** The latest release is 7.x (the native port), but
  `01-architecture.md` specifies 5.x, and `typescript-eslint` 8 supports only `<6.1`.
  Revisit together with `typescript-eslint`.
- **vitest ^4.1.** `@cloudflare/vitest-pool-workers` (needed in M2-3) required vitest
  4.1, so we don't take vitest 5.
- **vite ^7.3, pinned explicitly.** Vite 8 declares an optional `@vitejs/devtools` peer,
  which resolves to `vitest@*` (5.x) and collides with vitest 4.1.
- **npm 11 for dependency changes.** npm 10.9.3, which ships with Node 20 and 22, crashes
  while resolving vitest's optional peers (`Cannot read properties of null (reading
  'edgesOut')` in `#loadPeerSet`). npm 11.21 resolves the same tree. The lockfile was
  generated with npm 11 and normalized by npm 10, which drops npm 11's `libc` metadata.
  `npm ci` and `npm install` against it work with npm 10, so CI uses the bundled npm.
- **Workspace sources.** Packages export their TypeScript sources under the `source`
  condition. Typecheck (`customConditions`) and vitest resolve those, so tests never
  need a prior build. `dist/` is used only by builds.
- **Core isomorphism, enforced twice.** `packages/core/tsconfig.json` checks `src` with
  `lib: ES2022` and `types: []` (no Node, no DOM), and ESLint forbids Node built-in
  imports and the `process`/`Buffer` globals there.
- **Workers testing (M2-3).** `@cloudflare/vitest-pool-workers` is deprecated and renamed
  `@cloudflare/vitest-plugin`; we use the plugin. Pinned to `1.4.0` with `wrangler 4.149.0`
  (the version it depends on): the oldest release whose miniflare ships `sharp` 0.35.5,
  which fixes a high-severity CVE (GHSA-wq5f-xc86-pv6w) in earlier versions. Tests can fake
  `Date` inside the isolate, so the Durable Object's alarm paths (idle expiry, max age) are
  tested for real; the conformance suite's fake-clock cases run against the in-memory host
  and relay-node only.

## ADR-016 Secret scanner must be linear-time (M1-8 finding)

Status: accepted (2026-10-15)

The first version of the `key|secret|token|password = value` rule was a single regex with
unbounded, overlapping name quantifiers. It took **212 seconds** to scan 24 KiB of
`token-x` repeated. `send` runs the scanner on agent-written bodies, and `redact()` runs it
on log lines that can contain peer text, so that is a denial-of-service vector. The rule is
now a hand-written scan around each `:` or `=` (name up to 64 characters back, value up to
256 forward), and the other rules have bounded or unambiguous quantifiers. A test suite
times every rule on adversarial 24 KiB inputs (budget 250 ms each). Any future scanner rule
must come with such a case.

## ADR-017 Auto mode counts as "no approval" for REQ-SAFE-5

Status: accepted (2026-10-15, human decision after S6)

S6 showed that in auto mode, the human's own default, Claude Code runs `send` with no
approval prompt, and approval prompts offer "switch to auto mode". INV-4 (the plugin never
pre-approves `send`) still holds, but the human-approves-by-default promise then only holds
in default mode. Decision: warn and keep sending. REQ-SAFE-5 now covers `auto` as well as
`bypassPermissions`; the README says that auto mode and "don't ask again" skip approval.
Rejected: refusing to send in auto mode until the human opts in (stronger, but an extra
step per room); documentation only (too weak). The warning channel is decided by spike S1b,
because S1 found `systemMessage` from `UserPromptSubmit` reaches no one.

## Spike findings

### S1 Hook delivery in Claude Code: mostly answered (2026-10-15)

Question: do hook outputs reach the model and the human, which matcher means "all tools",
and how fast is a Node hook? Method: a throwaway plugin (`spikes/s1/`) whose hooks log
their input and inject unique canaries, run by the human in Claude Code 2.1.300 in auto
and default permission modes; a benchmark of 50 cold spawns.

Answer:
- `additionalContext` from `SessionStart`, `UserPromptSubmit` and `PostToolUse` reaches the
  model. `PostToolUse` fires after every tool, built-in and MCP alike.
- A `Stop` hook with `decision: "block"` keeps the agent working and shows it the reason.
  The human sees it as "Stop hook error: <reason>".
- Matchers `"*"`, `""` and none all match every tool. Exec form (`command` + `args`) works,
  with `${CLAUDE_PLUGIN_ROOT}` expanded in `args`.
- Hook context is capped at 10,000 characters. An 11.7 KB injection was saved to a file,
  and the model got a 2,000-character preview plus the path.
- Hooks for one event run in parallel, in no fixed order.
- Timing: cold no-op Node hook 27 ms p50 / 32 ms p95; `sh` fast path about 4 ms; a hook's own
  work about 2 ms.
- `systemMessage` returned from `UserPromptSubmit` was not seen, in a run where two hooks
  (shell and exec copies) served that event. S1b settled the warning channel.

Evidence: `spikes/s1/out/hooks.jsonl` (local, gitignored) and the session transcripts
pasted by the human.

### S1b Which hook output does the human see? (2026-10-15)

Method: a plugin (`spikes/s1b/`) with one hook per event, each returning `systemMessage`
with a numbered marker, plus a `PostToolUse` `additionalContext` asking the agent to repeat
a marker. The human ran one prompt in Claude Code 2.1.300 (default mode) and reported what
appeared on screen.

Answer: `systemMessage` is shown to the human as a grey line "<Event> says: <text>" under
the prompt, tool call or reply for `UserPromptSubmit`, `PostToolUse` and `Stop` (a `Stop`
hook can show one without blocking). It is **not** shown for `SessionStart`. The model
doesn't see `systemMessage`. An instruction in `additionalContext` was relayed by the agent
word for word, but that depends on the model's cooperation. Decision: REQ-SAFE-5 and
REQ-INST-4 warnings use `systemMessage` from the first non-`SessionStart` hook that notices
(`04` §6). Claude Code also labels a Stop block's reason "Stop hook error", so pairwire's
blocking reasons start with a plain explanatory line.

### S2 Project directory and process tree (2026-10-15)

Answer: `${CLAUDE_PROJECT_DIR}` expands in a plugin `.mcp.json` `env`. Claude Code also sets
`CLAUDE_PROJECT_DIR` for the MCP server and every hook, and it stays at the project root
after the agent `cd`s, while the hook input's `cwd` follows the `cd`. The MCP server's cwd
is the project directory. The MCP server and all hooks are direct children of the
`claude` process. The MCP server's environment contains `CLAUDE_CODE_SESSION_ID`, equal to
the `session_id` in its own session's hook input. Across four sessions in the same folder,
each hook's `session_id` matched exactly one MCP server, and the parent-process test agreed.
Decision: hooks gate on session id (ADR-007, `04` §3). The server's environment also holds
`CLAUDE_CODE_MESSAGING_TOKEN`, a credential: pairwire must never log or forward its
environment.

### S6 Send approval UX (2026-10-15)

Answer: Claude Code names the tool `mcp__plugin_pairwire_pairwire__send` and displays it as
"plugin:pairwire:pairwire – Send". The approval prompt shows the full `body` (scrollable,
down to the last line of a 2,000-character message) and the tool's description. Options
are "Yes", "Yes, and don't ask again for plugin:pairwire:pairwire – Send commands in
<project>" and "No". The second writes `"mcp__plugin_pairwire_pairwire__send"` to the
project's `.claude/settings.local.json` `permissions.allow`.

Finding with security impact: in **auto** permission mode (the human's own default),
and whenever that allow rule exists, `send` runs with no prompt at all. Other approval
prompts offer "Yes, and switch to auto mode". INV-4 ("human approves outbound by
default") holds only in default mode; REQ-SAFE-5 now covers it (ADR-017).
