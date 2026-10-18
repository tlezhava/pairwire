# 07 — Testing

Status: draft v0.1

## Layers

| Layer | Tool | Where | Runs in CI |
|---|---|---|---|
| Unit | vitest | `packages/*/test` | yes |
| Relay conformance | vitest, one suite run against both relays | `packages/core/test/relay-conformance/` | yes |
| Durable Object | `@cloudflare/vitest-plugin` | `packages/relay-worker/test` | yes |
| Live relay | the relay conformance suite without the time-based cases, plus INV-1 blindness, against a deployed relay (`PAIRWIRE_LIVE_RELAY=<host> npm run test:live`) | `packages/relay-node/test/live.test.ts` | no; after each deploy |
| Client integration | vitest, real relay-node on a random port, two `pairwire mcp` processes driven by an MCP test client, isolated `PAIRWIRE_HOME`s | `tests/e2e` | yes |
| Hook contract | vitest, feeds recorded hook JSON to `pairwire hook <event>` and checks stdout | `packages/client/test/hooks` | yes |
| Plugin | `claude plugin validate plugins/claude-code --strict` | CI step | yes |
| Manual acceptance | two real Claude Code sessions in two folders, then two machines | `tests/manual/ACCEPTANCE.md` | before each release |

CI runs everything on Ubuntu (Node 20 and 22), and `npm test` plus `npm run test:e2e` on
`windows-latest` (Node 22, ADR-024). A test that rests on POSIX behavior (mode bits, the
INV-9 permission check, symlinks, signals, a fake `node` shell script) is skipped on Windows
with `it.skipIf(process.platform === "win32")` and a comment saying why. Windows-only logic
(pipe names, Git Bash lookup, `doctor`'s Windows lines) takes the platform or a path module
as a parameter, so it is unit-tested on every OS; the Windows job then runs the real thing:
`ctl` over named pipes, and the exec-form hook entry from `hooks.json` with Git's `sh` and
`OS=Windows_NT`, so `run.sh` takes its Windows branch (including a Windows-only case with no
`PAIRWIRE_HOME`, where the state directory comes from `USERPROFILE`). That shows `run.sh`
works under Git's `sh`; it does not show how Claude Code itself starts the hook on Windows,
which stays unverified until a Windows session (ADR-024).

Naming: every test that covers a requirement or invariant includes its id in the test
name, e.g. `it("REQ-ROOM-4 refuses a third member", ...)`. CI fails if any REQ-* or INV-*
id defined in `00-product.md` or `05-security.md` has no matching test
(`scripts/check-traceability.ts`), with two documented exceptions read from
`tests/traceability.json`:

- `manual`: ids verified by a numbered step in `tests/manual/ACCEPTANCE.md`
  (REQ-INST-1, REQ-INST-3, REQ-MSG-4 initially). The script checks the step exists.
- `deferred`: ids belonging to a later milestone, with the milestone (REQ-X-2 → M6).
  The script fails once that milestone's tasks are all checked in `tasks.md`.

The check reports missing ids as **warnings** until task M4-6 is checked in `tasks.md`.
From then on it fails CI.

## Required test cases

### core

- Share string: encode/decode round trip; uppercase and whitespace accepted; every
  malformed class rejected with the right error and without echoing input (REQ-ROOM-8);
  relay suffix parsing incl. port; `ws://` only for localhost.
- Key schedule and session keys match the vectors in `02-protocol.md` section 7.
- HELLO: valid decrypt; wrong secret fails; tampered byte fails; identical `e_pub`
  aborts; all-zero DH aborts; a second HELLO for the same epoch and a HELLO for an
  unseen epoch are dropped.
- MSG: round trip; tamper of each field fails; wrong `sid` dropped; duplicate `seq` acked but not
  delivered twice; out-of-order `seq` dropped without ack; previous-session keys still decrypt buffered frames.
- Envelope schema: every field's bounds; unknown kinds dropped; `answer` without
  `reply_to` rejected; a body under 24 KiB whose serialized envelope exceeds 28 KiB
  (e.g. all quotes or control characters) is rejected as `too_large`.
- Sanitizer (INV-3): closing-tag injection, case and whitespace variants, nested tags,
  `system-reminder`, `pairwire_notice` and other denylisted tags, bidi and zero-width
  characters, Unicode tag block (U+E0000–U+E007F), other Cf characters (U+00AD,
  U+2061–U+2064, U+FFF9–U+FFFB) removed while ZWJ emoji survive, attribute quote
  breaking, NFC normalization, 8,000-character hook threshold, hook total cap with "*n*
  more waiting".
- Secret scanner (INV-5): at least 3 positive and 3 negative samples per rule; never
  returns matched text.
- Relay room state machine: full membership table from `02-protocol.md` section 5;
  buffering order; HELLO never buffered; every limit in `03-relay.md` (rate limit counts
  binary frames only); expiry and max age with a fake clock; unknown token with a free
  slot → 4002; any join to an ended room → `peer_left` (if left) then 4003, with or
  without a token; `joined` carries `expires_at`. `encodeRoomState`/`decodeRoomState`
  round-trip a state with buffered frames and a tombstone, and decoding rejects malformed
  input.

### relay

- Conformance suite (same file) passes against relay-worker and relay-node, and again
  against relay-node with SQLite state.
- relay-node restart (SQLite): a member's token, epoch and buffered frames survive a
  restart and the member rejoins and receives them; idle expiry and max age still fire
  after a restart with the fake clock, including expiry that fell due while it was down;
  a tombstone stays a tombstone; `sqlite:` on a Node without `node:sqlite` fails with a
  clear message.
- INV-1: a test relay wrapper records every byte received; after a full session the
  recording contains no share secret, `psk`, display name or plaintext body.
- Durable Object hibernation: sockets survive a simulated hibernation (attachment
  restored); ping auto-response does not invoke `webSocketMessage`; an unjoined socket is
  still closed with 4006 at its original join deadline after the object is rebuilt.
- Resource limits (`03` Limits, ADR-032): the conformance suite covers the unjoined-socket
  limit (oldest closed with 4008) and the reply limit on `error`s. relay-node tests cover
  its relay-wide caps (sockets, sockets per address, rooms, buffered bytes, each refused
  as specified and logged without the address) and the outbound queue: a joined member
  that stops reading is closed with 4008 and its peer gets `peer_left`.

### client and e2e

- REQ-ROOM-1..7 end to end with two clients; REQ-ROOM-7 uses relay-node's injectable
  clock.
- Reliability (`02` §6): drop a frame in a test relay → resend after 15 s fills the gap;
  peer offline during a handshake → messages still arrive after reconnect; duplicate
  frames are acked but delivered once; crash after persisting `my_seq` never reuses a seq;
  acks batch and are never acked; resend pacing stays at or below 8 binary frames per
  10 s.
- HELLO epochs: a HELLO for an older epoch is ignored; a replaced socket (4007) does not
  reconnect; five bad HELLOs disconnect with the `wrong_key` notice and no
  auto-reconnect.
- Peer `instance` change produces the transcript warning and the `peer_changed` notice.
- Local notices: `peer_joined` reaches the starter's agent through hooks and `inbox`; an
  incoming ack never produces delivery or a Stop block.
- 4002 on rejoin and reaching `expires_at` both remove the room locally.
- `leave` with a message containing a secret is blocked and the room stays open (INV-5).
- REQ-X-1: two clients reporting different `harness` values interoperate.
- REQ-MSG-1..8: send/receive, queue while peer offline then flush, acks update status,
  transcript content on both sides.
- REQ-SAFE-2/INV-4: plugin files contain no permission rule allowing `send`; `send`
  cannot produce `author: "human"`.
- REQ-SAFE-3: blocked send leaves no trace on the wire.
- REQ-SAFE-4/INV-6: ninth consecutive send fails; `user-prompt-submit` hook resets;
  `ctl continue` resets; no MCP tool resets; a `user-prompt-submit` whose prompt starts
  with `<task-notification>` (a D3 wake) does not reset.
- Passive mode: second MCP server in the same project refuses with the owner pid.
- Dead-owner takeover and reconnect (REQ-ROOM-6).
- INV-7: grep all files under `PAIRWIRE_HOME` (except `secret` and `state.json`), all
  captured logs and all tool results after a session for the secret and share string.
- INV-9: client refuses to start with loose permissions.
- INV-2: a static check (eslint `no-restricted-imports` plus a script over the import
  graph) proves the inbound path modules (`decrypt`, `envelope`, `inbox`, `render`) never
  import `child_process`, `vm`, `worker_threads`, or the config/permission writers; plus an
  e2e test that sends the injection corpus and asserts no process is spawned and no file
  outside `PAIRWIRE_HOME` changes.
- INV-8: envelopes carrying extra fields (`config`, `hop_budget`, `relay`, ...) are rejected
  by the schema and change no local state.
- REQ-SAFE-1: every delivery path (each hook, `inbox`, Channels if shipped) output passes
  through `render()` — asserted by snapshot and by an injection-corpus sample per path.
- REQ-SAFE-5: hook with `permission_mode: "bypassPermissions"` and an active room warns
  once per session (`session_id`), from any hook event, and warns again for a new
  session in the same room.
- REQ-INST-2: share string from a client with a custom relay carries `@host`; joining
  client connects there with no config.
- REQ-INST-4: `doctor` and `hooks/run.sh` report a missing or old Node clearly (Node
  version faked in test); `run.sh` exits 0 in every case and starts no Node when the
  `active` flag is absent.
- npm package (`04` §9): the `npm run pack:npm` output, packed with `npm pack` and installed
  from the tarball into a temporary prefix, has no dependencies and runs `pairwire doctor`,
  `install --print-config` and `install --codex` from the installed copy.
- Release script: the version bump rewrites every version location and nothing else,
  refuses invalid or non-increasing versions, and `--check` reports a mismatched location.
- Passive session hooks never mark the owner's messages delivered.
- `ctl.sock` falls back to a short path when `PAIRWIRE_HOME` is long.
- INV-3: `ctl log` output passes through `renderTranscript()`: wrapped, labeled, and a peer
  body cannot close the wrapper. `ctl say` sends `author: "human"`, resets the hop budget and
  is secret-scanned; `ctl.sock` is 0600.
- REQ-SAFE-6 hold mode (`04` §5, Hold mode): with `hold` on, a peer message reaches no
  hook, no D3 waiter and no `inbox` result, and does not block `Stop`; local notices still
  flow; the footer and `status` count it as held; exactly one `held` notice is queued per
  accept cycle; no MCP tool releases it (every tool is called and the message stays held);
  `ctl accept` shows it once through the renderer (wrapped, labeled, a hostile body cannot
  close the wrapper) and marks it delivered, so no later path shows it again; a body over the
  hook threshold is released but left for `inbox`; `ctl accept drop` shows no body and no
  path ever delivers the message; `ctl accept` with a terminal stdout releases without
  marking delivered; `ctl log` replaces held and dropped bodies, also when the peer's
  display name imitates an id; the sender still sees "delivered"; a config that can't be
  read holds; `PAIRWIRE_HOLD` overrides `config.json` and is passed through by the Codex
  install; `ctl accept` releases and drops held messages even when its own process sees
  hold mode off, and retires the unread `held` notice (no hook or `inbox` shows it after); the `held` notice, the footer, `status`, the `ctl log` placeholder and
  `ctl accept`'s usage name `/pairwire:accept` in Claude Code and the terminal command in
  Codex (the binding records the owner's harness); a corrupt `delivered.json` fails closed
  (no peer message already in the inbox is shown again, the file is repaired once, and the
  warning carries no ids) while a missing one is an empty ledger.

### hooks

- Each hook with nothing to deliver: empty stdout, exit 0, under 100 ms p95 on CI hardware
  (measured, reported, not a hard failure until S1 sets the budget).
- Delivery: PostToolUse and UserPromptSubmit produce `additionalContext`; Stop produces
  `decision: "block"` only when there are new messages; nothing is delivered twice across
  hooks, the D3 waiter and the `inbox` tool.
- REQ-MSG-4 D3 waiter (`04` §6): an arriving message ends the waiter with exit 2 and the
  rendered items on stderr, marked delivered; items already undelivered when it registers
  wake it at once; a second `wait` for the same session ends the first with exit 0;
  `wait_cancel` from UserPromptSubmit and PostToolUse ends it with exit 0; an ack never
  wakes it; a passive session's waiter, `delivery: pull`, `auto_continue: false`, an
  unreachable `ctl.sock`, a dropped connection and SIGTERM all end it with exit 0 and no
  output; it has no timer of its own.
- Internal error → exit 0, no output, error logged.

### Control-channel server proof (M7)

ADR-029, INV-10.

- core (test-first): `ctlProof` reproduces the `04` §8 vector; `verifyCtlProof` accepts it
  and refuses a flipped bit, a wrong key, room or nonce, and a MAC of the wrong length.
- client, genuine server: `ctl say`, `ctl continue`, the waiter and `wait_cancel` work
  through the `hello` exchange; the server answers a second `hello` and a malformed one as a
  bad control request; a 0.1.x-style client (request as the first line) still works.
- client, INV-10 squatter: a fake listener at `ctl_path` without the key, with the owner pid
  alive, that answers `hello` with a wrong `mac`, garbage, silence, a closed connection or
  "bad control request." receives nothing after the `hello` line; `ctl say` prints the
  fixed message; `ctl continue` prints it and does not reset `hop_count` in `state.json`;
  the waiter exits 0 with no output even when the fake sends a `wake`; `wait_cancel` gives
  up; each failure logs `ctl_proof_failed` to `hook-errors.log`. A `ctl.key` of the wrong
  length fails the same way, and on POSIX so does a `ctl.key` that is group- or
  world-readable or a symlink, in the waiter too (which doesn't run INV-9's check), even
  against a listener that holds the key. `ctl continue` against a server that proves itself
  and then gives no reply changes nothing in `state.json`.
- client, compatibility: a room without `ctl.key` (0.1.x-style) behaves as before; the
  first new server to open it creates the key.
- client, key file: `ctl.key` is 32 bytes, mode 0600, created before the server listens
  and not replaced when it exists; a group-readable `ctl.key` makes the client refuse to
  start (INV-9); leave, end, expiry (a room past its expiry when a server opens it) and
  `purge` remove it, and none comes back; a `ctl.key` of 0 or 31 bytes (a crash) is
  replaced by the next server to open the room; creating it leaves no temporary file.
- client, Windows listen retry: a listen failure retries with a fresh pipe name up to 3
  times, recording each, then runs without a control channel (unit-tested with fakes on
  every OS).
- `doctor`: `ok` against a genuine server, `FAIL` against a squatter, the deletion advice
  with its warning when the listener answers like a 0.1.x server, and the advice to delete
  and recreate a `ctl.key` that can't be used.

### Structured kinds (M5)

ADR-027.

- core, envelope schema (test-first): each M5 kind's `data` bounds; `data` present on an old
  kind (also `"data": null`) rejected; `data` missing on an M5 kind rejected; unknown keys in
  `data` rejected (INV-8); `author: "human"` on an M5 kind rejected; every `RelPath`
  rejection class, including a glob in the first segment, a `.` or `..` segment, `\`, `,`,
  bidi, zero-width and tag-block characters; `ContractPath` rejects globs and dot-segments;
  inline content whose hash differs, or that the sanitizer would change, is rejected.
- core, `coordView()` (pure, fake clock): claim expiry from `received_at`/`sent_at` capped
  at the room's `expires_at`, ignoring a future `ts`; release only by the same side; the
  16-claim limit and the 25-names-per-side limit (`over_limit`), one side's names not using
  up the other's; per-side id resolution; every `match` value; live proposal by version,
  equal versions ordered by id while pending so both sides agree; an answered version not
  replaced by a same-version proposal with a higher id; `version_gap` for a version more
  than one above the highest; first valid response wins; held and dropped messages
  invisible; ending the room ends claims; 50,000 claims from a flooding peer within a fixed
  time budget (linear cost).
- core, overlap check and fallback body: prefix overlap cases; the fallback body is
  deterministic and its header matches `02` §6.3.6 for each kind.
- REQ-COLLAB-1: a `heads_up` reaches the peer agent with sanitized `paths` attributes.
- REQ-COLLAB-2: claim, then release, then expiry, seen in both sides' `status` and footer;
  `send` refuses a seventeenth active claim and a release of a claim that isn't ours.
- REQ-COLLAB-3: propose (ref-only and inline), accept with a matching `local_path`, accept
  with a mismatching `local_path` refused, reject; a response to a superseded proposal
  refused by `send` and rendered `match="superseded"` when it arrives anyway; a held
  proposal id gets the same `send` error as a nonexistent one.
- REQ-COLLAB-4: an e2e pair with one side a raw test peer that validates with 0.1.0's
  envelope schema and advertises no `collab1`: `heads_up`, `claim`, `release` and
  `contract_propose` arrive as `chat` with their headers (an older peer can't propose, so
  there is nothing to answer), are acked, nothing is dropped as 0.1.0 would drop it, and a
  later `chat` keeps flowing. Client tests (relay-node, injected HELLO caps, dropped
  frames): a peer downgrade between sessions resends unacked structured envelopes as chat
  under the same id and seq; an upgrade resends structured; a queued structured message's
  `outbox.jsonl` line parses with 0.1.1's outbox and envelope schemas (a copy in the tests),
  and an M5 peer still receives it structured.
- REQ-COLLAB-5: invalid `data`, `data` on an old kind, `author: "human"` on an M5 kind and
  an extra top-level field are skipped like an unknown kind (ADR-025): acked, `peer_max_seq`
  advanced, nothing stored or rendered, one `peer_unreadable` notice per connection.
- REQ-COLLAB-6 and INV-2: claim, release, contract_propose and contract_response from the
  peer, including paths that name real files and `.claude/settings.json`, leave the project
  tree and `.claude/` byte-identical, open no file the peer named (fs spy in client tests),
  spawn no process and send nothing but acks (e2e, a hostile raw peer); `send` refuses a
  new contract name past our own 25, however many the peer proposed.
- REQ-COLLAB-7 and INV-5: `contract_propose` refuses a symlink that leaves the project, a
  dot-segment path, each sensitive name, a file over 1 MiB, and a file containing a
  scanner match (the error carries no content); a `contract_response` accept refuses a
  `local_path` that is a symlink out of the project, a dot-file or under a dot-directory
  (directly or through a symlink), a sensitive name, or a file with a secret, naming the
  rule, sending nothing and writing no `coord-sent.jsonl` line; the scan covers every new
  input field and the fallback body.
- INV-3: injection-corpus samples placed in a body, a path (where the schema allows the
  characters) and inline content can't close the wrapper, forge a `match` attribute or
  forge a `<pairwire_contract_content>` element; `status` lines with peer paths are
  sanitized and labeled.
- INV-7: no path, hash or body in any log line after a session with every structured kind.

### Injection corpus (SEC)

`tests/security/injection-corpus/` holds hostile message bodies: tag breaking, fake
system reminders, fake "user approved" claims, instructions to edit CLAUDE.md, to run
`curl | sh`, to send `.env`, to reset the hop budget, unicode tricks. Automated tests
check the renderer output for each. The manual acceptance run sends a sample to a real
Claude Code session with default permissions and records that no tool runs without a
prompt and the agent tells its user. Results go in `tests/manual/RESULTS.md`.

## Manual acceptance checklist (release gate)

Kept in `tests/manual/ACCEPTANCE.md`; minimum content:

1. Fresh machine profile: install with the two `/plugin` commands; no other setup.
2. Session A `/pairwire:start`, session B `/pairwire:join` — both show peer name within
   10 s.
3. A asks B a question; B's agent answers without the B human typing; A's approval
   prompt shows the exact text.
4. B is idle when a message arrives: B's session wakes on its own and its agent handles
   the message (D3); B's human sees "Stop hook feedback". B then types a prompt before
   the next message arrives, and the message is delivered once, not twice.
5. Hop budget pauses a scripted back-and-forth after 8 agent messages.
6. Kill session B, restart in the same folder, messages sent meanwhile arrive.
7. `/pairwire:leave` on A ends the room on B.
8. Repeat 2–3 with a self-hosted relay (Docker) and a share string carrying `@host`.
9. Injection sample run (above).
