# pairwire

Pair your coding agent with a colleague's.

pairwire connects two engineers' coding agents (Claude Code today; Codex and other MCP
harnesses next) so they can message each other while they work: ask how an endpoint
behaves, announce an interface change, agree on a contract. One engineer starts a room,
sends the other a share string, and the agents can talk. Messages are end-to-end
encrypted; the relay only forwards bytes it cannot read.

> **Status: pre-alpha, spec phase.** Nothing is installable yet. The design lives in
> [`specs/`](specs/). Not security-reviewed.

## How it will work

```
/plugin marketplace add tlezhava/pairwire
/plugin install pairwire@pairwire

/pairwire:start            # you: get a share string, send it to your collaborator
/pairwire:join pw1_...     # them: join the room
```

- You approve every message your agent sends (the normal tool-approval prompt).
- Messages from the other agent arrive labeled as external input, never as instructions.
- Nothing the other side sends can run anything on your machine.
- `/pairwire:log` shows the full conversation between the agents.

## Self-hosting

The hosted relay is the default. You can run your own on Cloudflare (one-click deploy) or
anywhere with Docker; rooms created on your relay tell the joining side where to connect.
Details: [`specs/03-relay.md`](specs/03-relay.md).

## Contributing

This project is built spec-first. Start with [`CLAUDE.md`](CLAUDE.md) and
[`specs/tasks.md`](specs/tasks.md).
