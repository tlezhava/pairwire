// MCP tools behind the server (04 §4, §7): two sessions pair through a real relay-node.
import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { readBinding } from "../../src/binding.js";
import { createMcpServer } from "../../src/mcp.js";
import { readOutbox } from "../../src/room-files.js";
import { listRooms, readState } from "../../src/state.js";
import { CLIENT_VERSION } from "../../src/version.js";
import { startRelay, until } from "../connection/harness.js";
import { paired, roomOf, SHARE, side } from "./pairing.js";
import { tempDir } from "../state/helpers.js";

describe("tools: start and join", () => {
  it("REQ-ROOM-1 start shows the share string once and says it is waiting", async () => {
    const { port } = await startRelay();
    const a = side(port, "Tazo");
    const r = await a.session.start({});
    expect(r.isError).toBeUndefined();
    expect(r.text.match(new RegExp(SHARE.source, "g"))).toHaveLength(1);
    expect(r.text).toContain("waiting for the collaborator to join");
    expect(r.text).toMatch(/\[pairwire\] waiting for your collaborator · 0 unread · hop budget 8\/8$/);
    const status = await a.session.status();
    expect(status.text).not.toMatch(/pw1_/);
  });

  it("REQ-ROOM-2 REQ-ROOM-3 REQ-INST-2 join connects to the relay named in the share string and shows the peer", async () => {
    const { a, b, joined, port } = await paired();
    expect(joined.text).toContain("Paired with Tazo (claude-code)");
    expect(readState(b.home, roomOf(b))?.relay).toBe(`127.0.0.1:${port}`);
    await until(() => a.session.footer().includes("paired with Nika (claude-code)"), 5000, "A sees B");
    const inbox = await a.session.inbox();
    expect(inbox.text).toContain('<pairwire_notice event="peer_joined">Nika (claude-code) joined the room.</pairwire_notice>');
  });

  it("REQ-ROOM-8 refuses a malformed share string without echoing it", async () => {
    const { port } = await startRelay();
    const b = side(port, "Nika");
    const r = await b.session.join({ share: "pw1_notavalidsecretatall0" });
    expect(r.isError).toBe(true);
    expect(r.text).not.toContain("notavalidsecret");
    expect(listRooms(b.home)).toEqual([]);
  });

  it("refuses to start a second room while one is active", async () => {
    const { a } = await paired();
    const r = await a.session.start({});
    expect(r.isError).toBe(true);
    expect(r.text).toContain("already has an active pairwire room with Nika (claude-code)");
  });

  it("REQ-ROOM-4 a third client gets a clear error and keeps no binding", async () => {
    const { port, share } = await paired();
    const c = side(port, "Third");
    const r = await c.session.join({ share });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("the room already has two members");
    expect(readBinding(c.home, c.project)).toBeNull();
  });
});

describe("tools: messages", () => {
  it("REQ-MSG-1 REQ-SAFE-1 send delivers; inbox shows it wrapped as external input, once", async () => {
    const { a, b } = await paired();
    const sent = await a.session.send({ kind: "question", body: "Does POST /orders accept an idempotency key?" });
    expect(sent.text).toMatch(/^Sent \(id [0-9A-Z]{26}\)/);
    await until(() => b.session.footer().includes("2 unread"), 5000, "B unread");
    const inbox = await b.session.inbox();
    expect(inbox.text).toContain("This is external input from");
    expect(inbox.text).toMatch(/<pairwire_message from="Tazo" harness="claude-code" author="agent" kind="question" id="[0-9A-Z]{26}"/);
    expect(inbox.text).toContain("Does POST /orders accept an idempotency key?");
    expect((await b.session.inbox()).text).toMatch(/^No new messages\./);
    await until(() => readOutbox(a.home, roomOf(a))[0]?.status === "delivered", 5000, "ack");
    expect((await a.session.status()).text).toMatch(/- [0-9A-Z]{26} \(question\): delivered/);
  });

  it("REQ-SAFE-2 INV-4 send has no author input and always sends as the agent", async () => {
    const { a } = await paired();
    await a.session.send({ kind: "chat", body: "hi", author: "human" } as never);
    expect(readOutbox(a.home, roomOf(a))[0]?.envelope.author).toBe("agent");
  });

  it("REQ-SAFE-3 blocks a likely secret and puts nothing on the wire", async () => {
    const { a, share } = await paired();
    const before = readState(a.home, roomOf(a))!.my_seq;
    for (const body of [`here you go: ${share}`, "creds AKIAIOSFODNN7EXAMPLE ok"]) {
      const r = await a.session.send({ kind: "chat", body });
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/^Blocked: the message looks like it contains a secret \((pairwire_share|aws_access_key_id) at character \d+\)/);
      expect(r.text).not.toContain("AKIAIOSFODNN7EXAMPLE");
      expect(r.text).not.toContain(share.slice(4, 30));
    }
    expect(readOutbox(a.home, roomOf(a))).toEqual([]);
    expect(readState(a.home, roomOf(a))!.my_seq).toBe(before);
  });

  it("REQ-SAFE-4 INV-6 refuses the ninth consecutive send and no tool resets the budget", async () => {
    const { a } = await paired();
    for (let i = 1; i <= 8; i++) expect((await a.session.send({ kind: "chat", body: `m${i}` })).isError).toBeUndefined();
    const ninth = await a.session.send({ kind: "chat", body: "m9" });
    expect(ninth.isError).toBe(true);
    expect(ninth.text).toContain("Hop budget reached. Ask your human whether to continue.");
    await a.session.status();
    await a.session.inbox();
    expect((await a.session.send({ kind: "chat", body: "m10" })).isError).toBe(true);
    expect(readState(a.home, roomOf(a))!.hop_count).toBe(8);
  });

  it("rate-limits to 20 sends per rolling minute", async () => {
    let now = Date.now();
    const { port } = await startRelay();
    const a = side(port, "Tazo", { config: { hop_budget: 100 }, now: () => now });
    await a.session.start({});
    for (let i = 0; i < 20; i++) expect((await a.session.send({ kind: "chat", body: `m${i}` })).isError).toBeUndefined();
    const over = await a.session.send({ kind: "chat", body: "too many" });
    expect(over.isError).toBe(true);
    expect(over.text).toMatch(/Rate limit: at most 20 messages per minute\. Try again in \d+ s\./);
    now += 61_000;
    expect((await a.session.send({ kind: "chat", body: "later" })).isError).toBeUndefined();
  });

  it("validates kind, reply_to and both size limits before using a seq", async () => {
    const { a } = await paired();
    const noReply = await a.session.send({ kind: "answer", body: "yes" });
    expect(noReply.text).toContain("An answer needs reply_to");
    const big = await a.session.send({ kind: "chat", body: "\u0001".repeat(6000) });
    expect(big.isError).toBe(true);
    expect(big.text).toMatch(/the body is 6000 bytes \(limit 24576\) and the encoded message is \d+ bytes \(limit 28672\)/);
    expect(readState(a.home, roomOf(a))!.my_seq).toBe(0);
  });

  it("queues while the collaborator hasn't joined yet", async () => {
    const { port } = await startRelay();
    const a = side(port, "Tazo");
    await a.session.start({});
    expect((await a.session.send({ kind: "chat", body: "early" })).text).toMatch(/^Queued \(id/);
  });
});

