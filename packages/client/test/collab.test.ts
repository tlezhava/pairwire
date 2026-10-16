// Structured kinds through the tools (04 §3–5, Structured kinds; REQ-COLLAB-*): two sessions
// paired through a real relay-node.
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { COLLAB_PREAMBLE } from "@pairwire/core";
import { describe, expect, it } from "vitest";
import { planStructured } from "../src/collab-send.js";
import { ContractFileError, loadView, readContractFile } from "../src/coord.js";
import { runCtl } from "../src/ctl.js";
import { roomFile } from "../src/paths.js";
import { readInbox, readOutbox } from "../src/room-files.js";
import { readState } from "../src/state.js";
import { startRelay, until } from "./connection/harness.js";
import { roomOf, SHARE, side, type Side } from "./session/pairing.js";
import { tempDir } from "./state/helpers.js";

const ID = /\(id ([0-9A-Z]{26})\)/;
const CONFIG = { hop_budget: 100 };
const SPEC = "openapi: 3.1.0\ninfo:\n  title: Orders\n  version: 2.0.0\n";
const SHA = bytesToHex(sha256(utf8ToBytes(SPEC)));

/** A and B paired; B's clock can run ahead (claim expiry) and B can be an older client. */
async function pair(o: { bOffset?: { ms: number }; bCaps?: string[] } = {}) {
  const { port } = await startRelay();
  const a = side(port, "Tazo", { config: CONFIG });
  const share = (await a.session.start({})).text.match(SHARE)![0];
  const b = side(port, "Nika", {
    config: CONFIG,
    ...(o.bOffset ? { now: () => Date.now() + o.bOffset!.ms } : {}),
    ...(o.bCaps ? { helloCaps: o.bCaps } : {}),
  });
  await b.session.join({ share });
  await until(() => readInbox(a.home, roomOf(a)).length > 0 && readInbox(b.home, roomOf(b)).length > 0, 5000, "both paired");
  await a.session.inbox();
  await b.session.inbox();
  return { a, b };
}

const peerIds = (s: Side) => readInbox(s.home, roomOf(s)).flatMap((e) => (e.source === "peer" ? [e.id] : []));
async function arrives(s: Side, id: string) {
  await until(() => peerIds(s).includes(id), 10_000, `message ${id} arrives`);
}
async function send(s: Side, input: Parameters<Side["session"]["send"]>[0]) {
  const r = await s.session.send(input);
  if (r.isError) throw new Error(r.text);
  return { text: r.text, id: r.text.match(ID)![1]! };
}
const statusOf = async (s: Side) => (await s.session.status()).text;
const transcript = (s: Side) => readFileSync(roomFile(s.home, roomOf(s), "transcript.md"), "utf8");
const writeIn = (s: Side, rel: string, text: string | Uint8Array) => {
  mkdirSync(join(s.project, rel, ".."), { recursive: true });
  writeFileSync(join(s.project, rel), text);
};

async function ctl(s: Side, args: string[]): Promise<string> {
  let out = "";
  const stdout = new Writable({
    write(chunk, _enc, cb) {
      out += String(chunk);
      cb();
    },
  });
  await runCtl(args, { stdin: Readable.from([""]), stdout, env: { PAIRWIRE_HOME: s.home }, cwd: s.project });
  return out;
}
const setHold = (s: Side, hold: boolean) => writeFileSync(join(s.home, "config.json"), JSON.stringify({ ...CONFIG, hold }));

