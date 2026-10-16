// Structured kinds on the wire (02 §6.3.5, §6.3.6): the collab1 gate, the chat fallback,
// downgrades and upgrades between sessions, and unreadable structured envelopes.
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { hexToBytes, randomBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { COLLAB_CAP, fallbackBody, msgAad, MSG_TYPE, type CollabEnvelope } from "@pairwire/core";
import { describe, expect, it } from "vitest";
import type { SendInput, SocketFactory } from "../../src/connection.js";
import { readSessionCaps, updateState } from "../../src/state.js";
import { makeClient, newSecret, startRelay, until, type Client, type ClientOptions } from "./harness.js";

const NEW = ["ack", "say", COLLAB_CAP];
const OLD = ["ack", "say"];

async function pair(a: ClientOptions, b: ClientOptions) {
  const { port } = await startRelay();
  const secret = newSecret();
  const ca = makeClient("Tazo", port, secret, a);
  const cb = makeClient("Nika", port, secret, b);
  ca.conn.start();
  await until(() => ca.conn.status().socket === "joined", 5000, "A joined");
  cb.conn.start();
  await until(() => ca.conn.status().session && cb.conn.status().session, 5000, "handshake");
  return { port, secret, a: ca, b: cb };
}

/** A claim as the session would hand it to the connection, fallback body included. */
function claim(paths: string[], body = "Refactoring; please hold off."): Extract<SendInput, { fallbackBody: string }> {
  const data = { paths, ttl_min: 120 };
  const env = { v: 1, id: "0".repeat(26), seq: 1, ts: new Date().toISOString(), author: "agent", kind: "claim", reply_to: null, body, acks: null, data } as CollabEnvelope;
  return { kind: "claim", data, body, reply_to: null, author: "agent", fallbackBody: fallbackBody(env) };
}

const peerEntries = (c: Client) => c.inbox().flatMap((e) => (e.source === "peer" ? [e] : []));

/** Drops our MSG frames while `drop.on` is set, as a lost connection would. */
function dropper() {
  const drop = { on: false };
  const wrap = (inner: SocketFactory): SocketFactory => (url, handlers) => {
    const s = inner(url, handlers);
    return { ...s, sendBinary: (d) => (drop.on && d[0] === MSG_TYPE ? undefined : s.sendBinary(d)) };
  };
  return { drop, wrap };
}

describe("structured kinds on the wire (02 §6.3.6)", { timeout: 30_000 }, () => {
  it("REQ-COLLAB-4 sends a structured kind as-is to a peer that advertises collab1, and records the peer's caps per session", async () => {
    const { a, b } = await pair({ caps: NEW }, { caps: NEW });
    expect(a.conn.peerHasCollab()).toBe(true);
    expect(Object.values(readSessionCaps(a.home, a.keys.roomId))).toEqual([NEW]);
    const sent = a.conn.send(claim(["src/orders/**"]));
    expect(sent.encoding).toBe("structured");
    await until(() => peerEntries(b).length > 0, 5000, "B has the claim");
    expect(peerEntries(b)[0]!.envelope).toMatchObject({ id: sent.id, kind: "claim", data: { paths: ["src/orders/**"], ttl_min: 120 } });
  });

  it("REQ-COLLAB-4 sends it as a chat with its header, same id and seq, to a peer without collab1; it is acked and later messages flow", async () => {
    const { a, b } = await pair({ caps: NEW }, { caps: OLD });
    expect(a.conn.peerHasCollab()).toBe(false);
    const sent = a.conn.send(claim(["src/orders/**", "src/api/orders.ts"]));
    expect(sent.encoding).toBe("chat");
    a.conn.send({ kind: "chat", body: "and a plain one", author: "agent" });
    await until(() => peerEntries(b).length === 2, 5000, "B has both");
    const [first, second] = peerEntries(b);
    expect(first!.envelope).toMatchObject({ id: sent.id, seq: sent.seq, kind: "chat", author: "agent" });
    expect(first!.envelope.body).toMatch(/^\[pairwire claim · paths: src\/orders\/\*\*, src\/api\/orders\.ts · for 120 min, until \d{4}-\d\d-\d\dT\d\d:\d\dZ\]\n\nRefactoring; please hold off\.$/);
    expect("data" in first!.envelope).toBe(false);
    expect(second!.envelope.body).toBe("and a plain one");
    await until(() => a.outbox().every((e) => e.status === "delivered"), 5000, "both acked");
    // The outbox keeps the structured form; the fallback is stored next to it.
    expect(a.outbox()[0]).toMatchObject({ envelope: { kind: "claim" }, fallback_body: first!.envelope.body });
  });

  it("REQ-COLLAB-4 resends unacked structured envelopes as chat after a downgrade, and structured after an upgrade", async () => {
    const { drop, wrap } = dropper();
    const pairing = await pair({ caps: NEW, wrap }, { caps: NEW });
    const a = pairing.a;
    let b = pairing.b;

    b.conn.stop();
    await until(() => !a.conn.status().peerConnected, 5000, "B gone");
    drop.on = true;
    const first = a.conn.send(claim(["src/a.ts"]));
    expect(first.encoding).toBe("structured"); // the session it went out under had collab1
    drop.on = false;
    b = b.restart({ caps: OLD });
    b.conn.start();
    await until(() => peerEntries(b).some((e) => e.id === first.id), 5000, "resent after the downgrade");
    expect(peerEntries(b).find((e) => e.id === first.id)!.envelope).toMatchObject({ kind: "chat", seq: first.seq });

    b.conn.stop();
    await until(() => !a.conn.status().peerConnected, 5000, "B gone again");
    drop.on = true;
    const second = a.conn.send(claim(["src/b.ts"]));
    expect(second.encoding).toBe("chat");
    drop.on = false;
    b = b.restart({ caps: NEW });
    b.conn.start();
    await until(() => peerEntries(b).some((e) => e.id === second.id), 5000, "resent after the upgrade");
    expect(peerEntries(b).find((e) => e.id === second.id)!.envelope).toMatchObject({ kind: "claim", seq: second.seq });
    await until(() => a.outbox().every((e) => e.status === "delivered"), 5000, "acked");
  });
});

describe("unreadable structured envelopes (02 §6.3.5, ADR-025)", { timeout: 30_000 }, () => {
  it("REQ-COLLAB-5 skips and acks bad data, data on an old kind, a human-authored claim and an extra field; one notice; later messages arrive", async () => {
    let raw: ((d: Uint8Array) => void) | null = null;
    const capture = (inner: SocketFactory): SocketFactory => (url, handlers) => {
      const s = inner(url, handlers);
      raw = (d) => s.sendBinary(d);
      return s;
    };
    const { a, b } = await pair({ caps: NEW }, { caps: NEW, wrap: capture });
    const st = b.state();
    const sid = hexToBytes(st.sessions.current!.sid);
    const key = hexToBytes(st.sessions.current!.send_key);
    const base = (seq: number) => ({ v: 1, id: `01JPW00000000000000000BAD${seq}`, seq, ts: new Date().toISOString(), author: "agent", reply_to: null, acks: null });
    const bad = [
      { ...base(st.my_seq + 1), kind: "claim", body: "secret plans", data: { paths: ["src/a.ts"], ttl_min: 99_999 } },
      { ...base(st.my_seq + 2), kind: "chat", body: "hidden", data: null },
      { ...base(st.my_seq + 3), kind: "claim", author: "human", body: "as the human", data: { paths: ["src/a.ts"], ttl_min: 60 } },
      { ...base(st.my_seq + 4), kind: "heads_up", body: "extra", data: { paths: [] }, lock: true },
    ];
    for (const env of bad) {
      const nonce = randomBytes(24);
      const ct = xchacha20poly1305(key, nonce, msgAad(b.keys.roomIdBytes, sid)).encrypt(utf8ToBytes(JSON.stringify(env)));
      raw!(Uint8Array.from([MSG_TYPE, ...sid, ...nonce, ...ct]));
    }
    updateState(b.home, b.keys.roomId, (s) => ({ ...s, my_seq: st.my_seq + bad.length }));
    b.conn.send({ kind: "chat", body: "after the bad ones", author: "agent" });
    await until(() => peerEntries(a).some((e) => e.envelope.body === "after the bad ones"), 5000, "later message delivered");
    expect(a.state().peer_max_seq).toBe(st.my_seq + bad.length + 1);
    expect(peerEntries(a)).toHaveLength(1);
    expect(JSON.stringify(a.inbox())).not.toMatch(/secret plans|hidden|as the human|BAD/);
    expect(a.inbox().filter((e) => e.source === "local" && e.event === "peer_unreadable")).toHaveLength(1);
    await until(() => b.outbox().every((e) => e.status === "delivered"), 5000, "acked");
  });
});
