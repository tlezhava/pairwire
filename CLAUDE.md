# pairwire — instructions for Claude Code

pairwire lets two engineers pair through their coding agents. Each engineer runs a
local plugin; one starts a room, shares a key out-of-band, the other joins, and the two
agent sessions can then message each other through an end-to-end encrypted relay.

This repository is built with **spec-driven development**. The specs are the source of
truth; code implements them.

## Read first

| File | What it defines |
|---|---|
| `specs/00-product.md` | Problem, users, scope, requirements (REQ-*) with acceptance criteria |
| `specs/01-architecture.md` | Components, repo layout, tech stack, data flow |
| `specs/02-protocol.md` | Share string, key derivation, handshake, encryption, relay frames, envelope |
| `specs/03-relay.md` | Relay behavior, limits, Cloudflare + Node implementations, self-hosting |
| `specs/04-client.md` | MCP server, tools, local state, delivery tiers, hooks, plugin layout |
| `specs/05-security.md` | Threat model and security invariants (INV-*) |
| `specs/06-agent-guide.md` | The instructions the plugin gives to agents (becomes SKILL.md) |
| `specs/07-testing.md` | Test strategy and the acceptance test matrix |
| `specs/tasks.md` | Ordered milestones and tasks — the work queue |
| `specs/decisions.md` | Decision log (ADRs) and spike findings |

Read `specs/tasks.md` and the specs referenced by the task you are working on before
writing any code. You do not need to read every spec for every task.

## Workflow rules

1. **Work the queue.** Take the first unchecked task in `specs/tasks.md` whose
   dependencies are done. One task at a time. Check it off in the same commit that
   completes it.
2. **Specs before code.** If a task needs behavior the specs don't define, or the specs
   turn out to be wrong, stop and update the spec first (in the same branch), and add an
   entry to `specs/decisions.md` explaining why. Never let code silently diverge from a
   spec.
3. **Spikes answer questions, they don't ship.** Milestone M0 tasks are spikes. Put
   throwaway code under `spikes/<id>/`, record findings in `specs/decisions.md`, then
   update the affected spec. Spike code is never imported by product code.
4. **Requirements are traceable.** Every REQ-* and INV-* has at least one test whose
   name contains the ID (e.g. `it("REQ-ROOM-4: third member is refused", ...)`), or a
   `manual`/`deferred` entry in `tests/traceability.json` (see `specs/07-testing.md`).
5. **Test first for `packages/core`.** Crypto, codecs, envelope validation and the
   sanitizer are written test-first, including the fixed test vectors in
   `specs/02-protocol.md`.
6. **Ask the human** before: adding a runtime dependency not listed in
   `specs/01-architecture.md`, changing anything in `specs/00-product.md` goals/non-goals,
   changing a security invariant, deploying anything, or publishing anything. Dev
   dependencies and anything under `spikes/` don't need approval
   (`specs/01-architecture.md`, Tech stack).

## Security invariants (summary — full text in specs/05-security.md)

- The relay never sees plaintext or the share secret.
- Nothing a peer sends is ever executed; it only reaches an agent as labeled, sanitized data.
- The plugin never auto-approves its own send tool; outbound messages go through the
  harness's normal approval prompt by default.
- Outbound messages are scanned for secrets (including pairwire share strings) and blocked
  on a match.
- Secrets and share strings are never logged.

If a task seems to require weakening one of these, stop and ask.

## Conventions

- TypeScript, `strict: true`, ESM only, Node >= 20. npm workspaces.
- `packages/core` must stay isomorphic: no Node built-ins, no DOM. It runs in Node and in
  Cloudflare Workers.
- Cryptography only via `@noble/curves`, `@noble/hashes`, `@noble/ciphers`. No hand-rolled
  primitives; constructions are exactly those in `specs/02-protocol.md`.
- Validate every external input (relay frames, envelopes, tool arguments, config) with
  `zod` schemas that live next to the spec'd types.
- Conventional commits (`feat:`, `fix:`, `test:`, `docs:`, `spec:`, `chore:`), small and
  focused. Spec changes use `spec:`.
- No `console.log` in library code. The client logs through `packages/client/src/log.ts`;
  each relay has its own thin logger. All of them redact through `redact()` from
  `packages/core`. Core itself does no I/O and never logs.
- Never write invisible or bidirectional-control characters literally in source (zero-width,
  bidi overrides, the Unicode tag block). Use `\u` escapes; `npm run lint` fails otherwise.

## Commands

These are created in task M1-1; keep this list in sync with `package.json`.

```bash
npm install
npm run build          # build all packages
npm run build:plugin   # bundle the client into plugins/claude-code/dist and generate SKILL.md (M4-3)
npm test               # unit + integration tests
npm run test:e2e       # two-client end-to-end tests against a local relay (M3-8)
npm run lint           # eslint + hidden-character check + tsc --noEmit
npm run traceability   # REQ-*/INV-* ids without a test (warnings until M4-6, then errors)
npm run relay:dev      # Cloudflare relay locally (wrangler dev) (M2-3)
npm run relay:node     # Node relay locally (M2-2)
```

Scripts marked with a task exit with "not implemented yet" until that task lands.

Adding or upgrading a dependency: use `npx npm@11 install <pkg>`. npm 10.9, which ships
with Node 20 and 22, crashes while resolving vitest's optional peers (ADR-015).
`npm install` and `npm ci` against the committed lockfile work with npm 10.
