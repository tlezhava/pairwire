# 07 — Testing

Status: draft v0.1

## Layers

| Layer | Tool | Where | Runs in CI |
|---|---|---|---|
| Unit | vitest | `packages/*/test` | yes |
| Relay conformance | vitest, one suite run against both relays | `packages/core/test/relay-conformance/` | yes |
| Durable Object | `@cloudflare/vitest-pool-workers` | `packages/relay-worker/test` | yes |
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

## Required test cases

### core

- Share string: encode/decode round trip; uppercase and whitespace accepted; every
  malformed class rejected with the right error and without echoing input (REQ-ROOM-8);
  relay suffix parsing incl. port; `ws://` only for localhost.
- Key schedule and session keys match the vectors in `02-protocol.md` section 7.
- HELLO: valid decrypt; wrong secret fails; tampered byte fails; identical `e_pub`
  aborts; all-zero DH aborts.
- MSG: round trip; tamper of each field fails; wrong `sid` dropped; duplicate `seq` acked but not
  delivered twice; out-of-order `seq` dropped without ack; previous-session keys still decrypt buffered frames.
- Envelope schema: every field's bounds; unknown kinds dropped; `answer` without
  `reply_to` rejected.
- Sanitizer (INV-3): closing-tag injection, case and whitespace variants, nested tags,
  `system-reminder` and other denylisted tags, bidi and zero-width characters, attribute
  quote breaking, NFC normalization, 8,000-character hook threshold.
- Secret scanner (INV-5): at least 3 positive and 3 negative samples per rule; never
  returns matched text.
- Relay room state machine: full membership table from `02-protocol.md` section 5;
  buffering order; HELLO never buffered; every limit in `03-relay.md`; expiry and max age
  with a fake clock.

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
  acks batch and are never acked; resend pacing stays under relay limits.
- HELLO epochs: a HELLO for an older epoch is ignored; a replaced socket (4007) does not
  reconnect; five bad HELLOs disconnect with the human-facing warning.
- Peer `instance` change produces the transcript warning and the delivery notice.
- REQ-X-1: two clients reporting different `harness` values interoperate.
- REQ-MSG-1..8: send/receive, queue while peer offline then flush, acks update status,
  transcript content on both sides.
- REQ-SAFE-2/INV-4: plugin files contain no permission rule allowing `send`; `send`
  cannot produce `author: "human"`.
- REQ-SAFE-3: blocked send leaves no trace on the wire.
- REQ-SAFE-4/INV-6: ninth consecutive send fails; `user-prompt-submit` hook resets;
  `ctl continue` resets; no MCP tool resets.
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
  once per room, from any hook event.
- REQ-INST-2: share string from a client with a custom relay carries `@host`; joining
  client connects there with no config.
- REQ-INST-4: `doctor` and the hook wrapper report a missing or old Node clearly (Node
  version faked in test).
- Passive session hooks never mark the owner's messages delivered.
- `ctl.sock` falls back to a short path when `PAIRWIRE_HOME` is long.

### hooks

- Each hook with nothing to deliver: empty stdout, exit 0, under 100 ms p95 on CI hardware
  (measured, reported, not a hard failure until S1 sets the budget).
- Delivery: PostToolUse and UserPromptSubmit produce `additionalContext`; Stop produces
  `decision: "block"` only when there are new messages; nothing is delivered twice across
  hooks and the `inbox` tool.
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
4. B is idle when a message arrives — behavior matches whichever D3 mechanism shipped.
5. Hop budget pauses a scripted back-and-forth after 8 agent messages.
6. Kill session B, restart in the same folder, messages sent meanwhile arrive.
7. `/pairwire:leave` on A ends the room on B.
8. Repeat 2–3 with a self-hosted relay (Docker) and a share string carrying `@host`.
9. Injection sample run (above).
