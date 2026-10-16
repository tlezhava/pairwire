// The coordination view (02 §6.3.4, 04 §3 Coordination state): a pure function with a fake clock.
import { describe, expect, it } from "vitest";
import { coordView, MAX_ACTIVE_CLAIMS, MAX_CONTRACT_NAMES, type CoordMessage, type Side } from "../src/coord.js";
import type { Envelope } from "../src/envelope.js";

const MIN = 60_000;
const T0 = Date.parse("2026-10-16T12:00:00.000Z");
const FAR = T0 + 7 * 24 * 60 * MIN;
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

let n = 0;
/** Increasing ULIDs, so a later call has a higher id. */
const nextId = () => `01JD${String(n++).padStart(22, "0")}`;

function env(kind: Envelope["kind"], over: Record<string, unknown>): Envelope {
  return { v: 1, id: nextId(), seq: 1, ts: new Date(T0).toISOString(), author: "agent", kind, reply_to: null, body: "x", acks: null, ...over } as Envelope;
}

const claim = (paths: string[], ttl = 120, over: Record<string, unknown> = {}) => env("claim", { data: { paths, ttl_min: ttl }, ...over });
const release = (id: string) => env("release", { reply_to: id, body: null, data: {} });
const propose = (name: string, version: number, sha = SHA_A, over: Record<string, unknown> = {}) =>
  env("contract_propose", { data: { name, version, path: `contracts/${name}.yaml`, sha256: sha, rev: null, content: null }, ...over });
const respond = (p: Envelope, decision: "accept" | "reject" = "accept", over: Record<string, unknown> = {}) => {
  const d = (p as Extract<Envelope, { kind: "contract_propose" }>).data;
  return env("contract_response", { reply_to: p.id, data: { decision, name: d.name, version: d.version, sha256: d.sha256, ...over } });
};

const at = (side: Side, envelope: Envelope, minutes = 0): CoordMessage => ({ side, envelope, at: T0 + minutes * MIN });
const view = (messages: CoordMessage[], nowMin = 0, o: { roomOpen?: boolean; roomExpiresAt?: number } = {}) =>
  coordView({ messages, roomOpen: o.roomOpen ?? true, roomExpiresAt: o.roomExpiresAt ?? FAR, now: T0 + nowMin * MIN });

