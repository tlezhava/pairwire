# 05 — Security

Status: draft v0.1

pairwire connects an AI agent with tool access on one person's machine to text written by
another person's agent. The main risks are not cryptographic. They are prompt injection
into the receiving agent and the sending agent oversharing. This file states what we
protect, against whom, and the invariants code must keep.

## Assets

1. Contents of messages (code excerpts, plans, internal details).
2. Each engineer's machine: files, credentials, ability to run commands.
3. Secrets the agents can see (environment variables, `.env`, keys, tokens).
4. The room itself: who is allowed to talk in it.
5. Each engineer's money: tokens burned by runaway agent loops.

## Adversaries and controls

| Adversary | Capability | Controls |
|---|---|---|
| A1 Relay operator (incl. the maintainer) | Sees all frames, room ids, timing, sizes, IPs | E2E encryption (INV-1); display names inside encrypted HELLO; our relay code never logs ids or IPs (platform request logs may contain `room_id`, which reveals nothing about keys) |
| A2 Network attacker | Observes or tampers with traffic | TLS (`wss://`), AEAD on every frame, sequence numbers |
| A3 Someone who later obtains the share string (chat logs, agent transcript) | Knows the secret | Ephemeral X25519 session keys (cannot decrypt passively); sealed rooms (cannot join once both slots are taken); peer `instance` change warning |
| A4 The peer, or the peer's compromised agent | Sends arbitrary text to your agent | INV-2, INV-3, INV-8; agent guide; harness permission prompts; hop budget |
| A5 Your own agent, oversharing | Sends secrets or more code than intended | Outbound approval (INV-4); secret scanner (INV-5); agent guide |
| A6 Two agents in a loop | Burns tokens and time | Hop budget (INV-6), client and relay rate limits, Stop hook only blocks for new messages, a D3 wake turn doesn't count as human input |

## Invariants

Each invariant has tests named with its id (`07-testing.md`).

- **INV-1 Relay blindness.** The relay never receives the share secret, `psk`, session
  keys, display names or plaintext. Only `room_id`, member tokens and ciphertext.
- **INV-2 No remote execution.** No code path turns received content into a tool call,
  shell command, file write, config change or permission decision. Received content only
  reaches the agent as rendered text (section 5 of `04-client.md`).
- **INV-3 Sanitized, labeled input.** Every delivery path uses the single renderer and
  sanitizer. No path injects a raw `body`.
- **INV-4 Human approves outbound by default.** The plugin never ships or writes
  permission rules that pre-approve its `send` tool, and `send` never sets
  `author: "human"`.
- **INV-5 Secret scan blocks.** A scanner match blocks the send. There is no override
  flag in v1; the human or agent must rewrite the message.
- **INV-6 Bounded autonomy.** An agent cannot send more than `hop_budget` consecutive
  messages without human input, and no tool exists to reset the budget.
- **INV-7 No secret logging.** Share strings, secrets, keys and member tokens never appear
  in logs, errors, tool results (except the single `start` result), transcripts or crash
  reports. The logger redacts `pw1_…` patterns as a backstop.
- **INV-8 Peer cannot reconfigure.** Nothing in an envelope can change local config, room
  membership, delivery mode, hop budget or permissions.
- **INV-9 Local state is private.** `~/.pairwire` is 0700; `secret`, `state.json` and
  `ctl.sock` are 0600. The client refuses to start if they are group- or world-readable
  and tells the user how to fix it. On native Windows the check is not run; see residual
  risk 8.
- **INV-10 Proven control channel.** For a room that has a `ctl.key`, a control client
  (`ctl say`, `ctl continue`, the D3 waiter and `wait_cancel`) writes nothing but the
  `hello` line to `ctl_path`, and acts on nothing it reads from it, until the listener has
  proven knowledge of that key for a fresh nonce (`04-client.md` section 8,
  "Control-channel server proof"; ADR-029).

## Prompt injection: what we can and cannot promise

What we do:

- Wrap and sanitize every inbound message, label it as external input (INV-3).
- Tell the agent, via the skill and the wrapper preamble, that peer messages are requests
  to evaluate, never instructions from its user (`06-agent-guide.md`).
