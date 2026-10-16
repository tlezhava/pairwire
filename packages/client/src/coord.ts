// Structured kinds on the client (04 §3 Coordination state, §4, §5): the coordination view
// over this room's files, the attributes the renderer adds, contract file reads, and the
// read-only `status` and footer additions. Nothing here writes in the project or reads a
// path the peer named.
import { realpathSync, readFileSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
  contractPathProblem,
  coordView,
  isCollabKind,
  pathsOverlap,
  sanitizeAttr,
  scanSecrets,
  type CoordAttrs,
  type CoordMessage,
  type CoordView,
  type ProposalRecord,
  type RenderItem,
} from "@pairwire/core";
import { errorCode } from "./fs-util.js";
import { isHeld, readCoordSent, readInbox, readLedger, toRenderItem, type CoordSent, type DeliveryLedger, type InboxEntry } from "./room-files.js";
import { expiresAt, isOpen, readState } from "./state.js";

export interface ViewOptions {
  /** Hold mode as the caller sees it: held messages are left out. */
  hold: boolean;
  now: number;
  /** delivered.json when the caller already holds its lock. */
  ledger?: DeliveryLedger;
  /** Ids being shown right now (released or delivered in this step): visible even if still held. */
  showing?: Iterable<string>;
}

export interface LoadedView {
  view: CoordView;
  /** Our coord-sent.jsonl lines. */
  sent: CoordSent[];
  ledger: DeliveryLedger;
}

/**
 * coordView() over the peer's visible structured messages and our own (04 §3): held and
 * dropped messages don't exist for it.
 */
export function loadView(home: string, roomId: string, o: ViewOptions): LoadedView {
  const ledger = o.ledger ?? readLedger(home, roomId);
  const showing = new Set(o.showing ?? []);
  const state = readState(home, roomId);
  const messages: CoordMessage[] = [];
  for (const e of readInbox(home, roomId)) {
    if (e.source !== "peer" || !isCollabKind(e.envelope.kind)) continue;
    const hidden = ledger.dropped.has(e.id) || isHeld(e, ledger, o.hold);
    if (hidden && !showing.has(e.id)) continue;
    messages.push({ side: "peer", envelope: e.envelope, at: e.received_at });
  }
  const sent = readCoordSent(home, roomId);
  for (const c of sent) messages.push({ side: "ours", envelope: c.envelope, at: c.sent_at });
  const view = coordView({ messages, roomOpen: !!state && isOpen(state), roomExpiresAt: state ? expiresAt(state) : 0, now: o.now });
  return { view, sent, ledger };
}

/** The attributes coordView() gives a peer message, plus the ids of our claims its paths overlap. */
export function coordAttrs(e: InboxEntry, view: CoordView): CoordAttrs | undefined {
  if (e.source !== "peer" || !isCollabKind(e.envelope.kind)) return undefined;
  const env = e.envelope;
  const paths = env.kind === "claim" || env.kind === "heads_up" ? env.data.paths : [];
  const overlaps = view.claims.ours.filter((c) => c.paths.some((p) => paths.some((q) => pathsOverlap(p, q)))).map((c) => c.id);
  return { ...view.info("peer", e.id), ...(overlaps.length > 0 ? { overlapsYours: overlaps } : {}) };
}

/** Render items for `entries`, with the view computed as if they were all visible. */
export function renderItemsFor(home: string, roomId: string, entries: readonly InboxEntry[], o: ViewOptions): RenderItem[] {
  if (!entries.some((e) => e.source === "peer" && isCollabKind(e.envelope.kind))) return entries.map((e) => toRenderItem(e));
  const { view } = loadView(home, roomId, { ...o, showing: [...(o.showing ?? []), ...entries.map((e) => e.id)] });
  return entries.map((e) => toRenderItem(e, coordAttrs(e, view)));
}

// --- contract files (04 §3, Local file reads) -------------------------------------------

export const MAX_CONTRACT_FILE_BYTES = 1024 * 1024;
const SENSITIVE = [/\.pem$/i, /\.key$/i, /^id_rsa/i, /^id_ed25519/i, /\.p12$/i, /\.pfx$/i, /^credentials/i, /^secrets/i];

export type ContractFileRule = "bad_path" | "missing" | "outside_project" | "dot_path" | "sensitive_name" | "not_a_file" | "too_large" | "not_utf8" | "secret";

export class ContractFileError extends Error {
  override readonly name = "ContractFileError";
  constructor(
    readonly rule: ContractFileRule,
    message: string,
  ) {
    super(message);
  }
}

export interface ContractFile {
  text: string;
  sha256: string;
}

/**
 * The only way pairwire reads a contract file: a ContractPath the local agent named, whose
 * realpath stays inside the project, a regular file of at most 1 MiB with no sensitive name,
 * valid UTF-8 that passes the secret scanner (INV-5). Errors name the rule, never the content.
 */