describe("coordView: claims (REQ-COLLAB-2)", () => {
  it("REQ-COLLAB-2 a claim expires at its local arrival time plus the TTL, whatever its ts says", () => {
    const c = claim(["src/orders/**"], 30, { ts: "2099-01-01T00:00:00.000Z" });
    const v = view([at("peer", c, 10)], 20);
    expect(v.claims.peer.map((x) => x.id)).toEqual([c.id]);
    expect(v.info("peer", c.id)).toEqual({ match: "yes", expiresAt: T0 + 40 * MIN });
    expect(view([at("peer", c, 10)], 40).claims.peer).toEqual([]);
  });

  it("REQ-COLLAB-2 caps the expiry at the room's expires_at and ends every claim when the room ends", () => {
    const c = claim(["src/a.ts"], 1440);
    expect(view([at("ours", c)], 0, { roomExpiresAt: T0 + 60 * MIN }).info("ours", c.id)?.expiresAt).toBe(T0 + 60 * MIN);
    expect(view([at("ours", c)], 1, { roomOpen: false }).claims.ours).toEqual([]);
  });

  it("REQ-COLLAB-6 a release ends only a claim of the same side", () => {
    const ours = claim(["src/a.ts"]);
    const theirs = claim(["src/b.ts"]);
    const peerReleasesOurs = release(ours.id);
    const peerReleasesTheirs = release(theirs.id);
    const v = view([at("ours", ours), at("peer", theirs, 1), at("peer", peerReleasesOurs, 2), at("peer", peerReleasesTheirs, 3)], 4);
    expect(v.info("peer", peerReleasesOurs.id)).toEqual({ match: "not_their_claim" });
    expect(v.info("peer", peerReleasesTheirs.id)).toEqual({ match: "yes", refPaths: ["src/b.ts"] });
    expect(v.claims.ours.map((c) => c.id)).toEqual([ours.id]);
    expect(v.claims.peer).toEqual([]);
  });

  it("names unknown, repeated and late releases", () => {
    const c = claim(["src/a.ts"], 10);
    const r1 = release(c.id);
    const r2 = release(c.id);
    const unknown = release(nextId());
    const v = view([at("peer", c), at("peer", r1, 1), at("peer", r2, 2), at("peer", unknown, 3)], 4);
    expect(v.info("peer", r1.id)?.match).toBe("yes");
    expect(v.info("peer", r2.id)).toEqual({ match: "already_released", refPaths: ["src/a.ts"] });
    expect(v.info("peer", unknown.id)).toEqual({ match: "unknown_claim" });
    const late = release(c.id);
    expect(view([at("peer", c), at("peer", late, 11)], 12).info("peer", late.id)?.match).toBe("already_released");
  });

  it("resolves ids per side: a peer claim reusing our claim's id is a different claim", () => {
    const ours = claim(["src/a.ts"]);
    const copy = { ...claim(["src/b.ts"]), id: ours.id } as Envelope;
    const v = view([at("ours", ours), at("peer", copy, 1)], 2);
    expect(v.claims.ours.map((c) => c.paths)).toEqual([["src/a.ts"]]);
    expect(v.claims.peer.map((c) => c.paths)).toEqual([["src/b.ts"]]);
  });

  it(`counts at most ${MAX_ACTIVE_CLAIMS} active claims per side; more are over_limit until one ends`, () => {
    const claims = Array.from({ length: MAX_ACTIVE_CLAIMS + 1 }, (_, i) => claim([`src/f${i}.ts`], 10));
    const msgs = claims.map((c) => at("peer", c));
    const v = view(msgs, 1);
    expect(v.claims.peer).toHaveLength(MAX_ACTIVE_CLAIMS);
    expect(v.info("peer", claims[MAX_ACTIVE_CLAIMS]!.id)).toEqual({ match: "over_limit" });
    expect(v.info("peer", claims[0]!.id)?.match).toBe("yes");
    // our side has its own budget
    expect(view([...msgs, at("ours", claim(["src/x.ts"]), 1)], 1).claims.ours).toHaveLength(1);
    // once the first ones expire, a new claim counts again
    const later = claim(["src/late.ts"]);
    expect(view([...msgs, at("peer", later, 11)], 11).info("peer", later.id)?.match).toBe("yes");
    // a release of an over_limit claim finds nothing that counted
    const r = release(claims[MAX_ACTIVE_CLAIMS]!.id);
    expect(view([...msgs, at("peer", r, 1)], 1).info("peer", r.id)?.match).toBe("unknown_claim");
  });

  it("ignores old kinds and processes messages in time order, not array order", () => {
    const c = claim(["src/a.ts"]);
    const r = release(c.id);
    const chat = env("chat", {});
    const v = view([at("peer", r, 2), at("peer", chat, 1), at("peer", c, 1)], 3);
    expect(v.info("peer", r.id)?.match).toBe("yes");
    expect(v.info("peer", chat.id)).toBeUndefined();
  });
});