- Make sure the peer has no capability except text (INV-2).
- Keep the harness's own permission prompts in charge of anything the agent does.
- Warn when a paired session runs with prompts bypassed (REQ-SAFE-5).

What we cannot promise: a well-crafted message may still persuade an agent to do
something within the permissions its human has granted. Labeling reduces this; it does not
eliminate it. The README says so plainly and recommends keeping normal permission prompts
on while paired.

## Structured kinds (M5)

ADR-027, `02-protocol.md` §6.3. This section analyzes the structured kinds against the
invariants above. It changes no invariant text.

- **INV-2.** Receiving a `claim`, `release`, `contract_propose` or `contract_response`
  changes nothing outside pairwire's own display and the view it computes from its own
  files. No code path writes, pulls, stats or opens a path the peer named; there is no
  auto-release, auto-reply or git action. Claims are deliberately **not** turned into
  `PreToolUse` denies or permission rules: that would let the peer make permission
  decisions on the receiver's machine. They stay advisory text, and the agent guide sends
  conflicts to the human. The contract file is read only on the sender's side, for a path
  the local agent named in its own approved `send` (or later in `status`).
- **INV-3.** Every new value is shown only as a sanitized, escaped attribute or, for inline
  contract content, inside a renderer-made sibling element whose content must be
  sanitizer-invariant. The attributes that carry meaning (`match`, `expires`, `status`,
  `overlaps_yours`) are computed by the client, never copied from the envelope, and the
  preamble tells the agent to trust only those. The path schema rejecting controls, Cf and
  tag-block characters is defense in depth; the sanitizer still runs.
- **INV-4.** The new kinds go only through `send`, behind the same approval prompt. A field
  that doesn't belong to the kind is rejected, so the prompt shows exactly what is used.
  Hashes, versions and the fallback body are derived deterministically from what the prompt
  shows. Structured kinds require `author: "agent"`, so a claim or contract decision can
  never claim to be the human's.
- **INV-5.** The scan covers the body, every path, the contract name, path and rev, inline
  content, the content of every file read to hash it, and the fallback body. Without the
  file-content scan and the sensitive-name and dot-segment rules, a peer could ask the
  agent to "propose `.env`" and get a hash oracle for a low-entropy secret.
- **INV-6.** Every structured send counts toward the hop budget and the rate limit.
  Receiving one never triggers a send other than the protocol's ack.
- **INV-7.** Logs carry kinds and counts only, never paths, hashes or bodies. The transcript
  passes paths through `redact()`.
- **INV-8.** `data` is a strict per-kind schema and is forbidden on old kinds; bounds are
  fixed (TTL at most 24 h, at most 20 paths, 16 active claims per side, 25 new contract
  names per side, a version at most one above the highest seen).
  The peer can only end its **own** claims and answer **our** proposals; anything else
  renders with a `match` value other than `yes` and changes nothing. An unreadable M5
  envelope takes 0.1.1's skip-and-ack path (ADR-025), which changes only `peer_max_seq`, a
  value the peer already controls through its own sequence numbers. No value maps to config, delivery mode, hold mode,
  membership or the hop budget.
- **Hold mode.** The view leaves out held and dropped messages, so a held claim's paths or
  a held proposal's name never reach the agent through `status`, the footer, overlap
  warnings or `send` errors (held ids get the same "unknown id" error as nonexistent ones).

New risks and their mitigations:

- *Claim squatting* (the peer claims everything for 24 h to stall the other agent): the
  first path segment must be literal, at most 16 claims per side count, claims are
  advisory, and the guide makes every conflict a question for the user.
- *Social engineering on contracts* ("you already accepted v3"): the view computed from the
  local inbox and `coord-sent.jsonl` is the authority, `status` shows it, and a response
  that doesn't match renders with a non-`yes` `match`. An answered version can't be
  replaced: a later proposal of the same version gets `stale_version` whatever its id, so
  "v1" keeps naming the bytes that were accepted or rejected.
