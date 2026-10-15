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
  without a token; `joined` carries `expires_at`.

### relay

- Conformance suite (same file) passes against relay-worker and relay-node.
- INV-1: a test relay wrapper records every byte received; after a full session the
  recording contains no share secret, `psk`, display name or plaintext body.
- Durable Object hibernation: sockets survive a simulated hibernation (attachment
  restored); ping auto-response does not invoke `webSocketMessage`.

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
- Passive session hooks never mark the owner's messages delivered.
- `ctl.sock` falls back to a short path when `PAIRWIRE_HOME` is long.
- INV-3: `ctl log` output passes through `renderTranscript()`: wrapped, labeled, and a peer
  body cannot close the wrapper. `ctl say` sends `author: "human"`, resets the hop budget and
  is secret-scanned; `ctl.sock` is 0600.

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
