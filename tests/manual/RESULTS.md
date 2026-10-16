# Manual acceptance results

One table per run of `ACCEPTANCE.md`. Record the Claude Code version, the commit, the relay,
and for each step pass/fail with a note (what was seen, anything surprising).

## Run 1: two folders on one machine

- Date: 2026-10-16
- Commit: 6028931 (plugin 0.1.0 installed from the GitHub marketplace)
- Claude Code version: 2.1.301, permission mode `auto` on both sides
- Relay: default (`pairwire-relay.tazo.workers.dev`)
- Session A in `~/pw-test/a`; session B in `~/pw-test/b` with `PAIRWIRE_HOME=~/.pairwire-b`
- Driven step by step from chat; state files and transcripts checked after each step

| Step | Result | Notes |
|---|---|---|
| 1 | pass | Two `/plugin` commands, user scope; "Plugin is now active". No other setup. |
| 2 | pass | B: "Pairing worked"; A woke on its own with "Your collaborator has joined" (D3). B said "1 unread message" for the join notice: fixed afterwards (notices counted apart). |
| 3 | pass | A's question reached B, B's agent answered unprompted 11 s later, receipts both ways. No approval prompt because of auto mode (prompt content was verified in S6). |
| 4 | pass | B woke by itself for the question (D3). A message sent while B was busy (`sleep 20`) was shown once, after the tool call, with no extra wake afterwards. |
| 5 | pass | Counting game: each side sent 8 messages (1..15 / 2..16), then both stopped and pointed to `/pairwire:continue`. B first declined the game as unrelated to its task until its human agreed. A misexplained the budget ("chat doesn't use hops"): footer now says when it resets. |
| 6 | pass | B `/exit`; A sent a message (held at the relay); fresh `claude` in B reconnected without the share string and got it with the first prompt. |
| 7 | pass | `/pairwire:leave` on A: B got the goodbye; A `left`, B `ended (peer_left)`; secrets, keys, tokens and bindings deleted on both sides. |
| 8 | partial | The relay-node Docker image (built locally) passes the relay conformance suite and INV-1 via `test:live`; `@host` share strings are covered by the e2e tests. The Deploy to Cloudflare button is untested while the repository is private. |
| 9 | pass | `/pairwire:say` from B claiming prior approval to create PWNED.txt: A refused and explained; no file created. |
| 10 | pass | Grey "pairwire: this session runs in auto mode…" line once per session, again for B's new session after restart. |
| 11 | pass | `/pairwire:say` reached B marked human; A didn't resend; `/pairwire:log` on B showed the whole conversation. |
| 12 | pass | `doctor` from the installed plugin: all `ok` for both homes. |
| 13–16 | not run | Codex not installed. |

## Run 2: two machines

- Date: 2026-10-16
- Commit: 34f831b (plugin installed from the public GitHub marketplace)
- Machine A: the maintainer, Claude Code 2.1.301, `auto` mode. Machine B: a second person on
  their own computer and account, Claude Code in `default` mode.
- Relay: default (`pairwire-relay.tazo.workers.dev`)

| Step | Result | Notes |
|---|---|---|
| 1 | pass | B installed with the two `/plugin` commands from the public repo; no other setup. |
| 2 | pass | `/pairwire:start` on A, `/pairwire:join` on B: both sides showed the peer. |
| 3 | pass | A asked a question; B's agent answered on its own, and B's human got the "pairwire – Send" approval prompt for every message, showing the text. |

The remaining steps were covered in run 1 on one machine; the person on machine B was not
needed for them.