export function readContractFile(projectDir: string, relPath: string): ContractFile {
  const fail = (rule: ContractFileRule, why: string): never => {
    throw new ContractFileError(rule, `${relPath}: ${why}`);
  };
  const problem = contractPathProblem(relPath);
  if (problem) fail("bad_path", `the path ${problem}`);
  const root = realpathSync(projectDir);
  let real = "";
  try {
    real = realpathSync(join(root, relPath));
  } catch (e) {
    fail(errorCode(e) === "ENOENT" ? "missing" : "not_a_file", errorCode(e) === "ENOENT" ? "no such file in this project" : "can't be resolved");
  }
  const rel = relative(root, real);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) fail("outside_project", "resolves to a file outside this project");
  if (contractPathProblem(rel.split(sep).join("/"))) fail("dot_path", "resolves to a dot-file, a dot-directory or an unusable path");
  if ([basename(relPath), basename(real)].some((n) => SENSITIVE.some((re) => re.test(n)))) fail("sensitive_name", "has a name that usually holds keys or credentials");
  const st = statSync(real);
  if (!st.isFile()) fail("not_a_file", "is not a regular file");
  if (st.size > MAX_CONTRACT_FILE_BYTES) fail("too_large", "is larger than 1 MiB");
  const bytes = readFileSync(real);
  if (bytes.length > MAX_CONTRACT_FILE_BYTES) fail("too_large", "is larger than 1 MiB");
  let text = "";
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    fail("not_utf8", "is not UTF-8 text");
  }
  const found = scanSecrets(text);
  if (found.length > 0) fail("secret", `looks like it contains a secret (${found.map((f) => `${f.rule} at character ${f.offset}`).join(", ")})`);
  return { text, sha256: bytesToHex(sha256(bytes)) };
}

/** "in sync", "changed locally", "missing" or "unreadable (<rule>)" for our own copy of a contract. */
function fileState(projectDir: string, path: string, sha: string): string {
  try {
    return readContractFile(projectDir, path).sha256 === sha ? "in sync" : "changed locally";
  } catch (e) {
    if (e instanceof ContractFileError) return e.rule === "missing" ? "missing" : `unreadable (${e.rule})`;
    return "unreadable";
  }
}

// --- status and footer (04 §4, Structured kinds) ----------------------------------------

const hhmm = (ms: number) => new Date(ms).toISOString().slice(11, 16) + "Z";
const attr = (s: string) => sanitizeAttr(s);

/** The `Claims` and `Contracts` sections of `status`; empty when there is nothing to show. */
export function coordStatusLines(loaded: LoadedView, o: { peer: string; projectDir: string }): string[] {
  const { view, sent } = loaded;
  if (view.claims.peer.length === 0 && view.claims.ours.length === 0 && view.contracts.length === 0) return [];
  const claimLine = (c: { paths: string[]; id: string; expiresAt: number }) => `${c.paths.map(attr).join(", ")} · claim ${c.id} · until ${hhmm(c.expiresAt)}`;
  const lines = ["Claims (advisory; pairwire locks nothing):"];
  if (view.claims.peer.length === 0) lines.push(`  ${o.peer}'s agent: none`);
  for (const c of view.claims.peer) lines.push(`  ${o.peer}'s agent (external input): ${claimLine(c)}`);
  if (view.claims.ours.length === 0) lines.push("  yours: none");
  for (const c of view.claims.ours) lines.push(`  yours: ${claimLine(c)}`);
  if (view.contracts.length > 0) lines.push("Contracts:");
  for (const p of view.contracts) lines.push(`  ${contractLine(p, sent, o)}`);
  return lines;
}

function contractLine(p: ProposalRecord, sent: readonly CoordSent[], o: { peer: string; projectDir: string }): string {
  const ours = p.side === "ours";
  const parts = [`${attr(p.name)} v${p.version}`, `sha256 ${p.sha256.slice(0, 8)}…`, ours ? `proposed by you ${p.id}` : `proposed by ${o.peer} ${p.id} (external input)`];
  if (p.answer) {
    const who = p.answer.side === "ours" ? "you" : o.peer;
    parts.push(`${p.answer.decision === "accept" ? "accepted" : "rejected"} by ${who} ${hhmm(p.answer.at)}`);
  } else {
    parts.push(ours ? `awaiting ${o.peer}'s answer` : "awaiting your answer");
  }
  // Only a path the local agent named: our proposal's file, or the copy named when accepting.
  const localPath = ours ? p.path : sent.find((s) => s.envelope.id === p.answer?.id && s.local_path)?.local_path;
  if (localPath) parts.push(`your file: ${fileState(o.projectDir, localPath, p.sha256)}`);
  return parts.join(" · ");
}

/** The footer's ` · 1 peer claim · 1 contract awaiting your answer`, counts only (04 §4). */
export function coordFooter(view: CoordView): string {
  const claims = view.claims.peer.length;
  const awaiting = view.contracts.filter((p) => p.side === "peer" && p.state === "pending").length;
  let out = "";
  if (claims > 0) out += ` · ${claims} peer claim${claims === 1 ? "" : "s"}`;
  if (awaiting > 0) out += ` · ${awaiting} contract${awaiting === 1 ? "" : "s"} awaiting your answer`;
  return out;
}
