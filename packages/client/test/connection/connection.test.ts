// Connection manager against a real relay-node (02 §4–6, 04 §3; 07-testing.md client).
import { describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { HELLO_TYPE, MSG_TYPE } from "@pairwire/core";
import { readSecret, updateState } from "../../src/state.js";
import { makeClient, MAX_AGE, newSecret, shiftedClock, sleep, startRelay, until, wrongKeys, type Client } from "./harness.js";

async function pair(opts: { a?: Parameters<typeof makeClient>[3]; b?: Parameters<typeof makeClient>[3] } = {}) {
  const { port } = await startRelay();
  const secret = newSecret();
  const a = makeClient("Tazo", port, secret, opts.a);
  const b = makeClient("Nika", port, secret, opts.b);
  a.conn.start();
  await until(() => a.conn.status().socket === "joined", 5000, "A joined");
  b.conn.start();
  await until(() => a.conn.status().session && b.conn.status().session, 5000, "handshake");
  return { port, secret, a, b };
}

const bodies = (c: Client) => c.inbox().flatMap((e) => (e.source === "peer" ? [e.envelope.body] : []));
const notices = (c: Client) => c.inbox().flatMap((e) => (e.source === "local" ? [e.event] : []));

describe("connection: handshake and identity", () => {
  it("REQ-ROOM-3 completes the handshake and tells both agents who joined", async () => {
    const { a, b } = await pair();
    expect(a.state()).toMatchObject({ status: "active", member: "a", peer: { name: "Nika", harness: "claude-code" } });
    expect(b.state()).toMatchObject({ status: "active", member: "b", peer: { name: "Tazo", harness: "claude-code" } });
    expect(a.state().sessions.current?.sid).toBe(b.state().sessions.current?.sid);
    expect(a.state().token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    await until(() => notices(a).includes("peer_joined") && notices(b).includes("peer_joined"));
    expect(a.inbox().find((e) => e.source === "local")).toMatchObject({ text: "Nika (claude-code) joined the room." });
  });

  it("queues no new peer_joined on a reconnect, but warns when the peer is a different client", async () => {
    const { a, b } = await pair();
    const b2 = b.restart();
    b2.conn.start();
    await until(() => b2.state().sessions.previous !== null && a.state().sessions.previous !== null, 5000, "second handshake");
    await sleep(100);
    expect(notices(a).filter((n) => n === "peer_joined")).toHaveLength(1);

    // Same slot token, different instance id: as if another client had taken over B's state.
    b2.conn.stop();
    updateState(b.home, b.keys.roomId, (s) => ({ ...s, instance: "a".repeat(26) }));
    const other = b.restart();
    other.conn.start();
    await until(() => notices(a).includes("peer_changed"), 5000, "peer_changed");
    expect(a.state().peer?.instance).toBe("a".repeat(26));
  });
});

describe("connection: reliable delivery (02 §6)", () => {
  it("REQ-MSG-6 delivers a message, appends it to the inbox and reports delivered via the ack", async () => {
    const { a, b } = await pair();
    const sent = a.conn.send({ kind: "question", body: "does POST /orders take an idempotency key?", author: "agent" });
    expect(sent).toMatchObject({ seq: 1, status: "sent" });
    await until(() => bodies(b).length === 1, 5000, "B got it");
    await until(() => a.events.delivered.includes(sent.id), 5000, "A got the ack");
    expect(b.state().peer_max_seq).toBe(1);
    expect(a.outbox()).toMatchObject([{ status: "delivered", envelope: { id: sent.id } }]);
    expect(b.inbox().find((e) => e.source === "peer")).toMatchObject({ from: "Tazo", harness: "claude-code" });
  });

  it("queues messages before any session exists and sends them once the peer joins", async () => {
    const { port } = await startRelay();
    const secret = newSecret();
    const a = makeClient("Tazo", port, secret);
    a.conn.start();
    await until(() => a.conn.status().socket === "joined");
    expect(a.conn.send({ kind: "chat", body: "first", author: "agent" }).status).toBe("queued");
    expect(a.conn.send({ kind: "chat", body: "second", author: "agent" }).status).toBe("queued");
    const b = makeClient("Nika", port, secret);
    b.conn.start();
    await until(() => bodies(b).length === 2, 5000, "both delivered");
    expect(bodies(b)).toEqual(["first", "second"]);
    await until(() => a.outbox().every((e) => e.status === "delivered"));
  });

  it("REQ-MSG-5 sends under the current session while the peer is offline; the relay buffers until it returns", async () => {
    const { a, b } = await pair();
    b.conn.stop();
    await until(() => !a.conn.status().peerConnected, 5000, "A sees B gone");
    a.conn.send({ kind: "chat", body: "while you were out", author: "agent" });
    await until(() => a.frames.sent.some((f) => f.type === MSG_TYPE), 5000, "frame written");
    const b2 = b.restart();
    b2.conn.start();
    await until(() => bodies(b2).includes("while you were out"), 5000, "buffered frame delivered");
    await until(() => a.outbox().every((e) => e.status === "delivered"));
  });

  it("resends a lost frame after the resend interval with the same id and seq", async () => {
    let dropped = 0;
    const dropFirstMsg = (inner: Parameters<NonNullable<Parameters<typeof makeClient>[3]>["wrap"] & object>[0]) =>
      ((url, handlers) => {
        const s = inner(url, handlers);
        return { ...s, sendBinary: (d: Uint8Array) => (d[0] === MSG_TYPE && dropped++ === 0 ? undefined : s.sendBinary(d)) };
      }) as typeof inner;
    const { a, b } = await pair({ a: { wrap: dropFirstMsg } });
    const sent = a.conn.send({ kind: "chat", body: "lost once", author: "agent" });
    await until(() => bodies(b).includes("lost once"), 5000, "resent");
    expect(dropped).toBeGreaterThan(1);
    expect(b.inbox().find((e) => e.source === "peer")?.id).toBe(sent.id);
    await until(() => a.events.delivered.includes(sent.id));
  });

  it("delivers duplicated frames once and still acks them", async () => {
    const dup = (inner: Parameters<NonNullable<Parameters<typeof makeClient>[3]>["wrap"] & object>[0]) =>
      ((url, handlers) => {
        const s = inner(url, handlers);
        return {
          ...s,
          sendBinary: (d: Uint8Array) => {
            s.sendBinary(d);
            if (d[0] === MSG_TYPE) s.sendBinary(d);
          },
        };
      }) as typeof inner;
    const { a, b } = await pair({ a: { wrap: dup } });
    a.conn.send({ kind: "chat", body: "one", author: "agent" });
    a.conn.send({ kind: "chat", body: "two", author: "agent" });
    await until(() => a.outbox().every((e) => e.status === "delivered") && a.outbox().length === 2, 5000, "acked");
    await sleep(100);
    expect(bodies(b)).toEqual(["one", "two"]);
    expect(b.state().peer_max_seq).toBe(2);
  });

  it("never reuses a seq after a crash: my_seq is persisted before the frame is written", async () => {
    const { a, b } = await pair();
    const first = a.conn.send({ kind: "chat", body: "before crash", author: "agent" });
    a.conn.stop(); // as if the process died right after send()
    const a2 = a.restart();
    a2.conn.start();
    const second = a2.conn.send({ kind: "chat", body: "after restart", author: "agent" });
    expect(second.seq).toBe(first.seq + 1);
    await until(() => bodies(b).length === 2, 5000, "both arrive");
    expect(bodies(b)).toEqual(["before crash", "after restart"]);
  });

  it("acks are batched, never acked themselves, and never reach the inbox", async () => {
    const { a, b } = await pair();
    for (let i = 1; i <= 3; i++) a.conn.send({ kind: "chat", body: `m${i}`, author: "agent" });
    await until(() => a.outbox().filter((e) => e.status === "delivered").length === 3, 5000, "acked");
    await sleep(200);
    const bMsgs = b.frames.sent.filter((f) => f.type === MSG_TYPE).length;
    expect(bMsgs).toBeLessThanOrEqual(2); // one batched ack, maybe two
    expect(a.frames.sent.filter((f) => f.type === MSG_TYPE)).toHaveLength(3); // A never acked B's acks
    expect(a.inbox().filter((e) => e.source === "peer")).toHaveLength(0);
  });

  it("paces binary frames: never more than the window allows, resends included", async () => {
    const tuning = { framesPerWindow: 3, windowMs: 300 };
    const { a, b } = await pair({ a: { tuning } });
    for (let i = 1; i <= 7; i++) a.conn.send({ kind: "chat", body: `m${i}`, author: "agent" });
    await until(() => bodies(b).length === 7, 10_000, "all delivered");
    const times = a.frames.sent.map((f) => f.at);
    for (const t of times) expect(times.filter((u) => u >= t && u < t + tuning.windowMs).length).toBeLessThanOrEqual(3);
  });
});

describe("connection: ending a room", () => {
  it("REQ-ROOM-5 leave sends bye, ends the room for both, and deletes the secrets", async () => {
    const { a, b } = await pair();
    await a.conn.leave("thanks, done for today");
    expect(a.state()).toMatchObject({ status: "left", token: null, sessions: { current: null, previous: null } });
    expect(readSecret(a.home, a.keys.roomId)).toBeNull();
    await until(() => b.events.ended.length > 0, 5000, "B ended");
    expect(b.events.ended).toEqual(["peer_left"]);
    expect(b.state()).toMatchObject({ status: "ended", token: null });
    const bye = b.inbox().find((e) => e.source === "peer");
    expect(bye).toMatchObject({ envelope: { kind: "bye", body: "thanks, done for today" } });
    expect(b.inbox().find((e) => e.source === "local" && e.event === "peer_left")).toMatchObject({ text: "Tazo ended the room." });
  });

  it("removes the room locally when the relay refuses the token with 4002", async () => {
    const { a } = await pair();
    a.conn.stop();
    updateState(a.home, a.keys.roomId, (s) => ({ ...s, token: "A".repeat(43) }));
    const a2 = a.restart();
    a2.conn.start();
    await until(() => a2.events.ended.length > 0, 5000, "4002");
    expect(a2.events.ended).toEqual(["gone"]);
    expect(a2.state().status).toBe("ended");
    expect(a2.inbox().some((e) => e.source === "local" && e.text === "The room expired.")).toBe(true);
  });

  it("removes the room locally at the relay-reported expires_at", async () => {
    const { port } = await startRelay(shiftedClock(MAX_AGE - 700));
    const secret = newSecret();
    const a = makeClient("Tazo", port, secret);
    a.conn.start();
    await until(() => a.state().expires_at !== null, 5000, "joined");
    await until(() => a.events.ended.length > 0, 5000, "expired");
    expect(a.events.ended).toEqual(["expired"]);
    expect(a.state().status).toBe("ended");
  });

  it("refuses a third client with 4001 and removes its room", async () => {
    const { port, secret } = await pair();
    const c = makeClient("Third", port, secret);
    c.conn.start();
    await until(() => c.events.ended.length > 0, 5000, "4001");
    expect(c.events.ended).toEqual(["room_full"]);
    expect(c.state()).toMatchObject({ status: "ended", error: "room_full" });
  });
});

describe("connection: reconnects and halts", () => {
  it("reconnects with backoff after the network drops and keeps delivering", async () => {
    let sockets = 0;
    let kill: (() => void) | null = null;
    const killable = (inner: Parameters<NonNullable<Parameters<typeof makeClient>[3]>["wrap"] & object>[0]) =>
      ((url, handlers) => {
        sockets++;
        const s = inner(url, handlers);
        kill = () => s.close(4999);
        return s;
      }) as typeof inner;
    const { a, b } = await pair({ a: { wrap: killable } });
    kill!();
    await until(() => sockets >= 2 && a.conn.status().session && a.state().sessions.previous !== null, 5000, "reconnected");
    a.conn.send({ kind: "chat", body: "after reconnect", author: "agent" });
    await until(() => bodies(b).includes("after reconnect"));
  });

  it("does not reconnect a socket replaced by another connection (4007)", async () => {
    const { a, b } = await pair();
    // A raw second connection with A's token takes over the slot.
    const port = Number(new URL(`ws://${a.state().relay}`).port);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/rooms/${a.keys.roomId}`);
    await new Promise((r) => ws.on("open", r));
    ws.send(JSON.stringify({ t: "join", v: 1, token: a.state().token }));
    await until(() => a.conn.status().halted === "replaced", 5000, "4007");
    await sleep(300);
    expect(a.conn.status().socket).toBe("offline");
    expect(b.conn.status().socket).toBe("joined");
    ws.close();
  });

  it("disconnects after five HELLOs with the wrong key, warns, and stays offline until resumed", async () => {
    const { port } = await startRelay();
    const secret = newSecret();
    const a = makeClient("Tazo", port, secret);
    a.conn.start();
    await until(() => a.conn.status().socket === "joined");
    // An intruder with the wrong secret keeps reconnecting, sending a HELLO each time.
    let intruder = makeClient("Mallory", port, secret, { keys: wrongKeys(secret) });
    intruder.conn.start();
    for (let i = 0; i < 6 && a.conn.status().halted === null; i++) {
      const current = intruder;
      await until(() => current.frames.sent.some((f) => f.type === HELLO_TYPE) || a.conn.status().halted !== null, 5000, "intruder HELLO");
      await sleep(50);
      intruder = current.restart();
      intruder.conn.start();
    }
    await until(() => a.conn.status().halted === "wrong_key", 5000, "wrong key halt");
    intruder.conn.stop();
    expect(a.state().error).toBe("wrong_key");
    expect(notices(a)).toContain("wrong_key");
    await sleep(300);
    expect(a.conn.status().socket).toBe("offline");
    a.conn.resume();
    await until(() => a.conn.status().socket === "joined", 5000, "resumed");
    expect(a.state().error).toBeNull();
  }, 20_000);
});
