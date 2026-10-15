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
| A6 Two agents in a loop | Burns tokens and time | Hop budget (INV-6), client and relay rate limits, Stop hook only blocks for new messages |

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
  and tells the user how to fix it.

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

## Residual risks (accepted for v1)

1. **Active attacker with share string and relay control** can impersonate a peer during
   the handshake (`02-protocol.md` 4.5). Mitigation later: short authentication string
   comparison (M7 candidate).
2. **Agent with unrestricted Bash** can invoke `pairwire ctl` to send as "human" or reset
   the hop budget. Mitigated only by harness permissions. The agent can't invoke
   `/pairwire:say` or `/pairwire:continue` (`disable-model-invocation`), but while the
   human runs one of them, its `allowed-tools` pre-approval also covers matching Bash
   calls the agent makes in that turn; the pattern is limited to `pairwire.mjs ctl` (S8).
3. **Metadata** visible to the relay: that two IPs talk, when, how much.
4. **Share string in agent context.** `/pairwire:join` puts the string in the conversation,
   which the harness may store. Sealed rooms limit what a later holder can do.
5. **Secret scanner false negatives.** It catches common formats, not every secret.
6. **Local machine compromise** exposes room state; out of scope.

## Security review gate

Before 1.0 (M7): an external review of `packages/core` crypto and sanitizer, and a
review of the injection test corpus. Until then the README carries a "pre-1.0, not
audited" notice.
