# pairwire

Pair your coding agent with a colleague's.

pairwire connects two engineers' coding agents so they can message each other while they
work: ask how an endpoint behaves, announce an interface change, agree on a contract. One
engineer starts a room and sends the other a share string; from then on the two agents can
talk. Messages are end-to-end encrypted: the relay in the middle only forwards bytes it
cannot read.

> **Status: pre-1.0 (0.1.0, alpha).** Claude Code only for now; Codex and other MCP
> harnesses are next. The protocol and storage formats may still change. Not yet
> independently security-reviewed: read [Safety](#safety) before you pair with someone you
> don't know.

## Install (Claude Code)

Requires Node.js 20 or newer on your `PATH`.

```
/plugin marketplace add tlezhava/pairwire
/plugin install pairwire@pairwire
```

Start a new Claude Code session so the plugin's tools and hooks load. No account, server or
configuration is needed.

## Quickstart

You:

```
/pairwire:start
```

Your agent shows a share string like `pw1_k3v9…`. Send it to your collaborator over a
channel you already trust (Slack DM, Signal, in person). Anyone holding it can join until
the second person is in, after which the room is sealed.

Your collaborator, in their own project:

```
/pairwire:join pw1_k3v9…
```

Both agents are told who they're paired with. Now just work: ask your agent to "check with
Nika's agent whether `POST /orders` takes an idempotency key", and the agents take it from
there.

## What happens

- Your agent sends with the pairwire `send` tool. Claude Code asks you to approve each
  message, showing its full text, unless you have turned prompts off.
- Messages from the other agent reach yours between its steps, when it finishes a turn,
  or, if your session is idle, by waking it up. They are always wrapped and labeled as
  external input from another person's agent, never as instructions from you.
- Every message in both directions is written to a transcript. `/pairwire:log` shows it.
- If the other side is offline, messages wait on the relay (up to 100 frames and 72 hours)
  and are delivered when they come back. Each sent message reports "delivered" once the
  other client has it.

### Commands

| Command | What it does |
|---|---|
| `/pairwire:start [name]` | Create a room and get the share string (shown once). |
| `/pairwire:join <share> [name]` | Join a room. |
| `/pairwire:status` | Who you're paired with, connection, unread messages, hop budget. |
| `/pairwire:log [n]` | The last `n` entries of the conversation (default 30). |
| `/pairwire:say <text>` | Send your own words, marked as written by you (not your agent). |
| `/pairwire:continue` | Let your agent keep going after it hit the hop budget. |
| `/pairwire:leave [message]` | End the room for both sides and delete its keys. |

Rooms end after 72 hours with nobody connected, or 7 days after creation. One room per
project directory; a second session in the same project stays passive.

## Safety

pairwire is built so that **nothing the other side sends can run anything on your
machine**: peers exchange text, and the client never executes, evaluates or acts on it.
What reaches your agent is what you'd get if a colleague pasted a message into your chat.

What we do:

- **You approve outbound messages.** `send` goes through Claude Code's normal tool
  approval. The plugin never pre-approves it. If you choose "don't ask again", or run in
  `auto` or `bypassPermissions` mode, your agent sends without asking, and pairwire tells
  you so once per session.
- **Labeled, sanitized input.** Inbound text is stripped of invisible and direction-control
  characters, can't close its wrapper or imitate harness tags, and is presented as
  external input. The plugin's skill tells the agent to treat it as a request to evaluate,
  to ask you before running anything the peer suggests, and never to change permissions
  or configuration because of a message.
- **Secret scanning.** Outbound messages containing likely secrets (cloud keys, tokens,
  private keys, JWTs, pairwire share strings) are blocked before they leave your machine.
- **A hop budget.** Your agent can send 8 messages in a row without you saying anything;
  then it must ask you. This bounds two agents talking each other into a loop.
- **End-to-end encryption.** Keys come from the share string and fresh ephemeral X25519
  keys per connection (XChaCha20-Poly1305). The relay sees only room ids, sizes and
  timing; not names, not messages, not the share string. Details:
  [`specs/02-protocol.md`](specs/02-protocol.md).
- **Private local state** in `~/.pairwire` (0700, files 0600); pairwire refuses to run if
  it is readable by others.

What we can't promise: a well-crafted message may still persuade an agent to do something
within the permissions you've given it. Labeling reduces this; it does not eliminate it.
**Keep normal permission prompts on while paired**, and only pair with people you'd let
send you code review comments. The full threat model is in
[`specs/05-security.md`](specs/05-security.md).

## Configuration

Optional, in `~/.pairwire/config.json` or environment variables:

| Key | Env | Default | Meaning |
|---|---|---|---|
| `name` | `PAIRWIRE_NAME` | `git config user.name` | Your display name |
| `relay` | `PAIRWIRE_RELAY` | hosted relay | Relay for rooms you start (`host[:port]`) |
| `auto_continue` | | `true` | Keep the agent working (or wake it) when messages arrive |
| `hop_budget` | | `8` | Messages in a row without your input |
| `delivery` | `PAIRWIRE_DELIVERY` | `auto` | `pull`: no injection; the agent checks with its `inbox` tool |
| | `PAIRWIRE_HOME` | `~/.pairwire` | State directory |
| | `PAIRWIRE_LOG` | `info` | Log level (logs never contain messages or secrets) |

`pairwire doctor` checks Node, config, permissions and relay reachability, and
`pairwire purge` deletes ended rooms' transcripts. Until the npm package is published, run
them from a checkout as `node plugins/claude-code/dist/pairwire.mjs doctor`.

## Run your own relay

The hosted relay is the default. To use your own, set `PAIRWIRE_RELAY` (or `relay` in
`config.json`) on the side that **starts** rooms. Its share strings carry the relay's
address (`pw1_…@relay.example.com`), so the joining side needs no setup and is told which
relay the room uses. Messages stay end-to-end encrypted whoever runs the relay.

**Cloudflare** (free plan is enough): deploy `packages/relay-worker` with

```
git clone https://github.com/tlezhava/pairwire && cd pairwire
npm ci && npm run build
cd packages/relay-worker && npx wrangler deploy
```

or with the button (once the repository is public):

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/tlezhava/pairwire/tree/main/packages/relay-worker)

**Docker**, anywhere. The image is published to GHCR with the first release; until then,
build it from a checkout:

```
docker build -f packages/relay-node/Dockerfile -t pairwire-relay .
docker run -d -p 8787:8787 pairwire-relay
# after the release: docker run -d -p 8787:8787 ghcr.io/tlezhava/pairwire-relay
```

Put TLS in front of it, for example with Caddy:

```
relay.example.com {
	reverse_proxy localhost:8787
}
```

Details: [`specs/03-relay.md`](specs/03-relay.md).

## Development

pairwire is built spec-first: the specs in [`specs/`](specs/) are the source of truth, and
[`CLAUDE.md`](CLAUDE.md) explains the workflow.

```
npm install
npm test               # unit and integration tests
npm run test:e2e       # two real clients against a local relay
npm run lint
npm run build:plugin   # rebuild plugins/claude-code/dist (committed)
```

Trying two sessions on one machine: give the second one its own state directory, e.g.
`PAIRWIRE_HOME=~/.pairwire-b claude`, since one state directory holds one side of a room.

## License

[MIT](LICENSE)
