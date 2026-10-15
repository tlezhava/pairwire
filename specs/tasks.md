# Tasks

Work top to bottom. A task is done when its "Done when" holds, tests pass, and the box is
checked in the same commit. Tasks marked 👤 need the human (an account, a decision, a
deploy or a publish); prepare everything, then stop and ask.

## M0 — Spikes (answer open questions; code goes in `spikes/`, findings in `decisions.md`)

Each spike ends with: a `decisions.md` entry (question, method, answer, evidence) and the
affected spec updated (remove the matching **[verify: Sn]** marker).

- [ ] **S1 Hook delivery in Claude Code.** Build a throwaway plugin with the four hooks from
  `04-client.md` section 9. Confirm: `additionalContext` from `PostToolUse`,
  `UserPromptSubmit` and `SessionStart` reaches the model; `Stop` with
  `decision: "block"` + `reason` keeps the agent working and shows the reason to it; the
  matcher value that means "all tools"; the output field that shows a warning to the
  human; the hook command schema (shell string vs. exec form `args`) and whether
  `${CLAUDE_PLUGIN_ROOT}` expands in it; the real cap on hook context size (inject
  12,000 characters). Measure hook wall time for a no-op Node hook and for the
  `hooks/run.sh` fast path (p50/p95 over 50 runs each). Save the recorded hook inputs as
  fixtures for the M4-1 hook contract tests.
- [ ] **S2 Project directory and process tree.** Does `${CLAUDE_PROJECT_DIR}` resolve in a
  plugin `.mcp.json` `env`? What is the MCP server's cwd? Do hook processes get
  `CLAUDE_PROJECT_DIR`? Does it change when the session `cd`s? Is the MCP server's parent
  pid an ancestor of every hook process of the same session (and not of another
  session's)? Can the MCP server see any session-identifying value (for example a session
  id in its environment) that hooks could match against their input's `session_id`? This
  decides ADR-007 and the passive-session hook rule.
- [ ] **S3 Idle wake via `asyncRewake`.** From a `Stop` hook, launch an async rewake waiter
  that exits 2 after a delay. Does it wake an idle session? What does the agent see?
  What happens if the user types first, or the session ends? Can it re-arm every turn
  without piling up processes?
- [ ] **S4 Channels.** Wrap the S1 server as a channel (`claude/channel` capability). With
  `--dangerously-load-development-channels plugin:<name>@<marketplace>`, confirm
  delivery mid-turn and when idle, and whether env vars from the `claude` process reach
  the MCP server.
- [ ] **S5 Durable Object hibernation.** Minimal DO with `acceptWebSocket`,
  `setWebSocketAutoResponse`, `serializeAttachment`, SQLite storage, alarm. Confirm with
  `wrangler dev` that pings don't invoke handlers and attachments survive hibernation.
  👤 Optionally deploy to the human's free account and read duration usage after an
  hour of idle connections.
- [ ] **S6 Send approval UX.** Exact name Claude Code gives the plugin MCP tool; what the
  approval prompt shows for a 2,000-character `body`; the permission rule syntax a user
  would add to allow-list it (for the README).
- [ ] **S8 `!` execution in plugin commands.** Does a plugin command's `!` line run before
  the model sees the prompt? How is `$ARGUMENTS` substituted and quoted, and is it safe
  for arbitrary text (quotes, `$()`, backticks, newlines)? Does it need a permission
  prompt? Does `${CLAUDE_PLUGIN_ROOT}` expand in a command's `!` line? Does a command's
  `allowed-tools` pre-approval also let the model run that command itself later in the
  turn (which would widen residual risk 2)? If unsafe, find a safe way to pass the text
  (stdin, env, temp file) or record that `say`/`continue` move to M5.
- [ ] **S9 Plugin monitors** — only if S3 fails: can an experimental plugin monitor wake an
  idle session with a message?
- [ ] **M0-DONE** Update `04-client.md` D3 choice and remove all M0 **[verify]** markers.
  If S8 moved `say`/`continue` to M5, remove them from `06-agent-guide.md` and the command
  lists. Make sure no spike output (`spikes/out/`, env dumps) is committed. Summarize
  spike results for the human and get a go-ahead before M1.

## M1 — Foundations and `packages/core`

- [x] **M1-1 Scaffold.** npm workspaces, `tsconfig` base (strict, ESM), eslint, vitest,
  the scripts listed in CLAUDE.md, GitHub Actions CI (lint, test, build) on Node 20 and 22.
  Done when: `npm run lint && npm test && npm run build` pass on an empty skeleton in CI.
- [x] **M1-2 Traceability check.** `scripts/check-traceability.ts` per `07-testing.md`,
  wired into CI. Done when: CI lists every REQ/INV id lacking a test (expected: all,
  reported as warnings until M4, errors after).
