// Group rooms end to end through relay-node (02 §8, 04 §4 Group rooms, ADR-037): three
// ClientSessions pair up pairwise, fan messages out, and keep going when one leaves.
import { describe, expect, it } from "vitest";
import { readGroup, readGroupOutbox } from "../../src/group-files.js";
import { readInbox } from "../../src/room-files.js";
import type { SocketFactory } from "../../src/connection.js";
import { readState } from "../../src/state.js";
import { startRelay, until } from "../connection/harness.js";
import { roomOf, side, type Side } from "./pairing.js";

const PW2 = /pw2_[a-z2-7]{52}@127\.0\.0\.1:\d+/;
const peerBodies = (s: Side) =>
  readInbox(s.home, roomOf(s))
    .filter((e) => e.source === "peer")
    .map((e) => (e.source === "peer" ? e.envelope.body : ""));
const notices = (s: Side) => readInbox(s.home, roomOf(s)).flatMap((e) => (e.source === "local" ? [e.text] : []));

async function trio(size = 3) {
  const { port } = await startRelay();
  const a = side(port, "Tazo");
  const started = await a.session.start({ size });
  const share = started.text.match(PW2)![0];
  const b = side(port, "Nika");
  const c = side(port, "Ana");
  const joinedB = await b.session.join({ share });
  const joinedC = await c.session.join({ share });
  // Every pair has a session.
  await until(() => [a, b, c].every((s) => Object.values(readGroup(s.home, roomOf(s))!.peers).filter((p) => p.sessions.current).length === 2), 10_000, "pairwise sessions");
  return { port, a, b, c, share, started, joinedB, joinedC };
}

describe("group rooms (ADR-037)", { timeout: 30_000 }, () => {
  it("REQ-ROOM-9 a room for 3: a pw2 share string, three members paired pairwise", async () => {
    const { a, b, c, started, joinedC } = await trio();
    expect(started.text).toContain("Room for 3 created.");
    expect(started.text).not.toMatch(/pw1_/);
    expect(joinedC.text).toMatch(/^Paired with (Tazo|Nika) \(claude-code\)(, (Tazo|Nika) \(claude-code\))? \(3 of 3 joined\)/);
    await until(() => a.session.footer().includes("3 of 3 joined"), 5000, "footer");
    expect(a.session.footer()).toMatch(/paired with Nika \(claude-code\), Ana \(claude-code\) · 3 of 3 joined/);
    const status = (await a.session.status()).text;
    expect(status).toMatch(/Members: you; Nika \(claude-code\), online; Ana \(claude-code\), online \(3 of 3 joined\)/);
    // No coordination caps in a group room's HELLO.
    expect(Object.values(readGroup(b.home, roomOf(b))!.peers).every((p) => !p.caps.includes("collab1"))).toBe(true);
    expect(readState(c.home, roomOf(c))!.status).toBe("active");
  });

  it("REQ-ROOM-10 a message reaches every other member, each copy acked on its own", async () => {
    const { a, b, c } = await trio();
    const sent = await a.session.send({ kind: "chat", body: "hello everyone" });
    expect(sent.text).toMatch(/^Sent \(id [0-9A-Z]{26}\)/);
    await until(() => peerBodies(b).includes("hello everyone") && peerBodies(c).includes("hello everyone"), 5000, "both got it");
    await until(() => readGroupOutbox(a.home, roomOf(a)).filter((e) => e.status === "delivered").length === 2, 5000, "both acked");
    expect((await a.session.inbox()).text).toMatch(/- [0-9A-Z]{26} \(chat\): delivered/);
    // The reply goes to both others too, with the sender's name.
    await c.session.send({ kind: "question", body: "who owns the API?" });
    await until(() => peerBodies(a).includes("who owns the API?") && peerBodies(b).includes("who owns the API?"), 5000, "question fanned out");
    expect(readInbox(b.home, roomOf(b)).find((e) => e.source === "peer" && e.envelope.body === "who owns the API?")).toMatchObject({ from: "Ana" });
  });

  it("REQ-ROOM-4 a fourth member is refused once the room is full", async () => {
    const { port, share } = await trio();
    const d = side(port, "Dan");
    const r = await d.session.join({ share });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Could not join: the room is full.");
  });

  it("REQ-ROOM-11 one member leaving tells the others, and the room stays open for them", async () => {
    const { a, b, c } = await trio();
    const left = await b.session.leave({});
    expect(left.text).toContain("the room stays open for them");
    await until(() => notices(a).some((n) => n === "Nika left the room; it stays open for the others."), 5000, "A told");
    await until(() => notices(c).some((n) => n === "Nika left the room; it stays open for the others."), 5000, "C told");
    expect(readState(a.home, roomOf(a))!.status).toBe("active");
    await a.session.send({ kind: "chat", body: "still here" });
    await until(() => peerBodies(c).includes("still here"), 5000, "C got it");
    expect(readGroupOutbox(a.home, roomOf(a)).filter((e) => e.envelope.body === "still here").map((e) => e.to)).toHaveLength(1);
    expect(a.session.footer()).toContain("2 of 3 joined");
  });

  it("refuses coordination kinds in a group room", async () => {
    const { a } = await trio();
    const r = await a.session.send({ kind: "heads_up", body: "changing the schema", paths: ["db/schema.sql"] });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Coordination messages work in two-person rooms only");
  });

  it("a member that restarts gets fresh sessions with everyone and receives what was sent meanwhile", async () => {
    const { port, a, b, c } = await trio();
    c.session.shutdown();
    await a.session.send({ kind: "chat", body: "while Ana was away" });
    await until(() => peerBodies(b).includes("while Ana was away"), 5000, "B got it");
    const c2 = side(port, "Ana", { home: c.home, project: c.project });
    await until(() => peerBodies(c2).includes("while Ana was away"), 10_000, "C2 got it");
    await c2.session.send({ kind: "chat", body: "back" });
    await until(() => peerBodies(a).includes("back") && peerBodies(b).includes("back"), 5000, "both got back");
  });

  it("refuses to send while nobody else has joined", async () => {
    const { port } = await startRelay();
    const a = side(port, "Tazo");
    await a.session.start({ size: 4 });
    const r = await a.session.send({ kind: "chat", body: "anyone?" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Nobody else has joined the room yet, so the message was not sent.");
  });

  it("a relay without group rooms (4004) ends the room and says why", async () => {
    const { port } = await startRelay();
    // A relay that speaks protocol 1 only closes a v2 join with 4004 (02 §8.2 rule 4).
    const oldRelay: SocketFactory = (_url, h) => {
      setTimeout(() => h.onOpen(), 1);
      return {
        sendText: (d: string) => {
          if (d.includes('"join"')) setTimeout(() => h.onClose(4004), 1);
        },
        sendBinary: () => {},
        close: () => {},
      };
    };
    const a = side(port, "Tazo", { socketFactory: oldRelay });
    const r = await a.session.start({ size: 3 });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("This relay doesn't host rooms for more than two people");
    expect(readState(a.home, roomOf(a))!.status).toBe("ended");
  });

  it("a pair room is still the default", async () => {
    const { port } = await startRelay();
    const a = side(port, "Tazo");
    expect((await a.session.start({})).text).toMatch(/pw1_/);
    expect((await side(port, "Nika").session.start({ size: 2 })).text).toMatch(/pw1_/);
  });
});