- *Name and version squatting* (the peer proposes 50 names, or one name at version
  1,000,000, so the other side can't propose): names count per side, 25 each, and a version
  more than one above the highest seen gets `version_gap` and doesn't move the next
  version. `send` refuses a new name past our own 25.
- *Flooding the view* (thousands of claims so every hook and tool call recomputes a slow
  view): `coordView()` keeps at most 16 active claims per side in its working set, so its
  cost is linear in the number of messages; the relay's rate limit bounds that number.
- *Forged header lines* in a peer's `chat` that imitate the fallback encoding: plain text
  with no effect on the view; the guide says to trust only client-added attributes.

## Residual risks (accepted for v1)

1. **Active attacker with share string and relay control** can impersonate a peer during
   the handshake (`02-protocol.md` 4.5). Mitigation later: short authentication string
   comparison (M7 candidate).
2. **Agent with unrestricted Bash** can invoke `pairwire ctl` to send as "human" or reset
   the hop budget. Mitigated only by harness permissions. The agent can't invoke
   `/pairwire:say` or `/pairwire:continue` (`disable-model-invocation`), but while the
   human runs one of them, its `allowed-tools` pre-approval also covers matching Bash
   calls the agent makes in that turn; the pattern is limited to `pairwire.mjs ctl` (S8).
   The same holds for `pairwire ctl accept` in hold mode (M5): an agent with unrestricted
   Bash, or one making a matching call during the human's `/pairwire:accept` turn, could
   release held messages itself.
3. **Metadata** visible to the relay: that two IPs talk, when, how much.
4. **Share string in agent context.** `/pairwire:join` puts the string in the conversation,
   which the harness may store. Sealed rooms limit what a later holder can do.
5. **Secret scanner false negatives.** It catches common formats, not every secret.
6. **Local machine compromise** exposes room state; out of scope.
7. **Hold mode is not a file-system barrier.** Held messages are in the room's
   `transcript.md` and `inbox.jsonl` (the human's record). pairwire never delivers them, but
   an agent allowed to read files under `~/.pairwire` can read them there. Hold mode relies
   on the harness's permission prompts for reads outside the project. The agent guide tells
   the agent not to read or release held messages.
8. **Native Windows state privacy.** Windows has no mode bits, so the client does not run
   the INV-9 check there. The state directory relies on the access control it inherits from
   the user profile. The control pipe accepts only the user. While the owning session is
   down, another local user could create a pipe with the old name; clients don't connect
   when the owner's process isn't running (ADR-024), and if that pid was reused, the server
   proof (INV-10, ADR-029) detects the squatter, as long as `ctl.key` is private. That
   privacy rests on the same inherited ACL as the rest of the state directory. A squatter
   cannot take the next pipe name, which is random per server start. What stays open: a
   squatting pipe server holding `SeImpersonatePrivilege` (service accounts, not ordinary
   users) could impersonate the connecting user at connect time, before the proof runs,
   because Node opens pipes without an impersonation limit (unverified). Closing it needs a
   native add-on, a new runtime dependency the human has not approved (`04` §8).
9. **(M5) Claims are advisory.** A peer can claim up to 16 rooted patterns (such
   as `src/**`) for up to 24 h. pairwire blocks nothing either way, so a claim slows the
   other agent only as far as its user lets it, and an agent may ignore a claim its user
   never hears about.
10. **(M5) A contract hash proves bytes, not understanding.** An acceptance shows
    which bytes were agreed, not that anyone read them. A ref-only proposal can't be
    checked by the receiver until its user pulls the file (`local_path`).
11. **(0.1.1, M5) Unreadable envelopes are acked** (ADR-025). The sender sees "delivered"
    for a message the receiver's agent never saw; only the receiving side's
    `peer_unreadable` notice says so. Frames the relay buffered as structured for a peer
    that then went back to an older client are lost this way (`02` §6.3.6).
12. **(M5) A file hash leaves the machine.** `contract_propose` sends the SHA-256
    of a project file the local agent named. For a short or guessable file the hash reveals
    its content. The dot-segment and sensitive-name rules, the content secret scan and the
    approval prompt narrow this; they don't remove it.

## Security review gate

Before 1.0 (M7): an external review of `packages/core` crypto and sanitizer, and a
review of the injection test corpus. Until then the README carries a "pre-1.0, not
audited" notice.