describe("coordView: contracts (REQ-COLLAB-3)", () => {
  it("REQ-COLLAB-3 a proposal is pending until the other side's first matching response", () => {
    const p = propose("orders-api", 1);
    const yes = respond(p);
    const again = respond(p, "reject");
    const v = view([at("ours", p), at("peer", yes, 1), at("peer", again, 2)], 3);
    expect(v.info("peer", yes.id)).toEqual({ match: "yes", refPath: "contracts/orders-api.yaml" });
    expect(v.info("peer", again.id)).toEqual({ match: "already_answered", refPath: "contracts/orders-api.yaml" });
    expect(v.info("ours", p.id)).toEqual({ match: "yes", status: "accepted" });
    expect(v.contracts).toMatchObject([{ id: p.id, side: "ours", name: "orders-api", version: 1, state: "accepted", answer: { side: "peer", id: yes.id, decision: "accept" } }]);
  });

  it("REQ-COLLAB-3 records nothing for a response whose name, version or hash differ", () => {
    const p = propose("orders-api", 2);
    for (const over of [{ sha256: SHA_B }, { version: 3 }, { name: "events" }]) {
      const r = respond(p, "accept", over);
      const v = view([at("ours", p), at("peer", r, 1)], 2);
      expect(v.info("peer", r.id)?.match, JSON.stringify(over)).toBe("hash_mismatch");
      expect(v.contracts[0]?.state).toBe("pending");
    }
  });

  it("REQ-COLLAB-6 the peer can't answer its own proposal; unknown ids are named", () => {
    const theirs = propose("events", 1);
    const self = respond(theirs);
    const ghost = respond(propose("ghost", 1));
    const v = view([at("peer", theirs), at("peer", self, 1), at("peer", ghost, 2)], 3);
    expect(v.info("peer", self.id)).toEqual({ match: "not_your_proposal" });
    expect(v.info("peer", ghost.id)).toEqual({ match: "unknown_proposal" });
    expect(v.contracts[0]?.state).toBe("pending");
  });

  it("the highest version is live; a response to an older one is superseded; an older proposal is stale", () => {
    const v1 = propose("orders-api", 1);
    const v2 = propose("orders-api", 2, SHA_B);
    const late = respond(v1);
    const stale = propose("orders-api", 1);
    const v = view([at("ours", v1), at("ours", v2, 1), at("peer", late, 2), at("peer", stale, 3)], 4);
    expect(v.info("peer", late.id)?.match).toBe("superseded");
    expect(v.info("peer", stale.id)).toEqual({ match: "stale_version" });
    expect(v.info("ours", v1.id)).toEqual({ match: "yes", status: "superseded" });
    expect(v.contracts.map((c) => [c.id, c.state])).toEqual([[v2.id, "pending"]]);
    expect(v.maxVersion("orders-api")).toBe(2);
    expect(v.maxVersion("unknown")).toBe(0);
  });

  it("orders equal versions by id, so both sides compute the same live proposal", () => {
    const fromA = propose("orders-api", 3);
    const fromB = propose("orders-api", 3, SHA_B); // higher id
    const viewA = view([at("ours", fromA), at("peer", fromB, 1)], 2);
    const viewB = view([at("ours", fromB), at("peer", fromA, 1)], 2);
    expect(viewA.contracts[0]?.id).toBe(fromB.id);
    expect(viewB.contracts[0]?.id).toBe(fromB.id);
    expect(viewA.info("ours", fromA.id)?.status).toBe("superseded");
    expect(viewB.info("peer", fromA.id)).toEqual({ match: "stale_version" });
  });

  it(`keeps at most ${MAX_CONTRACT_NAMES} contract names`, () => {
    const props = Array.from({ length: MAX_CONTRACT_NAMES + 1 }, (_, i) => propose(`c${i}`, 1));
    const v = view(props.map((p) => at("peer", p)), 1);
    expect(v.contracts).toHaveLength(MAX_CONTRACT_NAMES);
    expect(v.info("peer", props[MAX_CONTRACT_NAMES]!.id)).toEqual({ match: "over_limit" });
    const next = propose("c0", 2);
    expect(view([...props.map((p) => at("peer", p)), at("peer", next, 1)], 2).info("peer", next.id)?.match).toBe("yes");
  });

  it("finds proposals and claims by side and id for send's checks", () => {
    const p = propose("events", 1);
    const c = claim(["src/a.ts"]);
    const v = view([at("peer", p), at("ours", c)], 1);
    expect(v.proposal("peer", p.id)?.name).toBe("events");
    expect(v.proposal("ours", p.id)).toBeUndefined();
    expect(v.claim("ours", c.id)?.paths).toEqual(["src/a.ts"]);
    expect(v.claim("peer", c.id)).toBeUndefined();
  });
});
