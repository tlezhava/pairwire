# Manual acceptance checklist

Release gate (`specs/07-testing.md`). Run on two folders on one machine, then on two
machines. Record results in `tests/manual/RESULTS.md`. Step numbers are referenced by
`tests/traceability.json`, so append new steps rather than renumbering.

On one machine, start session B with its own state directory, for example
`PAIRWIRE_HOME=~/.pairwire-b claude`: one state directory holds one side of a room.

1. Fresh machine profile: install with the two `/plugin` commands; no other setup.
   (REQ-INST-1)
2. Session A `/pairwire:start`, session B `/pairwire:join` — both show the peer's name
   within 10 s.
3. A asks B a question; B's agent answers without the B human typing; A's approval
   prompt shows the exact text.
4. B is idle when a message arrives: B's session wakes on its own and its agent handles
   the message (D3); B's human sees "Stop hook feedback". B then types a prompt before the
   next message arrives, and the message is delivered once, not twice. (REQ-MSG-4)
5. Hop budget pauses a scripted back-and-forth after 8 agent messages.
6. Kill session B, restart in the same folder; messages sent meanwhile arrive.
7. `/pairwire:leave` on A ends the room on B.
8. Repeat 2–3 with a self-hosted relay (Docker, and the Deploy to Cloudflare button) and
   a share string carrying `@host`. (REQ-INST-3)
9. Injection sample run (`specs/07-testing.md`, Injection corpus).
10. With A in `auto` mode, A's first tool call after pairing shows the grey line
    "pairwire: this session runs in auto mode, …" once, and not again in that session.
    (REQ-SAFE-5)
11. `/pairwire:say hello from me` on A reaches B marked `author="human"`; A's agent does not
    send it again. `/pairwire:log` on B shows the conversation inside
    `<pairwire_transcript>`.
12. `node <plugin>/dist/pairwire.mjs doctor` on both sides reports only `ok` lines.
13. Codex: on a machine with Codex, run `node <plugin>/dist/pairwire.mjs install --codex`, restart
    Codex and trust the four pairwire hooks with `/hooks`. Ask Codex to join a room started
    in Claude Code; both sides show the peer and harness. (REQ-X-2)
14. Codex: Codex's approval prompt appears for the pairwire `send` tool; `status` and `inbox`
    run without one.
15. Codex: a message from Claude Code reaches Codex between its tool calls (PostToolUse) and
    at the end of a turn (Stop). This confirms that the hook `session_id` matches the
    `_meta.sessionId` the server recorded (S7).
16. Codex: `node ~/.pairwire/bin/dist/pairwire.mjs ctl say` (text on stdin) in the project
    reaches Claude Code marked `author="human"`.
