// The coordination view of structured kinds (02 §6.3.4, 04 §3 Coordination state) and the
// chat fallback that carries them to older peers (02 §6.3.6). Pure: no I/O, no clock.
import type { BasicEnvelope, CollabEnvelope, Envelope } from "./envelope.js";
import { isCollabKind } from "./envelope.js";

/** Active claims that count per side, and contract names the view keeps (02 §6.3.4). */
export const MAX_ACTIVE_CLAIMS = 16;
export const MAX_CONTRACT_NAMES = 50;

const MINUTE = 60_000;

export type Side = "peer" | "ours";
export type Match =
  | "yes"
  | "over_limit"
  | "unknown_claim"
  | "not_their_claim"
  | "already_released"
  | "stale_version"
  | "unknown_proposal"
  | "not_your_proposal"
  | "hash_mismatch"
  | "already_answered"
  | "superseded";
export type ProposalStatus = "pending" | "accepted" | "rejected" | "superseded";

export interface CoordMessage {
  side: Side;
  envelope: Envelope;
  /** Local time: our `received_at` for the peer's messages, our `sent_at` for ours. Never `ts`. */
  at: number;
}

export interface CoordInput {
  /** Visible messages of both sides; the caller leaves out held and dropped ones. */
  messages: readonly CoordMessage[];
  roomOpen: boolean;
  roomExpiresAt: number;
  now: number;
}

export interface ClaimRecord {
  side: Side;
  id: string;
  paths: string[];
  at: number;
  expiresAt: number;
  counted: boolean;
  releasedAt: number | null;
}

export interface ProposalRecord {
  side: Side;
  id: string;
  name: string;
  version: number;
  path: string;
  sha256: string;
  rev: string | null;
  inline: boolean;
  at: number;
  counted: boolean;
  state: "pending" | "accepted" | "rejected";
  answer: { side: Side; id: string; at: number; decision: "accept" | "reject" } | null;
}

/** What the client adds to a structured message when it renders it (04 §5). */
export interface MessageInfo {
  match: Match;
  expiresAt?: number;
  status?: ProposalStatus;
  /** release: the paths of the claim it names (same side only). */
  refPaths?: string[];
  /** contract_response: the path of the proposal it answers (other side only). */
  refPath?: string;
}

export interface CoordView {
  /** Claims active now, oldest first. */
  claims: Record<Side, ClaimRecord[]>;
  /** The live proposal of each contract name, by name. */
  contracts: ProposalRecord[];
  info(side: Side, id: string): MessageInfo | undefined;
  claim(side: Side, id: string): ClaimRecord | undefined;
  proposal(side: Side, id: string): ProposalRecord | undefined;
  /** The highest version proposed for `name` by either side, 0 if none. */
  maxVersion(name: string): number;
}

const other = (side: Side): Side => (side === "peer" ? "ours" : "peer");
const key = (side: Side, id: string) => `${side}:${id}`;

/**
 * Derives claims, contracts and every structured message's `match` from the messages alone,
 * in local time order (ties: side, then id). Only a `match` of `yes` changes the view; a
 * release ends only its own side's claim, a response answers only the other side's proposal.
 */
