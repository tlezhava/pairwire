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

Status: accepted (2026-10-16, after S3) — D3 is a `Stop`-hook `asyncRewake` waiter

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

## ADR-018 Room state records its relay; bindings are locked (M3-1)

Status: accepted (2026-10-16)

Writing the state layer showed two gaps in `04` §3. `state.json` didn't record which relay
the room uses, yet a restarted session must reconnect without the share string
(REQ-ROOM-6), and the secret file holds only the 32 secret bytes. It now has `relay`. And
binding updates had no lock: two MCP servers starting together in one project could both
see a dead owner and both take over. Binding updates now take the same `mkdir` lock as
`state.json`.

## ADR-019 Connection-manager details (M3-3)

Status: accepted (2026-10-16)

Implementing the connection manager needed four details `04` §3 left open: the room's own
HELLO `instance` must be stored (`02` §4.2 says it is stable for the life of the room), the
line formats of `inbox.jsonl` and `outbox.jsonl`, and when `peer_joined` fires once
reconnects start. Inbox appends are idempotent by id because the inbox append and the
`peer_max_seq` update are two files and can't be one atomic write; the outbox keeps the
last 5 delivered entries so the `inbox` tool can report delivery status without reading
the transcript. `peer_joined` fires only for the room's first handshake so routine
reconnects don't flood the agent with notices.

## ADR-020 /pairwire:log goes through the renderer (M3-6)

Status: accepted (2026-10-16)

`/pairwire:log` runs `pairwire ctl log` through `!`, whose output becomes part of the prompt.
The transcript holds the peer's message bodies, so printing it raw would be a delivery path
that bypasses INV-3. The excerpt is therefore rendered by core's `renderTranscript()`:
sanitized, wrapped in `<pairwire_transcript>` and preceded by a preamble labeling peer messages
as external input. This tightens `04` §8; INV-3's text is unchanged. The ctl socket protocol
is defined at the same time (one JSON request and reply per connection).

## ADR-021 Release packaging: self-contained npm bundle, one version, tag-triggered workflow (M4-8)

Status: accepted (2026-10-16; one shared version approved by the human)

Preparing M4-8 needed three decisions the specs left open.

- **The npm package is the plugin bundle, not the workspace package.** `packages/client`
  depends on `@pairwire/core`, which is private and never published, so publishing the
  workspace package would install a broken dependency. `npm run pack:npm` instead assembles
  `build/npm/` (gitignored) from the committed plugin bundle: `dist/` with its chunks,
  `hooks/run.sh` and `skills/pairwire/SKILL.md`, plus a generated `package.json` with **no
  dependencies**, the README and the LICENSE. It keeps the plugin's layout because
  `install --codex` and `--print-config` look for `hooks/run.sh` and `skills/` next to
  `dist/` (`04` §10). The package carries no `.claude-plugin/`, so `doctor` doesn't check
  plugin hook wiring there. `packages/client` stays `private` so it can't be published by
  mistake.
- **One version for everything that ships.** `01` said the npm package, plugin and relay
  follow semver independently; with one repository, one tag and one release workflow that
  only invited drift (the plugin said 0.1.0 while the client said 0.0.0). A release tag
  `vX.Y.Z` now sets the version of the npm package, the plugin and both relays.
  `@pairwire/core` is private, bundled into everything and stays at 0.0.0. The wire protocol
  keeps its own version (`pw1_`, `/v1/`).
- **Tags trigger releases; nothing is published from a laptop.** `npm run release --
  <version>` bumps the version everywhere, rebuilds the plugin bundle, runs the checks,
  commits `chore: release vX.Y.Z` and creates an annotated tag locally. It never pushes.
  Pushing the tag runs `.github/workflows/release.yml`: the CI workflow in full, a check
  that every version location equals the tag, then `npm publish --provenance` (with an
  `NPM_TOKEN` repository secret: an npm granular access token with read-write access to the
  `pairwire` package and "bypass 2FA" enabled, since npm no longer issues classic or
  automation tokens; it expires within at most 90 days), the relay-node image for
  linux/amd64 and linux/arm64 to `ghcr.io/tlezhava/pairwire-relay` (tags: the version and
  `latest`), and a GitHub release.
  A tag with a prerelease suffix (`v0.2.0-rc.1`) publishes under the npm dist-tag `next`,
  doesn't move the image's `latest` and makes a GitHub prerelease.

Follow-up (done after 0.1.0): `release.yml` publishes through trusted publishing, with no
token. Background: trusted publishing (OIDC) can only be configured for a package that already
exists on the registry, so the first publish used `NPM_TOKEN`. npm also created a
`0.0.0-stage` placeholder version for that first, staged publish. After it, configure
`.github/workflows/release.yml` as the package's trusted publisher, drop
`NODE_AUTH_TOKEN`/`NPM_TOKEN` from the workflow (the job already has `id-token: write`),
delete the repository secret and revoke the token. That removes the long-lived credential and
the 90-day renewal.

## ADR-022 relay-node SQLite persistence uses node:sqlite and core's RoomState codec (M7)

Status: accepted (2026-10-16; the Docker base image move to Node 24 approved by the human)

`PAIRWIRE_RELAY_STATE=sqlite:<path>` was reserved in `03` but undefined. Decisions:

- **Driver: Node's built-in `node:sqlite`**, so no runtime dependency is added. Checked on
  the official images: Node 20.20 has no such module (`ERR_UNKNOWN_BUILTIN_MODULE`), Node
  22.12 still needs `--experimental-sqlite`, Node 22.13+ has it unflagged but prints an
  `ExperimentalWarning` on first use (seen on 22.20), Node 24.22 has it with no warning.
  The relay keeps Node >= 20 for in-memory state and fails at startup, never silently
  falling back to memory, when SQLite is asked for and missing. The Docker image moves to
  `node:24-alpine` so the documented `sqlite:/data/relay.db` works there.
  `@types/node` stays at 20, so the relay declares the few `node:sqlite` types it uses
  instead of letting Node 22 APIs type-check everywhere.
