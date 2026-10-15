# 00 — Product

Status: draft v0.1 · Owner: project maintainer

## Problem

Two engineers working on related code (frontend and backend, two services, a library and
its consumer) each drive their own coding agent. Coordination between the agents currently
goes through the humans: copy a finding out of one terminal, paste it into a chat app,
the other person pastes it into their agent. It is slow and lossy, and the agents can't
ask each other quick questions.

Claude Code's built-in cross-session messaging only connects sessions on the **same
account**. There is no simple, safe way to connect agents belonging to **two different
people**, possibly at two different companies, possibly using two different harnesses.

## Solution in one paragraph

pairwire is a plugin (Claude Code first, then Codex and other MCP harnesses). Engineer A
runs `/pairwire:start` and gets a share string. A sends it to engineer B over any channel
they already trust (Slack, Signal, in person). B runs `/pairwire:join <share string>`.
From then on the two agents can send each other messages through a relay that only
forwards encrypted bytes. Each engineer sees the full conversation between the agents,
approves what their agent sends, and stays in control of what their agent does.

## Users

- **Primary:** two individual engineers collaborating across a boundary — contractor and
  client, two companies integrating systems, open-source collaborators, friends on a side
  project. They don't share a Claude account or organization.
- **Secondary:** two engineers in the same organization who use different harnesses
  (one on Claude Code, one on Codex).
- **Operator:** anyone self-hosting the relay for their team.

## Goals

- G1. Two engineers go from "never installed" to "agents exchanging messages" in under
  5 minutes, with no server to run and no account to create.
- G2. The relay operator (including the project maintainer) can never read messages.
- G3. Each engineer stays in control: sees everything sent and received, approves outbound
  messages by default, and nothing the peer sends can run on their machine.
- G4. Works across harnesses: a Claude Code user and a Codex user can pair.
- G5. Self-hosting the relay is a one-click or one-command operation.

## Non-goals (v1)

- Rooms with more than two participants.
- File sync, shared editing, or screen sharing. Code moves through git.
- Remote execution of any kind: a peer can never trigger a command, tool or file write.
- Replacing Claude Code's native same-account messaging.
- Accounts, user directories, or discovery. Pairing is only by share string.
- Persistent chat history on the relay.

## Requirements

Format: `WHEN <condition> THE SYSTEM SHALL <behavior>`. "The system" means the pairwire
client unless stated otherwise. Each requirement has at least one test (see
`07-testing.md`).

### Rooms

- **REQ-ROOM-1** WHEN a user runs `/pairwire:start` THE SYSTEM SHALL create a room, connect
  to the relay, show the share string exactly once, and show that it is waiting for a peer.
- **REQ-ROOM-2** WHEN a user runs `/pairwire:join <share string>` with a valid share string
  THE SYSTEM SHALL connect to the relay named in it (or the default relay) and complete the
  handshake with the peer.
- **REQ-ROOM-3** WHEN the handshake completes THE SYSTEM SHALL show both users the peer's
  display name and harness.
- **REQ-ROOM-4** WHEN a third client tries to join a room that already has two members
  THE RELAY SHALL refuse it with error `room_full`.
- **REQ-ROOM-5** WHEN a user runs `/pairwire:leave` THE SYSTEM SHALL notify the peer, close
  the connection, and delete the local room secret.
- **REQ-ROOM-6** WHEN a session restarts in the same project directory while its room is
  still alive THE SYSTEM SHALL reconnect to the room without a new share string.
- **REQ-ROOM-7** WHEN a room has had no activity for 24 hours, or is 7 days old,
  THE RELAY SHALL end it, and later joins SHALL be refused with `ended` (4003).
- **REQ-ROOM-8** WHEN the share string is malformed THE SYSTEM SHALL refuse it with a
  message that says what is wrong, without echoing the string.

### Messages

- **REQ-MSG-1** WHEN an agent calls the send tool THE SYSTEM SHALL deliver the message to
  the peer only after it passes validation and the secret scan.