describe("structured kinds: heads-up and claims", { timeout: 30_000 }, () => {
  it("REQ-COLLAB-1 a heads-up reaches the peer's agent with its paths as an attribute, and nothing else happens there", async () => {
    const { a, b } = await pair();
    const { id } = await send(a, { kind: "heads_up", body: "Renaming OrderStatus.PENDING to OPEN.", paths: ["packages/types/src/order.ts"] });
    await arrives(b, id);
    const inbox = (await b.session.inbox()).text;
    expect(inbox).toContain(COLLAB_PREAMBLE.any);
    expect(inbox).toMatch(new RegExp(`kind="heads_up" id="${id}" received="[^"]+" paths="packages/types/src/order\\.ts">\\nRenaming OrderStatus`));
    expect(await statusOf(b)).not.toContain("Claims");
    expect(readOutbox(b.home, roomOf(b))).toEqual([]);
  });

  it("REQ-COLLAB-2 a claim shows in both statuses and the peer's footer until released, warns on overlap, and locks nothing", async () => {
    const { a, b } = await pair();
    const claim = await send(a, { kind: "claim", body: "Refactoring order validation.", paths: ["src/orders/**", "src/api/orders.ts"] });
    expect(claim.text).toMatch(/Claim active until \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z \(advisory; pairwire locks nothing\)\./);
    await arrives(b, claim.id);
    expect(b.session.footer()).toMatch(/ · 1 peer claim$/);
    const inbox = (await b.session.inbox()).text;
    expect(inbox).toContain(COLLAB_PREAMBLE.claim);
    expect(inbox).toMatch(new RegExp(`kind="claim" id="${claim.id}" received="[^"]+" paths="src/orders/\\*\\*, src/api/orders\\.ts" expires="[^"]+" match="yes">`));
    expect(await statusOf(b)).toMatch(new RegExp(`Claims \\(advisory; pairwire locks nothing\\):\\n  Tazo's agent \\(external input\\): src/orders/\\*\\*, src/api/orders\\.ts · claim ${claim.id} · until \\d\\d:\\d\\dZ\\n  yours: none`));
    expect(await statusOf(a)).toContain(`  yours: src/orders/**, src/api/orders.ts · claim ${claim.id} · until`);
    expect(a.session.footer()).not.toContain("peer claim");

    // B can still send about (and edit) those paths: it only gets a warning.
    const warned = await send(b, { kind: "heads_up", body: "Touching orders too.", paths: ["src/orders/validate.ts"] });
    expect(warned.text).toContain(`Warning: overlaps Tazo's claim ${claim.id} (src/orders/**).`);

    const release = await send(a, { kind: "release", reply_to: claim.id });
    await arrives(b, release.id);
    expect((await b.session.inbox()).text).toMatch(new RegExp(`kind="release" id="${release.id}" reply_to="${claim.id}" received="[^"]+" match="yes" paths="src/orders/\\*\\*, src/api/orders\\.ts">\\n\\(no message\\)`));
    expect(await statusOf(b)).not.toContain("Claims");
    expect(await statusOf(a)).not.toContain("Claims");
    expect(b.session.footer()).not.toContain("peer claim");
  });

  it("REQ-COLLAB-2 a claim expires at its local arrival time plus the TTL", async () => {
    const offset = { ms: 0 };
    const { a, b } = await pair({ bOffset: offset });
    const claim = await send(a, { kind: "claim", body: "Quick fix.", paths: ["src/a.ts"], ttl_minutes: 5 });
    await arrives(b, claim.id);
    expect(await statusOf(b)).toContain(`claim ${claim.id}`);
    offset.ms = 5 * 60_000 + 1000;
    expect(await statusOf(b)).not.toContain("Claims");
    expect(b.session.footer()).not.toContain("peer claim");
  });

  it("REQ-COLLAB-2 send refuses a seventeenth active claim and a release of a claim that isn't yours", async () => {
    const { a, b } = await pair();
    for (let i = 0; i < 16; i++) await send(a, { kind: "claim", body: `part ${i}`, paths: [`src/p${i}.ts`] });
    const seq = readState(a.home, roomOf(a))!.my_seq;
    const extra = await a.session.send({ kind: "claim", body: "one more", paths: ["src/p16.ts"] });
    expect(extra.isError).toBe(true);
    expect(extra.text).toContain("You already have 16 active claims; release one first.");
    const theirs = await send(b, { kind: "claim", body: "mine", paths: ["lib/x.ts"] });
    await arrives(a, theirs.id);
    for (const id of [theirs.id, "01JZZZZZZZZZZZZZZZZZZZZZZZ"]) {
      const r = await a.session.send({ kind: "release", reply_to: id });
      expect(r.isError).toBe(true);
      expect(r.text).toContain(`No active claim of yours with id ${id}; nothing was sent.`);
    }
    expect(readState(a.home, roomOf(a))!.my_seq).toBe(seq);
  });

  it("names a field that doesn't belong to the kind, and sends nothing", async () => {
    const { a } = await pair();
    const cases = [
      [{ kind: "chat", body: "hi", paths: ["src/a.ts"] }, "paths doesn't apply to kind \"chat\""],
      [{ kind: "claim", body: "x", paths: ["src/a.ts"], decision: "accept" }, "decision doesn't apply to kind \"claim\""],
      [{ kind: "heads_up", body: "x", reply_to: "01JZZZZZZZZZZZZZZZZZZZZZZZ", ttl_minutes: 5 }, "reply_to, ttl_minutes don't apply"],
      [{ kind: "claim", body: "x" }, "A claim needs paths"],
      [{ kind: "claim", paths: ["src/a.ts"] }, "A claim needs a body saying why"],
      [{ kind: "claim", body: "x", paths: ["**"] }, "paths[0] must start with a literal name"],
      [{ kind: "claim", body: "x", paths: ["../etc/passwd"] }, "paths[0] must not have . or .. segments"],
      [{ kind: "claim", body: "x", paths: ["src/a.ts"], ttl_minutes: 2000 }, "ttl_minutes must be a whole number from 5 to 1440"],
    ] as const;
    for (const [input, message] of cases) {
      const r = await a.session.send(input as never);
      expect(r.isError, message).toBe(true);
      expect(r.text).toContain(message);
    }
    expect(readOutbox(a.home, roomOf(a))).toEqual([]);
  });
});