- [x] **M1-3 Share string + config constants** (`02` §1). Tests first.
- [x] **M1-4 Key schedule** (`02` §2, §7 vectors).
- [x] **M1-5 Handshake + session keys** (`02` §4, §7 vectors).
- [x] **M1-6 MSG framing + envelope schema** (`02` §3, §6).
- [x] **M1-7 Sanitizer + renderer** (`04` §5, INV-3).
- [ ] **M1-8 Secret scanner** (`04` §7.3, INV-5).
- [ ] **M1-9 Limits + relay room state machine** (`03`, `02` §5) with fake clock.

## M2 — Relay

- [ ] **M2-1 Conformance suite** in `packages/core/test/relay-conformance/`, parameterized
  by a relay factory.
- [ ] **M2-2 relay-node** passes conformance; `/v1/info`, `/health`; logging rules.
- [ ] **M2-3 relay-worker** (Durable Object, hibernation, SQLite, alarm) passes
  conformance in `vitest-pool-workers`.
- [ ] **M2-4 INV-1 recorder test** against both relays.
- [ ] **M2-5 Dockerfile** for relay-node; CI builds the image.
- [ ] **M2-6** 👤 Deploy a dev relay to the human's Cloudflare account; set
  `DEFAULT_RELAY_HOST` for development builds.

## M3 — Client

- [ ] **M3-1 Config + state layer** (`04` §2–3): atomic writes, locks, permissions
  check (INV-9), bindings, passive mode, dead-owner takeover.
- [ ] **M3-2 Logger** with redaction (INV-7).
- [ ] **M3-3 Connection manager:** join/rejoin with token, backoff (1 s → 30 s, jitter),
  handshake, sessions current/previous, outbox flush, acks, `peer_left` handling.
- [ ] **M3-4 MCP server + tools** (`04` §4) incl. status footer, rate limit, hop budget.
- [ ] **M3-5 Transcript** writer (REQ-MSG-8).
- [ ] **M3-6 `ctl.sock`** + `pairwire ctl` (subject to S8).
- [ ] **M3-7 `pairwire doctor` and `pairwire purge`.**
- [ ] **M3-8 e2e suite** (`07-testing.md` client and e2e section) green.

## M4 — Claude Code plugin and MVP release 0.1.0

- [ ] **M4-1 Hook entrypoints** (`04` §6) + hook contract tests.
- [ ] **M4-2 D3 mechanism** chosen in M0.
- [ ] **M4-3 Plugin files** (`04` §9): manifest, `.mcp.json`, hooks + `hooks/run.sh`,
  seven commands, SKILL.md generated from `06` §2, `npm run build:plugin` bundles
  `dist/pairwire.mjs`; CI fails on any push to `main` whose committed bundle is stale.
- [ ] **M4-4 Marketplace file**; CI runs `claude plugin validate --strict`.
- [ ] **M4-5 README:** what it is, quickstart (two commands + start/join), safety notes,
  self-hosting (Deploy button + Docker), live mode if Channels shipped, pre-1.0 notice.
- [ ] **M4-6 Traceability check switches to errors;** every REQ/INV is covered by a test,
  a `manual` entry or a `deferred` entry in `tests/traceability.json`.
- [ ] **M4-7 Manual acceptance** (`07-testing.md` checklist) on two folders, then 👤 two
  machines; results in `tests/manual/RESULTS.md`.
- [ ] **M4-8** 👤 Production relay deployed; `DEFAULT_RELAY_HOST` set; tag `v0.1.0`;
  publish npm package `pairwire`; Docker image to GHCR.

## M5 — Collaboration features

- [ ] Spec first: structured kinds `heads_up`, `claim`/`release` (files or paths),
  `contract_propose`/`contract_response` (with a checked-in contract file). Update `02` §6.
- [ ] Inbound `hold` mode: messages wait for the human's `/pairwire:accept`.
- [ ] Channels "live mode" if not already in M4.

## M6 — Cross-harness

- [ ] **S7 Codex spike:** confirm MCP config, skills location, hooks schema and feature
  flag, env available to hooks. Update `04` §10.
- [ ] Codex adapter + `pairwire install --codex`.
- [ ] `pairwire install --print-config <harness>`.
- [ ] Mixed-harness e2e (Claude Code ↔ Codex) and manual acceptance (REQ-X-1, REQ-X-2).

## M7 — Hardening toward 1.0

- [ ] Native Windows support (named pipe for `ctl`, hook wiring).
- [ ] Short authentication string option (residual risk 1).
- [ ] relay-node SQLite persistence.
- [ ] External security review (`05-security.md` gate).
- [ ] Consider single-binary distribution to drop the Node requirement.