export function coordView(input: CoordInput): CoordView {
  const infos = new Map<string, MessageInfo>();
  const claims = new Map<string, ClaimRecord>();
  const proposals = new Map<string, ProposalRecord>();
  const live = new Map<string, ProposalRecord>();
  const maxVersion = new Map<string, number>();

  const collab = input.messages
    .filter((m): m is CoordMessage & { envelope: CollabEnvelope } => isCollabKind(m.envelope.kind))
    .sort((a, b) => a.at - b.at || a.side.localeCompare(b.side) || a.envelope.id.localeCompare(b.envelope.id));

  const activeAt = (side: Side, t: number) =>
    [...claims.values()].filter((c) => c.side === side && c.counted && c.releasedAt === null && c.expiresAt > t);

  for (const { side, envelope: env, at } of collab) {
    const k = key(side, env.id);
    if (infos.has(k)) continue; // a repeated id on one side: the first one stands
    switch (env.kind) {
      case "heads_up":
        break;
      case "claim": {
        const counted = activeAt(side, at).length < MAX_ACTIVE_CLAIMS;
        const expiresAt = Math.min(at + env.data.ttl_min * MINUTE, input.roomExpiresAt);
        claims.set(k, { side, id: env.id, paths: env.data.paths, at, expiresAt, counted, releasedAt: null });
        infos.set(k, counted ? { match: "yes", expiresAt } : { match: "over_limit" });
        break;
      }
      case "release": {
        const target = env.reply_to!;
        const c = claims.get(key(side, target));
        if (!c || !c.counted) {
          infos.set(k, { match: claims.has(key(other(side), target)) ? "not_their_claim" : "unknown_claim" });
        } else if (c.releasedAt !== null || c.expiresAt <= at) {
          infos.set(k, { match: "already_released", refPaths: c.paths });
        } else {
          c.releasedAt = at;
          infos.set(k, { match: "yes", refPaths: c.paths });
        }
        break;
      }
      case "contract_propose": {
        const d = env.data;
        const current = live.get(d.name);
        const record: ProposalRecord = {
          side,
          id: env.id,
          name: d.name,
          version: d.version,
          path: d.path,
          sha256: d.sha256,
          rev: d.rev,
          inline: d.content !== null,
          at,
          counted: false,
          state: "pending",
          answer: null,
        };
        proposals.set(k, record);
        if (current && (current.version > d.version || (current.version === d.version && current.id >= env.id))) {
          infos.set(k, { match: "stale_version" });
        } else if (!current && live.size >= MAX_CONTRACT_NAMES) {
          infos.set(k, { match: "over_limit" });
          break;
        } else {
          record.counted = true;
          live.set(d.name, record);
          infos.set(k, { match: "yes" });
        }
        maxVersion.set(d.name, Math.max(maxVersion.get(d.name) ?? 0, d.version));
        break;
      }
      case "contract_response": {
        const target = env.reply_to!;
        const p = proposals.get(key(other(side), target));
        const d = env.data;
        if (!p) {
          infos.set(k, { match: proposals.has(key(side, target)) ? "not_your_proposal" : "unknown_proposal" });
          break;
        }
        const refPath = p.path;
        if (p.name !== d.name || p.version !== d.version || p.sha256 !== d.sha256) infos.set(k, { match: "hash_mismatch", refPath });
        else if (!p.counted || live.get(p.name) !== p) infos.set(k, { match: "superseded", refPath });
        else if (p.state !== "pending") infos.set(k, { match: "already_answered", refPath });
        else {
          p.state = d.decision === "accept" ? "accepted" : "rejected";
          p.answer = { side, id: env.id, at, decision: d.decision };
          infos.set(k, { match: "yes", refPath });
        }
        break;
      }
    }
  }

  // A proposal that counted reports its state now.
  for (const p of proposals.values()) {
    const info = infos.get(key(p.side, p.id));
    if (info?.match === "yes") info.status = live.get(p.name) === p ? p.state : "superseded";
  }

  const activeNow = (side: Side) => (input.roomOpen ? activeAt(side, input.now) : []);
  return {
    claims: { peer: activeNow("peer"), ours: activeNow("ours") },
    contracts: [...live.values()].sort((a, b) => a.name.localeCompare(b.name)),
    info: (side, id) => infos.get(key(side, id)),
    claim: (side, id) => claims.get(key(side, id)),
    proposal: (side, id) => proposals.get(key(side, id)),
    maxVersion: (name) => maxVersion.get(name) ?? 0,
  };
}

// --- overlap (02 §6.3.4) ----------------------------------------------------------------

/** The segments of `path` before the first one with a glob token. */
export function literalSegments(path: string): string[] {
  const segments = path.split("/");
  const glob = segments.findIndex((s) => /[*?]/.test(s));
  return glob < 0 ? segments : segments.slice(0, glob);
}

/** Conservative: true when the literal segments of one path are a prefix of the other's. */
export function pathsOverlap(a: string, b: string): boolean {
  const la = literalSegments(a);
  const lb = literalSegments(b);
  const [short, long] = la.length <= lb.length ? [la, lb] : [lb, la];
  return short.every((s, i) => s === long[i]);
}

// --- fallback encoding (02 §6.3.6) ------------------------------------------------------

const minuteUtc = (ms: number) => new Date(ms).toISOString().slice(0, 16) + "Z";

/**
 * The chat body that carries a structured message to a peer without `collab1`: a header
 * line, a blank line, the body (or "(no message)"), and inline contract content last.
 * `claimUntil` is the sender's own expiry for a claim.
 */
export function fallbackBody(env: CollabEnvelope, opts: { claimUntil?: number } = {}): string {
  let header: string;
  let tail = "";
  switch (env.kind) {
    case "heads_up":
      header = env.data.paths.length > 0 ? `heads-up · paths: ${env.data.paths.join(", ")}` : "heads-up";
      break;
    case "claim": {
      const until = opts.claimUntil ?? Date.parse(env.ts) + env.data.ttl_min * MINUTE;
      header = `claim · paths: ${env.data.paths.join(", ")} · for ${env.data.ttl_min} min, until ${minuteUtc(until)}`;
      break;
    }
    case "release":
      header = `release of claim ${env.reply_to}`;
      break;
    case "contract_propose": {
      const d = env.data;
      header = `contract_propose · ${d.name} v${d.version} · ${d.path}${d.rev ? ` @ ${d.rev.slice(0, 7)}` : ""} · sha256 ${d.sha256}`;
      if (d.content !== null) tail = `\n\n--- contract content (sha256 ${d.sha256}) ---\n${d.content}`;
      break;
    }
    case "contract_response": {
      const d = env.data;
      header = `contract_response · ${d.decision} · ${d.name} v${d.version} · re ${env.reply_to} · sha256 ${d.sha256}`;
      break;
    }
  }
  const body = env.body === null || env.body === "" ? "(no message)" : env.body;
  return `[pairwire ${header}]\n\n${body}${tail}`;
}

/** The 0.1.0-shaped chat that goes on the wire instead of `env` (same id, seq, ts, author, reply_to). */
export function fallbackEnvelope(env: CollabEnvelope, body: string): BasicEnvelope {
  return { v: 1, id: env.id, seq: env.seq, ts: env.ts, author: env.author, kind: "chat", reply_to: env.reply_to, body, acks: null };
}