describe("structured kinds: contracts", { timeout: 30_000 }, () => {
  it("REQ-COLLAB-3 a proposal binds to the file's hash; an accept with a matching local copy is recorded on both sides", async () => {
    const { a, b } = await pair();
    writeIn(a, "contracts/orders-api.yaml", SPEC);
    writeIn(b, "api/orders.yaml", SPEC);
    writeIn(b, "api/stale.yaml", SPEC + "# old\n");
    const p = await send(a, { kind: "contract_propose", body: "Orders API v2.", contract_name: "orders-api", contract_path: "contracts/orders-api.yaml", rev: "a1b2c3d4" });
    expect(p.text).toContain(`Contract orders-api v1, sha256 ${SHA}.`);
    await arrives(b, p.id);
    expect(b.session.footer()).toMatch(/ · 1 contract awaiting your answer$/);
    const inbox = (await b.session.inbox()).text;
    expect(inbox).toContain(COLLAB_PREAMBLE.contract);
    expect(inbox).toContain(`kind="contract_propose" id="${p.id}"`);
    expect(inbox).toContain(`name="orders-api" version="1" path="contracts/orders-api.yaml" rev="a1b2c3d4" sha256="${SHA}" match="yes" status="pending">`);
    expect(inbox).not.toContain("openapi"); // ref-only: the hash, never the file
    expect(await statusOf(b)).toContain(`orders-api v1 · sha256 ${SHA.slice(0, 8)}… · proposed by Tazo ${p.id} (external input) · awaiting your answer`);
    expect(await statusOf(a)).toContain(`orders-api v1 · sha256 ${SHA.slice(0, 8)}… · proposed by you ${p.id} · awaiting Nika's answer · your file: in sync`);

    const wrong = await b.session.send({ kind: "contract_response", reply_to: p.id, decision: "accept", local_path: "api/stale.yaml" });
    expect(wrong.isError).toBe(true);
    expect(wrong.text).toContain("Your copy at api/stale.yaml doesn't match the proposal; not accepted.");
    const ok = await send(b, { kind: "contract_response", reply_to: p.id, decision: "accept", body: "Agreed.", local_path: "api/orders.yaml" });
    expect(ok.text).toContain(`Contract orders-api v1, sha256 ${SHA}.`);
    await arrives(a, ok.id);
    expect((await a.session.inbox()).text).toContain(
      `kind="contract_response" id="${ok.id}" reply_to="${p.id}" received="${new Date(readInbox(a.home, roomOf(a)).find((e) => e.id === ok.id)!.received_at).toISOString()}" decision="accept" name="orders-api" version="1" sha256="${SHA}" match="yes" path="contracts/orders-api.yaml">`,
    );
    expect(await statusOf(a)).toMatch(new RegExp(`orders-api v1 · .* · accepted by Nika \\d\\d:\\d\\dZ · your file: in sync`));
    expect(await statusOf(b)).toMatch(new RegExp(`orders-api v1 · .* · accepted by you \\d\\d:\\d\\dZ · your file: in sync`));
    writeIn(b, "api/orders.yaml", SPEC + "x: 1\n");
    expect(await statusOf(b)).toContain("your file: changed locally");
    expect(b.session.footer()).not.toContain("awaiting");
    expect(transcript(b)).toMatch(new RegExp(`### → .* · you \\(agent\\) · contract_response · ${ok.id} · re ${p.id} · accept · orders-api v1 · sha256 ${SHA.slice(0, 8)}\\n> Agreed\\.`));
    expect(transcript(a)).toMatch(new RegExp(`### → .* · contract_propose · ${p.id} · orders-api v1 · contracts/orders-api\\.yaml · @ a1b2c3d4 · sha256 ${SHA.slice(0, 8)}\\n`));
  });

  it("REQ-COLLAB-3 inline content is shown as the exact bytes; a reject needs a reason; only the live proposal can be answered", async () => {
    const { a, b } = await pair();
    writeIn(a, "contracts/orders-api.yaml", SPEC);
    const differs = await a.session.send({ kind: "contract_propose", body: "v1", contract_name: "orders-api", contract_path: "contracts/orders-api.yaml", contract_content: SPEC + "extra" });
    expect(differs.text).toContain("contract_content differs from the file at contract_path; not proposed.");
    const p1 = await send(a, { kind: "contract_propose", body: "v1 inline", contract_name: "orders-api", contract_path: "contracts/orders-api.yaml", contract_content: SPEC });
    await arrives(b, p1.id);
    expect((await b.session.inbox()).text).toContain(`<pairwire_contract_content of="${p1.id}" name="orders-api" version="1" sha256="${SHA}">\n${SPEC}\n</pairwire_contract_content>`);
    const noReason = await b.session.send({ kind: "contract_response", reply_to: p1.id, decision: "reject" });
    expect(noReason.text).toContain("A contract_response needs a body");
    const rejectWithPath = await b.session.send({ kind: "contract_response", reply_to: p1.id, decision: "reject", body: "no", local_path: "x.yaml" });
    expect(rejectWithPath.text).toContain("local_path applies only when accepting");

    writeIn(a, "contracts/orders-api.yaml", SPEC + "  description: v2\n");
    const p2 = await send(a, { kind: "contract_propose", body: "v2", contract_name: "orders-api", contract_path: "contracts/orders-api.yaml" });
    expect(p2.text).toContain("Contract orders-api v2,");
    await arrives(b, p2.id);
    // Not answerable until B's agent has been shown it.
    expect((await b.session.send({ kind: "contract_response", reply_to: p2.id, decision: "reject", body: "no" })).text).toContain("No open proposal");
    await b.session.inbox();
    const old = await b.session.send({ kind: "contract_response", reply_to: p1.id, decision: "accept" });
    expect(old.text).toContain(`No open proposal from your collaborator with id ${p1.id}; nothing was sent.`);
    const reject = await send(b, { kind: "contract_response", reply_to: p2.id, decision: "reject", body: "We need 422, not 409." });
    await arrives(a, reject.id);
    expect(await statusOf(a)).toMatch(/orders-api v2 · .* · rejected by Nika/);
    // Our own proposal can't be answered by us.
    const own = await a.session.send({ kind: "contract_response", reply_to: p2.id, decision: "accept" });
    expect(own.text).toContain(`No open proposal from your collaborator with id ${p2.id}`);
  });

  it("REQ-COLLAB-3 REQ-SAFE-6 a held proposal appears nowhere and its id gets the unknown-id error; an answer that arrives anyway renders superseded", async () => {
    const { a, b } = await pair();
    writeIn(a, "contracts/events.yaml", SPEC);
    setHold(b, true);
    const p1 = await send(a, { kind: "contract_propose", body: "events v1", contract_name: "events", contract_path: "contracts/events.yaml" });
    await arrives(b, p1.id);
    expect(await ctl(b, ["accept"])).toContain("released 1 held message");
    writeIn(a, "contracts/events.yaml", SPEC + "# v2\n");
    const p2 = await send(a, { kind: "contract_propose", body: "events v2", contract_name: "events", contract_path: "contracts/events.yaml" });
    const claim = await send(a, { kind: "claim", body: "held claim", paths: ["src/held-only/**"] });
    await arrives(b, claim.id);
    const status = await statusOf(b);
    expect(status).toContain(`events v1 · sha256`);
    expect(status).not.toContain("events v2");
    expect(status).not.toContain("held-only");
    expect(b.session.footer()).toMatch(/ · 1 contract awaiting your answer$/);
    const overlap = await send(b, { kind: "heads_up", body: "touching", paths: ["src/held-only/a.ts"] });
    expect(overlap.text).not.toContain("Warning");
    const heldErr = await b.session.send({ kind: "contract_response", reply_to: p2.id, decision: "accept" });
    const ghostErr = await b.session.send({ kind: "contract_response", reply_to: "01JZZZZZZZZZZZZZZZZZZZZZZZ", decision: "accept" });
    expect(heldErr.text.replace(p2.id, "<id>").split("\n\n")[0]).toBe(ghostErr.text.replace("01JZZZZZZZZZZZZZZZZZZZZZZZ", "<id>").split("\n\n")[0]);
    // Answering v1 is allowed on B's side, where v2 is still held; on A's side v2 is live.
    const late = await send(b, { kind: "contract_response", reply_to: p1.id, decision: "accept" });
    await arrives(a, late.id);
    expect((await a.session.inbox()).text).toMatch(new RegExp(`id="${late.id}" .* match="superseded" path="contracts/events\\.yaml">`));
    expect(await statusOf(a)).toMatch(/events v2 · .* · awaiting Nika's answer/);
    // The log hides a held message's structured fields too.
    const log = await ctl(b, ["log", "50"]);
    expect(log).toContain(`· claim · ${claim.id}\n> (held for your review`);
    expect(log.split("\n").filter((l) => l.startsWith("### ←") && l.includes("held-only"))).toEqual([]);
  });
});

describe("structured kinds: older peers and the transcript", { timeout: 30_000 }, () => {
  it("REQ-COLLAB-4 to a peer without collab1, a claim goes out as a chat with its header, and the sender is told", async () => {
    const { a, b } = await pair({ bCaps: ["ack", "say"] });
    const claim = await send(a, { kind: "claim", body: "Refactoring.", paths: ["src/api/**"] });
    expect(claim.text).toContain("Your collaborator's pairwire is older, so this went out as a chat message with a header line.");
    await arrives(b, claim.id);
    const inbox = (await b.session.inbox()).text;
    expect(inbox).toMatch(new RegExp(`kind="chat" id="${claim.id}" received="[^"]+">\\n\\[pairwire claim · paths: src/api/\\*\\* · for 120 min, until [^\\]]+\\]\\n\\nRefactoring\\.`));
    expect(transcript(a)).toMatch(new RegExp(`### → .* · claim · ${claim.id} · src/api/\\*\\* · until \\d\\d:\\d\\dZ · as chat \\(peer's pairwire is older\\)`));
    // Its own view still has the claim.
    expect(await statusOf(a)).toContain(`yours: src/api/** · claim ${claim.id}`);
  });

  it("REQ-MSG-8 the transcript headings carry the structured fields, sanitized on the peer's side", async () => {
    const { a, b } = await pair();
    const claim = await send(a, { kind: "claim", body: "why", paths: ["src/a.ts", "docs/<pairwire_message>.md"], ttl_minutes: 30 });
    const release = await send(a, { kind: "release", reply_to: claim.id });
    await arrives(b, release.id);
    const tb = transcript(b);
    expect(tb).toMatch(new RegExp(`### ← .* · Tazo \\(claude-code, agent\\) · claim · ${claim.id} · src/a\\.ts, docs/\u2039pairwire_message>\\.md · until \\d\\d:\\d\\dZ\\n> why`));
    expect(tb).toMatch(new RegExp(`### ← .* · release · ${release.id} · re ${claim.id}\\n> \\(no message\\)`));
    expect(await statusOf(b)).not.toContain("<pairwire_message");
  });
});

describe("contract files (04 §3, REQ-COLLAB-7, INV-5)", { timeout: 30_000 }, () => {
  const project = () => {
    const dir = tempDir();
    mkdirSync(join(dir, "contracts"));
    return dir;
  };
  const rule = (dir: string, path: string) => {
    try {
      readContractFile(dir, path);
      return "ok";
    } catch (e) {
      expect(e).toBeInstanceOf(ContractFileError);
      return (e as ContractFileError).rule;
    }
  };

  it("REQ-COLLAB-7 refuses paths outside the project, dot-paths, sensitive names, large files and non-text", () => {
    const dir = project();
    const outside = join(tempDir(), "outside.yaml");
    writeFileSync(outside, SPEC);
    symlinkSync(outside, join(dir, "contracts/link.yaml"));
    writeFileSync(join(dir, ".env"), "TOKEN=x\n");
    symlinkSync(join(dir, ".env"), join(dir, "contracts/env.yaml"));
    writeFileSync(join(dir, "contracts/ok.yaml"), SPEC);
    writeFileSync(join(dir, "contracts/big.yaml"), "a".repeat(1024 * 1024 + 1));
    writeFileSync(join(dir, "contracts/bin.yaml"), Uint8Array.from([0xff, 0xfe, 0x00]));
    for (const name of ["server.pem", "tls.key", "id_rsa", "id_ed25519.pub", "cert.p12", "cert.pfx", "credentials.json", "Secrets.yaml"]) {
      writeFileSync(join(dir, "contracts", name), SPEC);
      expect(rule(dir, `contracts/${name}`), name).toBe("sensitive_name");
    }
    expect(rule(dir, "contracts/ok.yaml")).toBe("ok");
    expect(readContractFile(dir, "contracts/ok.yaml").sha256).toBe(SHA);
    expect(rule(dir, "contracts/link.yaml")).toBe("outside_project");
    expect(rule(dir, "contracts/env.yaml")).toBe("dot_path");
    expect(rule(dir, ".env")).toBe("bad_path");
    expect(rule(dir, "../outside.yaml")).toBe("bad_path");
    expect(rule(dir, "contracts/*.yaml")).toBe("bad_path");
    expect(rule(dir, "contracts/big.yaml")).toBe("too_large");
    expect(rule(dir, "contracts/bin.yaml")).toBe("not_utf8");
    expect(rule(dir, "contracts/none.yaml")).toBe("missing");
    expect(rule(dir, "contracts")).toBe("not_a_file");
  });

  it("REQ-COLLAB-7 INV-5 refuses a file with a secret without echoing it, and the propose sends nothing", async () => {
    const { a } = await pair();
    writeIn(a, "contracts/keys.yaml", "aws: AKIAIOSFODNN7EXAMPLE\n");
    const r = await a.session.send({ kind: "contract_propose", body: "keys", contract_name: "keys", contract_path: "contracts/keys.yaml" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Not proposed: contracts/keys.yaml: looks like it contains a secret (aws_access_key_id at character 5).");
    expect(r.text).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(readOutbox(a.home, roomOf(a))).toEqual([]);
  });

  it("INV-5 scans every new text field and the chat fallback", async () => {
    const { a } = await pair();
    const blocked = await a.session.send({ kind: "claim", body: "fine", paths: ["src/AKIAIOSFODNN7EXAMPLE.ts"] });
    expect(blocked.text).toMatch(/^Blocked: the message looks like it contains a secret \(aws_access_key_id at character 4 in paths\[0\]\)/);
    writeIn(a, "contracts/x.yaml", SPEC);
    const plan = planStructured(
      { kind: "contract_propose", body: "b", contract_name: "x", contract_path: "contracts/x.yaml", contract_content: SPEC, rev: "abcdef1" },
      { loaded: loadView(a.home, roomOf(a), { hold: false, now: Date.now() }), projectDir: a.project, peerName: "Nika", now: Date.now(), roomExpiresAt: Date.now() + 1e9, nextSeq: 1 },
    );
    expect(plan.scan.map(([label]) => label)).toEqual(["body", "contract_name", "contract_path", "rev", "contract_content", "the chat fallback"]);
    expect(readOutbox(a.home, roomOf(a))).toEqual([]);
  });
});