- **REQ-MSG-2** WHEN a message arrives while the receiving agent is mid-turn THE SYSTEM
  SHALL make it visible to the agent as soon as its current tool call completes (delivery
  tier D2).
- **REQ-MSG-3** WHEN a message arrives while the receiving agent is finishing a turn
  THE SYSTEM SHALL keep the agent working to handle it, subject to the hop budget (D2).
- **REQ-MSG-4** WHEN a message arrives while the receiving session is idle THE SYSTEM
  SHALL wake the agent if the harness supports it (D3), and otherwise show it on the
  agent's next turn.
- **REQ-MSG-5** WHEN the peer is offline THE RELAY SHALL buffer messages within the limits
  in `03-relay.md` and deliver them when the peer reconnects.
- **REQ-MSG-6** WHEN a message is delivered to the peer client THE SYSTEM SHALL report
  "delivered" to the sender (receipt), without the agent having to do anything.
- **REQ-MSG-7** WHEN a user runs `/pairwire:say <text>` THE SYSTEM SHALL send the text
  verbatim, marked as written by a human.
- **REQ-MSG-8** WHEN any message is sent or received THE SYSTEM SHALL append it to a
  human-readable transcript, viewable with `/pairwire:log`.

### Safety

- **REQ-SAFE-1** WHEN a message arrives THE SYSTEM SHALL present it to the agent only inside
  a sanitized `<pairwire_message>` wrapper marking it as external input (see INV-3).
- **REQ-SAFE-2** WHEN an agent sends a message THE SYSTEM SHALL require approval through the
  harness's own tool-approval prompt unless the user has explicitly allow-listed the tool.
- **REQ-SAFE-3** WHEN an outbound message contains a likely secret or a pairwire share
  string THE SYSTEM SHALL block it and tell the agent why.
- **REQ-SAFE-4** WHEN an agent has sent `hop_budget` (default 8) consecutive messages
  without its own human giving input THE SYSTEM SHALL refuse further sends until the human
  responds or runs `/pairwire:continue`.
- **REQ-SAFE-5** WHEN a session is paired and its permission mode bypasses prompts
  THE SYSTEM SHALL warn the human once per session.

### Installation and hosting

- **REQ-INST-1** Installing on Claude Code SHALL take at most two commands inside Claude
  Code (add marketplace, install plugin) and no server setup.
- **REQ-INST-2** WHEN the user sets a custom relay URL THE SYSTEM SHALL use it, and the
  share strings it creates SHALL carry that relay's address so the joiner needs no setup.
- **REQ-INST-3** The relay SHALL be deployable to the operator's own Cloudflare account via
  a "Deploy to Cloudflare" button, and runnable anywhere as a Docker image.
- **REQ-INST-4** WHEN a required runtime (Node >= 20) is missing THE SYSTEM SHALL tell the
  user exactly what to install instead of failing silently.

### Cross-harness

- **REQ-X-1** Clients on different harnesses SHALL interoperate, because the wire protocol
  carries no harness-specific data except the informational `harness` field.
- **REQ-X-2** (M6) A Codex user SHALL be able to install pairwire with one command and pair
  with a Claude Code user.

## MVP (release 0.1.0)

In: REQ-ROOM-*, REQ-MSG-1..3, 5..8, REQ-MSG-4 on a best-effort basis (whatever the M0
spikes prove workable), REQ-SAFE-*, REQ-INST-1..4, hosted relay, Node relay with Docker.
Platforms: macOS, Linux and WSL 2 (native Windows in M7).

Out until later milestones: structured message kinds (heads-up, file claims, API
contracts), Channels-based push as a documented option, Codex and other harnesses,
single-binary distribution.

## Success measures

- Time from install to first delivered message: under 5 minutes for a first-time pair.
- No plaintext, share secret or display name ever reachable by the relay operator
  (verified by test, INV-1).
- A scripted injection corpus produces zero tool executions on the receiving side
  (`07-testing.md`, SEC tests).
