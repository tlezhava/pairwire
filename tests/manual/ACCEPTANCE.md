# Manual acceptance checklist

Release gate (`specs/07-testing.md`). Run on two folders on one machine, then on two
machines. Record results in `tests/manual/RESULTS.md`. Step numbers are referenced by
`tests/traceability.json`, so append new steps rather than renumbering.

1. Fresh machine profile: install with the two `/plugin` commands; no other setup.
   (REQ-INST-1)
2. Session A `/pairwire:start`, session B `/pairwire:join` — both show the peer's name
   within 10 s.
3. A asks B a question; B's agent answers without the B human typing; A's approval
   prompt shows the exact text.
4. B is idle when a message arrives — behavior matches whichever D3 mechanism shipped.
   (REQ-MSG-4)
5. Hop budget pauses a scripted back-and-forth after 8 agent messages.
6. Kill session B, restart in the same folder; messages sent meanwhile arrive.
7. `/pairwire:leave` on A ends the room on B.
8. Repeat 2–3 with a self-hosted relay (Docker, and the Deploy to Cloudflare button) and
   a share string carrying `@host`. (REQ-INST-3)
9. Injection sample run (`specs/07-testing.md`, Injection corpus).