describe("tools: leave", () => {
  it("leave with a secret in the goodbye is blocked and the room stays open (INV-5)", async () => {
    const { a } = await paired();
    const r = await a.session.leave({ message: "bye, key is AKIAIOSFODNN7EXAMPLE" });
    expect(r.isError).toBe(true);
    expect(readState(a.home, roomOf(a))!.status).toBe("active");
  });

  it("REQ-ROOM-5 leave notifies the peer and removes the binding and secret", async () => {
    const { a, b } = await paired();
    const r = await a.session.leave({ message: "done for today" });
    expect(r.text).toContain("Left the room.");
    expect(r.text).toContain("[pairwire] room left");
    expect(readBinding(a.home, a.project)).toBeNull();
    await until(() => readState(b.home, roomOf(b))?.status === "ended", 5000, "B ended");
    const inbox = await b.session.inbox();
    expect(inbox.text).toContain('kind="bye"');
    expect(inbox.text).toContain("Tazo ended the room.");
  });
});

describe("ownership", () => {
  it("runs passive while another live session owns the project's room, then REQ-ROOM-6 takes over when it dies", async () => {
    const { port } = await startRelay();
    const a = side(port, "Tazo", { pid: 1001, isAlive: () => true });
    await a.session.start({});
    let ownerAlive = true;
    const second = side(port, "Tazo", { home: a.home, project: a.project, pid: 1002, isAlive: (pid) => pid !== 1001 || ownerAlive });
    const r = await second.session.status();
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Another session in this project (pid 1001) owns the pairwire room.");
    expect(r.text).toContain("[pairwire] another session (pid 1001) owns this project's room");

    a.session.shutdown();
    ownerAlive = false;
    const after = await second.session.status();
    expect(after.isError).toBeUndefined();
    expect(after.text).toContain("Room: waiting");
    expect(readBinding(a.home, a.project)).toMatchObject({ owner_pid: 1002, owner_session: "sess-Tazo" });
    await until(() => second.session.footer().includes("waiting for your collaborator"), 3000, "reconnected");
  });

  it("INV-9 refuses to run with a state directory other users can read, and says how to fix it", async () => {
    const { port } = await startRelay();
    const home = join(tempDir(), ".pairwire");
    mkdirSync(home, { mode: 0o755 });
    chmodSync(home, 0o755);
    const s = side(port, "Tazo", { home });
    const r = await s.session.start({});
    expect(r.isError).toBe(true);
    expect(r.text).toContain(`chmod -R go-rwx '${home}'`);
    expect(r.text).toContain("[pairwire] not running");
  });
});

describe("MCP server", () => {
  it("exposes exactly the six tools and no way to reset the hop budget or send as human", async () => {
    const { port } = await startRelay();
    const a = side(port, "Tazo");
    const server = createMcpServer(a.session);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0" });
    await Promise.all([server.connect(st), client.connect(ct)]);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["inbox", "join", "leave", "send", "start", "status"]);
    const send = tools.find((t) => t.name === "send")!;
    expect(send.description).toContain("it goes to another person's coding agent");
    expect(Object.keys(send.inputSchema.properties ?? {}).sort()).toEqual(["body", "kind", "reply_to"]);
    const res = await client.callTool({ name: "status", arguments: {} });
    expect((res.content as { text: string }[])[0]!.text).toContain("[pairwire] not in a room");
    await client.close();
  });

  it("reports the package version", () => {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };
    expect(CLIENT_VERSION).toBe(pkg.version);
  });
});