- **Format: the `RoomState` the state machine already persists.** The Durable Object
  stores that value under one key with structured clone; the Node relay stores the same
  value, one row per room, through a new `encodeRoomState`/`decodeRoomState` pair in
  `relay-room.ts` (JSON with base64url frame bytes, validated with zod on the way in).
  Rejected: a relational schema (a second data model to keep in step with `RelayRoom`),
  and `v8.serialize` (Node encodes typed arrays as its own host objects, so it is neither
  the Workers encoding nor readable, and it can't be validated before it is rebuilt).
- **Restart semantics:** a slot saved as connected is treated as disconnected at startup
  time, and each loaded room gets one `alarm()` call to apply what fell due during the
  downtime and to re-arm its timer. Rewriting every room at shutdown was rejected: a crash
  skips it anyway, so the startup rule has to exist and then covers both.
- **Durability: `synchronous = FULL`.** Rows change only on joins, leaves, buffered
  frames and expiry, so the extra fsync per write is cheap, and a returned write then
  survives power loss, not just a process crash (`NORMAL` in WAL mode can lose the last
  commits on power loss).
- **A failed write does not stop the room.** The relay logs `state_write_failed` and
  sends the output anyway, serving from memory; that state may not survive a restart.
  Rejected: refusing the join or closing the room on a failed write, which turns a
  disk problem into an outage for rooms that would otherwise work until the next
  restart. The guarantee in `03` is therefore "written before the frames are sent, when
  the write succeeds".
- **CI runs the `check` job on Node 20, 22 and 24**, so the real-SQLite tests also run on
  the Node major the Docker image uses (they skip on Node 20).

## ADR-023 Inbound hold mode: messages wait for /pairwire:accept (M5)

Status: accepted (2026-10-16)

Some users want to read what the peer sent before their agent does. M5 adds hold mode
(`hold` in `config.json`, `PAIRWIRE_HOLD`, default off; REQ-SAFE-6; `04` §5, Hold mode).

Decisions:

- **Held is derived, not stored per message.** A peer message is held when hold mode is
  on, it is unread and the human hasn't released it. `delivered.json` gains `released` and
  `dropped` id lists, so the filter, the release and the "mark delivered" step all happen
  under the one `delivered.json` lock that already keeps hooks, the waiter and `inbox` from
  showing an item twice. No new file, and old files stay valid.
- **Every reader re-reads `hold`, and a broken config holds.** The MCP server used to load
  the config once; a server that cached "hold off" while the hooks saw "hold on" would leak
  through the `inbox` tool. The Codex install passes `PAIRWIRE_HOLD` through `env_vars`
  for the same reason (Codex clears the MCP server's environment).
- **`/pairwire:accept` releases by showing.** Its `!` output lands in the prompt, so it is a
  delivery path: it renders through `renderForHook()` (INV-3) and marks what it showed
  delivered. What doesn't fit is released and delivered by the normal paths. Run from a
  terminal (Codex has no `!` commands) it releases only, because its output never reaches
  the agent. It is human-only like `say` (`disable-model-invocation`, a heredoc for the
  argument, `allowed-tools` for exactly `ctl accept`), and no MCP tool releases or drops
  held messages, mirroring INV-6's "no tool resets the budget".
- **Drop exists** (`/pairwire:accept drop`), because a human who reads a hostile message in
  the transcript needs a way to keep it from the agent for good. Its output carries no body.
  Accepting or dropping individual messages by id is left for later.
- **One `held` notice per accept cycle.** Without a signal, an idle session in hold mode
  would sit on messages nobody knows about. A local notice (name only, no text) wakes the
  session once; later arrivals while something is held add none, so a peer cannot drive
  repeated wakes.
- **`/pairwire:log` hides held and dropped bodies.** It is model-invocable and prints the
  transcript into the prompt, so it would otherwise bypass hold mode.
- **Hints follow the harness.** Codex has no `/pairwire:` commands, so in Codex the
  notice, footer, `status`, the `/pairwire:log` placeholder and `ctl accept`'s usage name the
  terminal command (`04` §5, Hold mode, "Hints"). `ctl` runs outside the harness and can't
  see `PAIRWIRE_HARNESS`, so the binding records the owning server's harness
  (`owner_harness`, optional so older bindings stay valid).
- **`ctl accept` doesn't trust its own `hold` setting.** It can differ from the MCP server's
  (`PAIRWIRE_HOLD` set only in the server's environment), and refusing because "hold mode is
  off" would strand messages the server holds. It acts on whatever would be held with hold
  on.
- **A corrupt `delivered.json` fails closed.** Before M5 an unreadable ledger meant "the
  agent may see an item twice". With `dropped` in the same file, that reading would hand the
  agent messages the human dropped, so an unreadable (not missing) file now counts every
  peer message in the inbox as delivered and dropped, and is rewritten that way with a
  warning. The cost is that unread messages at that moment are lost to the agent (they stay
  in the transcript).
- **The sender does not learn "held" in v1.** Acks are sent on receipt as before, so the
  sender sees "delivered" (the peer's client has it). Reporting "held" or "released" would
  need a new envelope kind or ack field (`02` §6), and tells the peer about the receiver's
  review policy; the receiving agent can say so itself once released. Revisit if users find
  "delivered" misleading.

Consequences: the agent can still read held messages through files under `~/.pairwire` if
its harness lets it (`05-security.md`, residual risk 7), and an agent that can run
`pairwire ctl accept` can release them (residual risk 2). Proposed SKILL.md wording for the
new command is not yet in `06-agent-guide.md` §2, which needs the human's approval.

## ADR-024 Native Windows: named-pipe control channel, hooks through Git's `sh` (M7)

Status: proposed (2026-10-16); the Windows CI job and a first Windows session confirm it.
The hook wiring on Windows (decision 1) stays open until that session. Built and tested on
macOS only; Windows code paths take the platform as a parameter so
their pure parts are unit-tested everywhere, and a `windows-latest` CI job runs the rest.

Research (docs only; no Windows machine was used):

- Claude Code on native Windows needs no Git for Windows; without it the agent gets a
  PowerShell tool instead of Bash ([setup](https://code.claude.com/docs/en/setup#install-on-native-windows)).
- Hooks ([hooks reference](https://code.claude.com/docs/en/hooks), "Exec form and shell
  form"): shell form (no `args`) runs `command` with `sh -c` on macOS and Linux, with Git
  Bash on Windows, or with PowerShell when Git Bash isn't installed. Exec form resolves
  `command` on `PATH` and on Windows needs a real executable. Both forms export
  `CLAUDE_PLUGIN_ROOT`. A hook that can't start, or exits with a code other than 0 or 2, is
  a non-blocking error shown in the transcript.
- Git for Windows' default `PATH` option, "Git from the command line and also from 3rd-party
  software", "adds only some minimal Git wrappers to your PATH" (its `cmd` directory), not
  `sh.exe` ([installer source](https://github.com/git-for-windows/build-extra/blob/main/installer/install.iss)).
- Named pipes created with no security descriptor (which is what libuv does) grant full
  control to the creator, SYSTEM and Administrators and read access to Everyone
  ([Microsoft](https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-security-and-access-rights));
  libuv sets `FILE_FLAG_FIRST_PIPE_INSTANCE` on the first instance.

Decisions:

1. **Hooks stay on the one POSIX wrapper, `run.sh`, wired in exec form on every platform**
   (`"command": "sh", "args": ["${CLAUDE_PLUGIN_ROOT}/hooks/run.sh", "<event>"]`), as S1 and
   S3 verified on macOS. Whether that works on native Windows is **unverified**: exec form
   resolves `sh` on `PATH`, which a default Git for Windows install lacks, while shell form
   (`sh "${CLAUDE_PLUGIN_ROOT}/hooks/run.sh" <event>`) would run under Git Bash. Switching
   every platform to shell form for an untested Windows benefit would change wiring verified
   on macOS, so the choice between exec form and shell form under Git Bash is made when a
   Windows Claude Code session can test it (M7 task). No PowerShell variant: `hooks.json`
   cannot select entries by platform, two variants would both run where both shells exist,
   and a script that runs in both shells would be fragile and untestable here. So
   pairwire's hooks require Git for Windows on native Windows (README, `doctor`); without a
   usable `sh` hooks show a non-blocking error and the room works through D1. The no-Node
   fast path is unchanged: with no `active` flag the wrapper exits 0 using shell builtins
   only. `run.sh` uses `USERPROFILE`, forward slashes and `pwd -W` only when `OS=Windows_NT`
   (`04` §6), so its behavior on macOS and Linux is unchanged.
2. **`ctl` is a named pipe on Windows**, `\\.\pipe\pairwire-<tag>-<nonce>`, with a fresh
   random nonce each time the owning server opens the room. The tag alone (as in the
   `/tmp` fallback) would be a fixed name that any local user can read from the pipe list
   once and then hold whenever the server isn't running; the nonce limits that to the time
   between a server's exit and its restart (`04` §8), which decision 6 covers.
3. **INV-9's check stays off on Windows**, as before M7: there are no mode bits, and an ACL
   check would need native code or a child process. Privacy rests on the profile
   directory's inherited ACL; `doctor` warns when the state directory is outside the
   profile. `05-security.md` is unchanged until the human accepts this as a residual risk.
4. `.gitattributes` forces LF checkouts, so Git's CRLF conversion on Windows cannot break
   `run.sh`, the generated `SKILL.md` or the tests that compare text.
5. Path checks use `path.basename`/`path.win32` instead of `endsWith("/dist")`. The INV-2
   import check compares repo-relative paths with `/` separators on every platform.
6. **Owner check before connecting to `ctl_path` (all platforms).** `ctl say`,
   `ctl continue`, the D3 waiter and `wait_cancel` connect only if the binding's `owner_pid`
   is alive. Only the owning MCP server listens on `ctl_path`, so once it has exited whatever
   answers there is someone else: a squatted stale pipe name on Windows or, on macOS and
   Linux, a socket at a reused path. Without the check, `say` text would reach that listener
   and a forged `wake` from it would reach the agent. With it, `say` reports that no session
   is running, `continue` resets the budget in `state.json`, and the hooks exit 0 (`04` §8).
   The check is one `kill(pid, 0)` and needs no protocol change. It does not cover the dead
   owner's pid being reused by an unrelated live process before the next session takes the
   room over; closing that needs the server to prove itself to the client (for example an
   HMAC of a client nonce under a key in the private state directory), which changes the ctl
   protocol and needs the human's decision, so it is not done here. (Done later: ADR-029.)

Not covered: Codex on native Windows (its hook command is `sh "<path>" <event>` and needs
Codex to run hooks through a POSIX shell; unverified), and project-directory case or 8.3
short-name differences between `CLAUDE_PROJECT_DIR` and a hook's `cwd` (both come from
Claude Code, which passes the same value to the MCP server and the hooks).

## ADR-025 Skip and ack envelopes the receiver can't use (0.1.1)

Status: accepted (2026-10-16)

The M5 design review found that 0.1.0 wedges on any envelope it can't parse. `02` §6.1 said
to drop unknown kinds and schema failures; the client dropped them without acking and without
advancing `peer_max_seq`, so the sender resent the frame every 15 s and every later message
from that sender was dropped as out of order, for good. Any future kind, or an extra field on
an old one, would therefore break rooms with 0.1.0 clients.

Decision: such an envelope is skipped but still counts for ordering when it carries a usable
`seq` (advance when next in order, ack, ack duplicates), and the agent gets one
`peer_unreadable` notice per connection so the humans know something didn't arrive. The peer
is authenticated (the frame decrypted under the session key), so letting its `seq` advance
the counter gives it nothing it couldn't already do by sending a valid message. This must
ship (0.1.1) before any client sends new kinds; M5 still gates new kinds on a capability so
newer clients don't send them to 0.1.0 peers.

## ADR-026 Single-binary distribution: not now (M7)

Status: accepted (2026-10-16)

A spike (branch `wf/sea-spike`, `spikes/sea/`) built the client as a Node single executable,
a Bun binary and a Deno binary for macOS arm64; all three ran `mcp`, `doctor`, the hooks and a
full pairing. They cost 65 to 110 MB per OS and architecture (the Node one is over GitHub's
100 MB file limit), need per-platform release builds and code signing to pass Gatekeeper and
SmartScreen, and don't fit a plugin that the marketplace installs from git. An independent
review of the measurements showed most of the hook-start gain came from things that need no
binary: `run.sh` now remembers the Node version check and the client enables Node's compile
cache, which took the hook from about 75 to 53 ms p50 with a room active. Node >= 20 stays a
requirement (ADR-010). If it is revisited, `bun build --compile` (all targets from one machine,
about 17 ms starts) with a first-run download into `${CLAUDE_PLUGIN_DATA}` and a pinned
checksum is the starting point.

## ADR-027 Structured message kinds: heads-up, claims, contracts (M5)

Status: accepted (2026-10-16, approved by the human). Proposed on branch
`wf/m5-kinds-proposal`; reconciled with 0.1.1 (ADR-025) on acceptance, see the last list.
Amended by ADR-028 (contract versions and names, the view's cost, the outbox shape).

The M5 task asks for structured kinds `heads_up`, `claim`/`release` and
`contract_propose`/`contract_response` "with a checked-in contract file". The spec text is
in `02-protocol.md` §6.3, `04-client.md` (sections 3, 4 and 5, "Structured kinds" /
"Coordination state"), `05-security.md` ("Structured kinds", residual risks 9 to 12),
`06-agent-guide.md` §2 ("Coordination messages") and `07-testing.md` ("Structured kinds").

**Finding: 0.1.0 wedges on an unknown kind.** The task assumed receivers drop unknown kinds
harmlessly. They don't. 0.1.0's `parseEnvelope()` returns `unknown_kind`, and its receive
path drops the frame without an ack and without advancing `peer_max_seq`. Every later frame
from that sender is then out of order and dropped too, while the sender resends the unknown
envelope every 15 s. The room is wedged in that direction for good. The same holds for any
envelope 0.1.0's strict schema rejects, including an old kind with `"data": null`. 0.1.1
fixed the receive side (ADR-025), but 0.1.0 clients exist, so a new kind must never reach a
client that doesn't advertise it, and that shapes the whole design.

Decisions:

- **No new MCP tools, hooks, locks or repository files.** `send` takes five more kinds and
  a few optional fields; `status`, `inbox` and the footer show more, read-only. pairwire
  never writes in either repository, never reads a path the peer named, and never turns a
  claim into a permission rule or `PreToolUse` deny (INV-2, INV-8).
- **One new envelope field, `data`.** It is required on the five M5 kinds and absent (not
  null) on the old ones, so an old-kind envelope from an M5 client is byte-for-byte the
  shape 0.1.0 accepts. Each kind's `data` is a strict object; any later shape change needs a
  new capability (`collab2`), never a looser schema. `v` stays 1.
- **Capability gate with a fallback to chat.** HELLO caps gain `collab1`. The client
  records the caps of the HELLO behind each stored session, and the encoding is decided when
  a frame is encrypted: structured under a `collab1` session, otherwise a `chat` with the
  same id and seq whose body is a header line plus the original body. The fallback body is
  built, secret-scanned and size-checked at send time and stored in the outbox, so a resend
  after a downgrade never builds unreviewed text. Falling back instead of refusing keeps one
  approval and one code path for queued messages, downgrades and upgrades.
- **Unreadable envelopes: ADR-025's skip and ack.** An envelope that decrypts but fails
  validation (unknown kind, invalid `data`, `author: "human"` on an M5 kind, bad inline
  content, an extra field) counts for ordering, is acked, is shown to nobody, and queues one
  `peer_unreadable` notice per connection. M5 adds no second mechanism.
- **Structured kinds require `author: "agent"`,** so nobody can present a claim or a
  contract decision as typed by the collaborator.
- **Paths are bounded.** Project-relative `RelPath` with `*`, `**` and `?` only, first
  segment literal, no `.`/`..` segments, no `\` or `,`, no invisible characters; at most 20
  per message. Contract paths additionally have no globs and no dot-segments (keeps out
  `.git`, `.github`, `.claude`, `.env*`). At most 16 active claims per side count; extra
  ones are shown with `match="over_limit"`.
- **The view is computed, not stored.** `coordView()` in core derives claims and contracts
  from the peer's messages in `inbox.jsonl` (held and dropped ones left out) and a new
  append-only `coord-sent.jsonl` (our own structured sends, so they outlive outbox pruning).
  References resolve per side, keyed by (side, id): the peer can only end its own claims and
  answer our proposals.
- **A fixed `match` attribute instead of silent effects.** Every claim, release, proposal
  and response renders with a client-computed `match` (`yes`, `over_limit`,
  `unknown_claim`, `not_their_claim`, `already_released`, `stale_version`,
  `unknown_proposal`, `not_your_proposal`, `hash_mismatch`, `already_answered`,
  `superseded`). Only `yes` changes the view. Mismatches are still shown, so the agent and
  the human see a peer trying to release our claims or answer its own proposal. The
  preamble and the guide say to trust only attributes the client adds.
- **Clocks.** Claim expiry is local: `received_at` (or our `sent_at`) plus the TTL, capped at
  the room's `expires_at`. The peer's `ts` is never used. The first valid response to a
  proposal wins.
- **Contracts have a name and a version** and the view is keyed by name, so a frontend and a
  backend in separate repositories can agree on one contract stored at different paths.
  `path` and `rev` record where the proposer keeps it. The client sets `version` (one more
  than the highest it knows), and equal versions proposed at once are ordered by id, so both
  sides compute the same live proposal.
- **"Checked-in contract file"** means an ordinary file in the proposer's repository that
  the agent or human writes and commits with their own tools, under harness approval.
  pairwire hashes it on the sender's side only and runs no git command; `rev` is optional.
  Ref-only proposals (the default) send the hash; inline proposals also send the content,
  given in the tool input so the approval prompt shows the exact bytes, checked against the
  file and required to be sanitizer-invariant so the receiver can verify the hash against
  what its agent reads. Accepting may name `local_path`, the receiver's own copy: the client
  hashes it and refuses a mismatch, so "accepted" can mean both repositories hold identical
  bytes, and `status` can then show "in sync", "changed locally" or "missing" for paths the
  local agent named.
- **Contract file reads are confined.** One function reads them: `ContractPath` only,
  realpath inside the project, regular file, at most 1 MiB, not a sensitive name, content
  passes the secret scanner. Otherwise a peer could ask the agent to "propose `.env`" and
  receive a hash oracle for a low-entropy secret.
- **Held messages stay invisible.** The view leaves out held and dropped messages, and `send`
  gives a held id the same "unknown id" error as a nonexistent one.
- **The audit trail is git, not pairwire.** The guide suggests committing an agreed
  contract with the message `contract: <name> v<n> (pairwire <id>)`; pairwire writes no
  ledger file.

Alternatives rejected:

- *Refuse the send when the peer lacks `collab1`.* Two approvals, and queued messages and
  downgrades would need a second path anyway.
- *`"data": null` on old kinds.* Wedges 0.1.0 receivers (strict schema).
- *Claims as `PreToolUse` denies.* Gives the peer permission decisions on the receiver's
  machine (INV-2, INV-8).
- *Keying contracts by path.* Breaks pairs whose copies live at different paths.
- *A new tool per kind.* More approval surfaces and tool descriptions for the same pipeline.

The proposal's open questions, as approved: ack-and-skip is ADR-025's (already shipped);
fall back to chat rather than refuse; the hash is always present while git tracking and
`rev` stay optional (pairwire runs no git); no `PostToolUse` claim notice; structured kinds
are delivered like `chat` (no passive delivery); `release` counts toward the hop budget;
REQ-COLLAB-1..7 are M5 requirements; the SKILL.md text is in `06` §2; the limits stand (16
active claims per side, TTL 5 to 1,440 minutes with default 120, 20 paths, 50 contract
names, 16 KiB inline content, 1 MiB contract files); claim expiries may differ between the
sides by transit or buffering time; a human-only `ctl contracts` stays a later idea; and
INV-2 and INV-8 keep their text.

Changes on acceptance, reconciling the proposal with 0.1.1 (ADR-025), which shipped after it
was written:

- The proposal's own ack-and-skip (`02` §6.3.5: an "orderable" test, a quarantine line in
  `inbox.jsonl`, a transcript line, a notice "if none is unread", and a `skip_unknown` cap)
  is dropped. ADR-025's rule covers M5 kinds with bad data unchanged, and a cap that every
  0.1.1 client lacks while behaving exactly that way would gate nothing.
- The caps of each stored session live in `rooms/<room_id>/caps.json`, keyed by session id,
  instead of new fields in `state.json`. 0.1.x reads `state.json` with a strict schema and
  refuses a file with unknown fields, so a user who goes back to 0.1.1 in an open room would
  be locked out of it; an extra file is ignored. A session without an entry has no
  `collab1`, so a crash between the two writes only causes a chat fallback. The proposal's
  `peer.caps` had no reader and is dropped.
- `coordView()` takes the visible messages of both sides, the room's state and the time;
  the client leaves out held and dropped messages before calling it (they were the
  `ledger` argument).
- Overlap is defined on literal segments (`02` §6.3.4), which is the proposal's
  "segment-boundary prefix" made exact for patterns whose first glob is mid-segment.
- The `send` result stays text: the proposal's fields are extra lines.
- The transcript heading of our `contract_response` doesn't name `local_path` (the
  connection's `sent` event carries only the envelope); `status` shows it.

## ADR-028 Structured kinds: review hardening of contracts, the view and the outbox (M5)

Status: accepted (2026-10-17). Amends ADR-027 before M5 ships; no released client sends
structured kinds, so nothing on the wire changes for 0.1.x.

The M5 implementation review found four gaps in ADR-027 as specified:

- **An answered contract could be replaced at the same version.** Equal versions were
  ordered by envelope id, and the peer picks its own ULID. A peer that had accepted our v1
  could send its own v1 with id `7ZZZ…`; it became the live proposal, ours turned
  `superseded`, and "v1" named different bytes, which is the "you already accepted v3"
  confusion the view exists to prevent. Decision: the id tie-break applies only while the
  live proposal is `pending` (the simultaneous-proposal case it exists for). Once it is
  answered, a proposal of the same or a lower version gets `stale_version` (`02` §6.3.4).
- **Names and versions could be squatted.** The 50-name limit was shared, so a peer's 50
  names made every later proposal of ours `over_limit` (and `send` didn't check, so our
  agent was told "Sent" for a proposal its own view left out). A peer could also propose any
  name at version 1,000,000, after which our client refused to propose under it. Decision:
  a name counts against each side that has proposed under it, a new name is `over_limit`
  when its sender already has 25 (so 50 in all, as ADR-027 approved), and `send` refuses a
  new name past our own 25. A proposal more than one version above the highest seen gets
  the new `match` value `version_gap`, and doesn't move the highest version. Counting a name
  for every side that proposed under it, rather than for the side that first made it live,
  keeps both views equal when both sides introduce a name at once. The cost: if a human drops
  (hold mode) a proposal, the sender's next version shows as `version_gap` on that side; a
  new name gets past it.
- **The view was quadratic in the number of claims.** Each claim filtered every claim seen
  so far, and the view is rebuilt on every hook, tool result and status. 10,000 claims took
  about 300 ms, and the relay allows a peer far more over a room's 7 days. Decision:
  `coordView()` keeps a working set of at most 16 counted, possibly active claims per side,
  pruned before each check (messages come in time order), so it is linear; a core test
  holds 50,000 claims to a fixed time budget.
- **Going back to 0.1.1 could stall a room.** ADR-027 stored the structured envelope and a
  new `fallback_body` key in `outbox.jsonl`. 0.1.1's strict schemas skip such lines and its
  next rewrite of the file drops them, while `my_seq` already counts their seqs, so the peer
  would drop every later message from that user as out of order (`02` §6.1). Decision: the
  outbox keeps the 0.1.x shape and holds the fallback chat envelope; the structured envelope
  stays only in `coord-sent.jsonl`, now written by the connection's `send` just before the
  outbox append, and the pump sends it in place of the chat under a `collab1` session. A
  downgraded client resends the chat with the same id and seq. Reading the file with a copy
  of 0.1.1's schemas is a client test.

Also clarified: REQ-COLLAB-6's "send anything" and the INV-6 analysis in `05` exclude the
protocol's ack, which every accepted message gets (`02` §6.1).

## ADR-029 Control-channel server proof: HMAC challenge under a per-room key (M7)

Status: accepted (2026-10-17, approved by the human). Proposed on 2026-10-16 as "ADR-026" on
the `wf/m7-security-proposals` branch and revised there after an adversarial review (below);
it is renumbered here because main had taken ADR-026 to ADR-028 meanwhile. The short
authentication string proposal on that branch was not approved and is not part of this ADR.
Spec text: `04-client.md` section 3 and section 8 ("Control-channel server proof"),
`05-security.md` INV-10 and residual risk 8, `07-testing.md`.

Context. ADR-024's owner check (decision 6) refuses to connect when the binding's owner pid
is dead, but not when that pid was reused by another live process while someone else holds
the stale `ctl_path` (a pipe name on Windows; on POSIX a socket in a fallback directory
another user created first). Such a listener could read `ctl say` text and send a forged
`wake` that reaches the agent through the D3 waiter, or a forged reply that lands in the
prompt. ADR-024 left closing this to the human, who approved this design.

Decisions and why:

1. **Challenge-response before the request.** The client sends
   `{"op":"hello","v":1,"nonce":…}` and requires
   `HMAC-SHA256(ctl_key, "pairwire/v1/ctl-proof" || room_id_bytes || nonce)` back before it
   writes its request or trusts any reply. One local round trip; the rest of the JSON-line
   protocol is unchanged. Replies carry no MAC: after the proof, the connection's other end
   is the proven process. The proof cannot be relayed: a squatter would need write access
   to the real server's socket (0600) or pipe (default descriptor: write for the user,
   SYSTEM and Administrators only), and an account with that access can read `ctl.key`
   anyway.
2. **A random per-room key in `rooms/<room_id>/ctl.key`**, created by the owning server
   before it listens, kept for the room's life, deleted with `secret`. Not derived from the
   share secret, which the peer knows (both members can run on one machine). Not rotated per
   server start: the attacker it addresses cannot read the file anyway, and rotation would
   add a race with clients that read the key just before a restart.
3. **The key file's presence is the switch.** Rooms without `ctl.key` (0.1.x servers) keep
   today's behavior; a binding or `state.json` flag would break 0.1.x readers, whose schemas
   are strict. New servers keep accepting unproven 0.1.x clients, because server-side trust
   does not change.
4. **Fail closed.** On any proof failure, nothing but the `hello` was sent: `say` and
   `continue` print a fixed message (and `continue` does not fall back to `state.json`), the
   waiter exits 0 without waking, `wait_cancel` gives up. A `ctl.key` that exists but can't
   be read as 32 bytes fails the same way. Going back to 0.1.x after a newer server created
   the key fails closed the same way until the user deletes `ctl.key`; `doctor` says so.
5. **No client proof.** It would not change residual risk 2 (an agent that can run
   `pairwire ctl` can read `ctl.key`), and the server's trust in same-user clients is
   unchanged.
6. **Windows listen retry.** If listening fails (`EADDRINUSE` or any other error), the
   server picks a fresh pipe nonce, records it and retries, up to 3 times, then runs without
   a control channel and logs `ctl_listen_failed`. The spec defined no behavior for that
   failure before.

Consequences. A small core function (`ctlProof`, `@noble/hashes` HMAC) and a vector; ctl
clients read one more file; `doctor` gains a check; INV-10 joins the invariants. INV-9's
text is unchanged; its check already covers every file in a room directory, `ctl.key`
included. On Windows the proof is only as strong as the state
directory's ACL (residual risk 8), and it does not address a privileged pipe squatter
impersonating the client's token at connect time (unverified). Closing that needs native
code, a new runtime dependency the human has not approved.

### Adversarial review (2026-10-16)

One finding of the review concerned this proposal: *a squatter that creates the pipe name
before the owning server restarts makes the real server's listen fail, and a privileged
squatter can impersonate the client before the proof runs.*

- **Premise rejected for the restart case.** The Windows pipe name already ends in a
  128-bit random nonce chosen anew each time a server opens the room, recorded in the
  private state directory before listening (`04` section 3, ADR-024), so a squatter cannot
  create the next name in advance; it can only hold an old one, which the proof covers.
- **Accepted as hardening:** the listen retry with a fresh nonce (decision 6).
- **Accepted as a correction:** the "cannot be relayed" claim states the access it
  depends on (write access to the real pipe or socket) and why the accounts that have it
  are out of scope (they can read `ctl.key`).
- **Rejected for now: opening the pipe with `SECURITY_SQOS_PRESENT |
  SECURITY_IDENTIFICATION`.** Node exposes no way to pass those flags, so it needs a native
  shim, which is a new runtime dependency and needs the human's approval (CLAUDE.md). The
  impersonation gap stays in residual risk 8, limited to squatters holding
  `SeImpersonatePrivilege` (service accounts, not ordinary users).

### Implementation review (2026-10-17)

A review of the implementation on `feat/ctl-proof` found five gaps; none changes INV-10's
text or the protocol.

- **Expiry brought the key back.** `start()` ends a room past its expiry, deleting
  `secret` and `ctl.key`, before it returns; the server then created a new key and
  listened. It now skips the key and the listener unless the room is still open, so the key
  goes with `secret` on expiry as decision 2 says.
- **A crash could brick a room.** The key was created under its final name and then
  written, so a crash in between left a short `ctl.key` that every client refused and no
  restart replaced. It is now written under a temporary name and published with a hard
  link (exclusive, atomic). A regular file of the wrong length is replaced with a rename:
  no client can have used it, so this is not a rotation, and a rename never leaves
  `ctl.key` missing, which would let clients fall back to talking without the proof.
  Anything else the client refuses (a symlink, a file that isn't private) is left alone
  and fails closed; `doctor` says to delete it and restart the session.
- **The hooks didn't check the key's privacy.** INV-10 rests on `ctl.key` being private,
  but the waiter and `wait_cancel` never run INV-9's check. The client now refuses a key
  that is a symlink, not a regular file, not the user's, or has group or world bits (POSIX;
  on Windows the ACL is not checked, residual risk 8), in every client.
- **`doctor`'s downgrade advice could be induced.** Any listener can answer `hello` the way
  0.1.x does. Telling 0.1.x apart would need a version record 0.1.x never writes and a new
  state file; for an advice that only a mixed install ever needs, `doctor` instead warns
  that any program can answer this way and that the user should delete `ctl.key` only when
  sure the session runs 0.1.x. Deleting stays the user's act.
- **`continue` fell back on a missing reply.** A server that accepted, proved itself and
  sent no reply led `ctl continue` to write `state.json` behind a live owner. It now falls
  back only when nothing accepts the connection (or the owner pid is dead).

## ADR-030 Sanitizer and scanner hardening after the internal review

Status: proposed (2026-10-18), from the internal pre-1.0 security review (`inject` area).
Spec text: `04-client.md` section 3 (Peer identity), section 5 (steps 2 and 3, the test
vectors, Hold mode) and section 7 step 3; `02-protocol.md` §6.3 (inline content);
`05-security.md` residual risks 13 and 14; `06-agent-guide.md` section 2; `07-testing.md`.
No INV-* text changes: these bring the code into line with INV-3 and INV-5 as written and
tighten their mechanisms.

1. **Tag look-alikes hidden by joining characters (high).** Step 3 allowed only
   whitespace between `<`, `/` and the keyword, and step 2 deliberately keeps ZWJ, so
   `</\u200Dpairwire_message>` survived and closed the wrapper; so did a CGJ, a variation
   selector, a Hangul filler or a combining mark there. The same worked for a display
   name closing `<pairwire_notice>`, for inline contract content (which passed the
   invariance check) and for `<pairwire_transcript>`. Decision: step 3 matches a
   skeleton. After each `<` (and its compatibility forms U+FE64, U+FF1C) it skips
   whitespace, combining marks and default-ignorable code points anywhere, allows a
   slash or two (`/`, `\` or a listed look-alike; two for JSON's `<\/`), folds the other characters by NFKD without
   marks and lowercased, and checks whether they begin with one of the keywords. Matching
   anywhere in the name (not only after `<` and `/`) closes `pair\u200Dwire_message` too;
   the folding closes fullwidth letters, ligatures and U+212A. It is a hand-written scan
   rather than a regex: it stops at the first character that is neither skippable, the
   slash, nor the next keyword letter, and `<` is never one of those, so each character is
   examined for at most one `<` and the step is linear without a fixed look-ahead bound.
   The keyword list is unchanged; `pairwire` already covers every element pairwire emits.
   More text now has its `<` turned into `‹` (for example `<s y s t e m`), which is
   harmless; the cost of a false negative is a forged harness tag. Removing ZWJ outside
   emoji sequences was the alternative; it would still leave the other joiners and marks.
2. **The scanner and the sanitizer disagreed (medium).** The scanner's de-splitting copy
   removed Cf and the tag block only, while the receiving sanitizer also removes C0/C1
   controls and DEL and applies NFC, so `ghp_` + `\u0001` + … or a share string with
   U+212A passed the scan and reached the peer's agent intact (`parseShareString` even
   accepts the Kelvin form). Decision: the scanner checks the body as the peer's agent
   reads it: every character the sanitizer removes, plus combining marks and every
   default-ignorable code point, is taken out, and each remaining character is replaced
   by its NFKC form, with offsets mapped back to the original. `redact()` uses the same
   scan, so the logging backstop covers these forms too. Printable-ASCII text skips the
   copy. Rejecting outbound controls outright was the simpler alternative, but it would
   change the envelope rules for every sender and still miss the NFKC look-alikes.
3. **Invisible characters outside Cf survived (low).** Variation selectors (including the
   256-character supplement, one byte each), CGJ and the Hangul fillers carry a hidden
   payload as well as the tag block did, and the human sees only an emoji in hold-mode
   review or the transcript. Decision: step 2 removes U+E0100–U+E01EF, U+034F, U+115F,
   U+1160, U+3164, U+FFA0 and U+180B–U+180D, U+180F, and keeps U+FE00–U+FE0F only
   directly after a base character (General Category L, N, P or S), one per base, which
   is all emoji presentation and standardized variation sequences need. Inline contract
   content containing any of these now fails the invariance check and is unreadable
   (§6.3.5) to an updated client; a 0.2.0 client still accepts it. Paths keep their
   schema; the sanitizer removes these characters when they are rendered.
4. **`peer_changed` notices were unbounded (low).** Every HELLO with a new name queued a
   notice, local notices are never held and every notice wakes an idle session, so a peer
   reconnecting under new names had an unreviewed 40-character channel and a wake flood in
   hold mode. Decision: a `peer_changed` notice is queued only when no earlier one for the
   room is undelivered, like `held`. The transcript still gets a warning for every change
   (it now comes from the connection's `peerChanged` event rather than the notice), so the
   human's record is complete. Residual risk 13 documents the display-name channel.
5. **The guide overstated `author="human"` (low).** `author` is set by the sender's
   client, and the renderer copies it, but the guide told the agent the collaborator typed
   such a message. Decision: `06` section 2 says it is the collaborator's client's claim,
   which pairwire can't verify, and that it carries no more authority than other peer
   messages; residual risk 14. This changes the text agents receive (SKILL.md), so it
   needs the human's approval with this ADR.

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

### S8 `!` execution in plugin commands (2026-10-15)

Method: a plugin (`spikes/s8/`) whose commands run a recorder script through `!`, used by
the human in Claude Code 2.1.300 (default mode) in a scratch folder holding a sentinel file.

Answer:
- A command's `!` line runs before the model sees the prompt, without a permission prompt
  when `allowed-tools` matches; its output replaces the line. Without `allowed-tools` the
  line is blocked ("This command requires approval") and nothing runs.
- `${CLAUDE_PLUGIN_ROOT}` is substituted into the command text, but not set in the
  process's environment. The process's cwd is the project directory.
- `$ARGUMENTS` is pasted raw. With `it's "quoted" $(touch PWNED) \`whoami\` ; rm sentinel`
  as arguments to `"$ARGUMENTS"`, Claude Code refused to run the command ("Quoted text in
  this command can't be checked before it runs"); nothing ran. Fail-safe, but unusable for
  ordinary text.
- A quoted heredoc in a fenced `!` block delivered the same text byte for byte on stdin,
  with no prompt and no side effects (no `PWNED`, sentinel intact).
- `allowed-tools: Bash(node:*)` also pre-approved the agent's own `node …` Bash call in the
  same turn (no prompt); in the next turn the same call prompted again.
- The agent can run a plugin command itself via the Skill tool, behind a "Use skill?"
  prompt. With `disable-model-invocation: true` the command is hidden from the agent, and
  the human can still run it.

Decision: `say` and `continue` stay in M3/M4 using the rules now in `04` §8.

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

### S3 Idle wake via `asyncRewake` (2026-10-15/16)

Method: a plugin (`spikes/s3/`) whose `Stop` hook starts a waiter (`node waiter.mjs`,
`"async": true, "asyncRewake": true`) that polls for a trigger file, then writes a canary
to stderr and exits 2; a `UserPromptSubmit` hook logs its input. Every waiter logs
armed/woke/timeout/signal events. The human ran it in Claude Code 2.1.30x (2.1.301 at the end) in
two rounds (waiter limit 900 s, then none with hook `timeout: 86400`); I touched the
trigger from outside while the session was idle.

Answer:
- **Wake works.** About 50 ms after the trigger, the idle session started a turn; the
  human saw "Stop hook feedback", and the agent relayed the canary.
- **What the agent sees:** a user turn whose prompt is
  `<task-notification>\n<summary>Stop hook feedback</summary>\n</task-notification>` plus a
  system reminder "Stop hook blocking error from command \"Stop\": <stderr>".
  `UserPromptSubmit` fires for it with that prompt, so pairwire must not treat such a
  prompt as human input (hop budget, INV-6).
- **Re-arming:** the woken turn's end starts a new waiter, so wakes repeat.
- **A waiter that exits 0 does nothing**, and nothing replaces it until a turn ends. In
  round 1 the waiter's own 900 s limit expired and the session stayed unwakeable.
- **Lifetime:** with `timeout: 86400` a waiter lived 80 minutes (until `/exit`); the
  24 h limit itself wasn't reached.
- **Typing first:** the pending waiter is **not** stopped when the human submits a prompt,
  and the new turn's end starts another: two were pending at once.
- **Session end:** on `/exit`, Claude Code sent SIGTERM to both pending waiters at the same
  instant; no orphans.

Decision: D3 is the `stop-wait` waiter (`04` §6), ADR-009 accepted. The MCP server
keeps one waiter per session; hooks cancel it when the session is busy; it has no timer of
its own; `UserPromptSubmit` doesn't reset `hop_count` for `<task-notification>` prompts.
S4 (Channels) and S9 (plugin monitors) are not needed for the MVP and were not run.

Evidence: `spikes/s3/out/waiters-run1.jsonl` and `waiters.jsonl` (local, gitignored) and
the session output reported by the human.

### S5 Durable Object hibernation (2026-10-15)

Answered by the relay-worker tests (M2-3) instead of a separate spike: they run the real
`RoomObject` in workerd through `@cloudflare/vitest-plugin`
(`packages/relay-worker/test/durable-object.test.ts`).

Answer: pings are answered by `setWebSocketAutoResponse` without invoking
`webSocketMessage` (the object's invocation counter stays unchanged). After
`evictDurableObject` (a simulated hibernation), sockets, slots and member tokens are
restored from the socket attachments and SQLite storage, and buffered frames are still
delivered. Not yet measured: the real duration billed for idle connections, which needs a
deployed relay (optional step in M2-6).

### S7 Codex CLI integration (2026-10-16)

Method: a research pass over the Codex CLI docs (learn.chatgpt.com/docs, formerly
developers.openai.com/codex) and source (openai/codex at 16e578d, 0.163.0), plus
`codex --help` output from 0.160.0 with an empty `CODEX_HOME`. No Codex session was run.

Answer:
- MCP servers: `[mcp_servers.<name>]` in `~/.codex/config.toml` (project `.codex/config.toml`
  only when trusted) with `command`, `args`, `env`, `env_vars`, `cwd`, timeouts and per-tool
  `approval_mode`. The server's environment is cleared except a fixed list plus `env` and
  `env_vars`; its cwd is the session's unless `cwd` is set. No session or project variable;
  each tool call carries `_meta.sessionId` and `_meta.threadId`. Tools appear as
  `mcp__<server>__<tool>`.
- Approval: default mode `auto` prompts unless a tool is `readOnlyHint`, or
  `destructiveHint: false` and `openWorldHint: false`. "Always allow" writes
  `tools.<tool>.approval_mode = "approve"`. With `approval_policy = never` a tool that needs
  approval is denied, except under full access, where it runs.
- Hooks: on by default; `hooks.json` or `[hooks]` in `~/.codex` (or a trusted repo's
  `.codex`); each must be trusted via `/hooks`. Events include SessionStart,
  UserPromptSubmit, PostToolUse (also for MCP tools) and Stop. Input has `session_id`,
  `cwd`, `permission_mode`, `prompt`; output is Claude-compatible (`additionalContext`,
  Stop `decision: "block"`, `systemMessage`). Hooks get the full environment. `async` exists
  but has no wake; there is no `asyncRewake`.
- Skills: `~/.agents/skills/<name>/SKILL.md` (and repo `.agents/skills`), frontmatter
  `name` and `description`. Custom prompts are deprecated; nothing runs a shell command
  before the model sees a prompt.
- Plugins: Codex reads `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`,
  but does not expand `${CLAUDE_PLUGIN_ROOT}` in a legacy `.mcp.json`.
- Idle wake: `codex queue --thread <id> --message <text>` starts a turn in an idle thread
  as a user message.

Decision: Codex support ships as `pairwire install --codex` with absolute paths (`04` §10),
D1 and D2 delivery, no D3 yet. Tool annotations make `send` always prompt in Codex. Still
to confirm hands-on (Codex manual acceptance): that hook `session_id` equals
`_meta.sessionId`, that PostToolUse context on MCP tools reaches the model, the approval
prompt UX, and the `hooks.json` timeout key.

### S10 Human presence for slash commands, hidden codes, terminal detection (2026-10-18)

Question: for the short authentication string proposal (M7, residual risk 1), can a plugin
command learn that a human typed it, can a code be shown to the human without the model
seeing it, and can a command tell a human's terminal from the agent's Bash? Method: a
throwaway plugin (`spikes/s10/`) with a `UserPromptSubmit` hook that writes a grant file and
returns a code in `systemMessage` when the prompt is `/s10:verify`, and a command whose `!`
line reads the grant and reports its TTY flags. The human ran it in Claude Code 2.1.302
(default mode), had the agent run the recorder with Bash, then ran it in a plain terminal.

Answer:
- `UserPromptSubmit` runs before a plugin command's `!` line: the `!` line found the grant
  297 ms after the hook wrote it. A hook can hand a one-shot human-presence grant to the
  command the human typed. The agent cannot submit a prompt, and
  `disable-model-invocation: true` keeps it from invoking the command.
- A code in that hook's `systemMessage` reaches the human ("UserPromptSubmit says: …") and
  not the model; asked directly, the agent found no code in its context.
- The `!` line and the agent's Bash both run with stdin, stdout and stderr not a TTY; a plain
  terminal has all three. A TTY check separates a human's terminal from an unmodified agent
  command, but an agent can allocate a pseudo-terminal (`script`, a pty module), so it is a
  speed bump, not proof of presence; in default mode the human still sees that command in
  the Bash approval prompt.
- Caveat for any grant: D3 wakes arrive as `<task-notification>` prompts whose text holds
  rendered peer messages (`waiter.ts`), so a peer can place `/pairwire:verify …` inside a
  prompt. A grant must require the prompt to start with the command and must ignore
  `<task-notification>` prompts, as `hooks.ts` already does for the hop reset.

Evidence: `spikes/s10/out/events.jsonl` (local, gitignored; the code is not recorded
elsewhere) and the outputs pasted by the human.

Decision: the short authentication string proposal is buildable as designed, with two
changes from S10 (the grant ignores `<task-notification>` prompts and must match the prompt's
start; a terminal counts as presence only as a speed bump, stated as residual risk). The
human deferred it on 2026-10-18 until after the external security review: it defends only
against an attacker holding both the share string and the relay, and it is a large change.
