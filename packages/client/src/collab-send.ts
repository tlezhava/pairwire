// `send` for structured kinds (04 §4, Structured kinds in the tools): validates the agent's
// input per kind, checks it against the coordination view, reads and hashes the local
// contract file, and builds the envelope data and the chat fallback. It sends nothing; the
// session runs the size check, secret scan, hop budget and rate limit on the result.
import {
  CLAIM_TTL_MIN,
  contractNameSchema,
  envelopeSchema,
  fallbackBody,
  fallbackEnvelope,
  inlineContentProblem,
  MAX_CONTRACT_NAMES_PER_SIDE,
  MAX_CONTRACT_VERSION,
  MAX_PATHS,
  MAX_ACTIVE_CLAIMS,
  pathsOverlap,
  relPathProblem,
  revSchema,
  sanitizeAttr,
  serializeEnvelope,
  type CollabData,
  type CollabEnvelope,
  type CollabKind,
  type CoordView,
} from "@pairwire/core";
import { ContractFileError, readContractFile, type LoadedView } from "./coord.js";

export class CollabSendError extends Error {
  override readonly name = "CollabSendError";
}

export interface CollabInput {
  kind: CollabKind;
  body?: string | undefined;
  reply_to?: string | undefined;
  paths?: string[] | undefined;
  ttl_minutes?: number | undefined;
  contract_name?: string | undefined;
  contract_path?: string | undefined;
  contract_content?: string | undefined;
  rev?: string | undefined;
  decision?: "accept" | "reject" | undefined;
  local_path?: string | undefined;
}

export interface CollabPlan {
  kind: CollabKind;
  data: CollabData[CollabKind];
  body: string | null;
  reply_to: string | null;
  fallbackBody: string;
  /** Every text the secret scanner must pass, labeled for the error message (INV-5). */
  scan: [label: string, text: string][];
  /** Extra lines for the `send` result. */
  lines: string[];
  /** contract_response with accept: kept in coord-sent.jsonl, never sent. */
  localPath?: string;
}

export interface CollabContext {
  loaded: LoadedView;
  projectDir: string;
  peerName: string;
  now: number;
  roomExpiresAt: number;
  /** The seq the envelope will get; for the size check only. */
  nextSeq: number;
}

const MINUTE = 60_000;
const refuse = (message: string): never => {
  throw new CollabSendError(message);
};

/** Validated, distinct RelPaths (02 §6.3.3). */
function checkPaths(paths: readonly string[]): string[] {
  if (paths.length > MAX_PATHS) refuse(`At most ${MAX_PATHS} paths per message; nothing was sent.`);
  paths.forEach((p, i) => {
    const why = relPathProblem(p);
    if (why) refuse(`paths[${i}] ${why}; nothing was sent.`);
  });
  if (new Set(paths).size !== paths.length) refuse("paths has duplicates; nothing was sent.");
  return [...paths];
}

/** Warnings for paths that overlap the peer's active claims (never a block). */
function overlapWarnings(view: CoordView, paths: readonly string[], peerName: string): string[] {
  return view.claims.peer.flatMap((c) => {
    const hit = c.paths.filter((cp) => paths.some((p) => pathsOverlap(p, cp)));
    return hit.length > 0 ? [`Warning: overlaps ${peerName}'s claim ${c.id} (${hit.map((h) => sanitizeAttr(h)).join(", ")}).`] : [];
  });
}

function readFileFor(projectDir: string, path: string, verb: string) {
  try {
    return readContractFile(projectDir, path);
  } catch (e) {
    if (e instanceof ContractFileError) refuse(`Not ${verb}: ${e.message}.`);
    throw e;
  }
}

export function planStructured(input: CollabInput, ctx: CollabContext): CollabPlan {
  const { view } = ctx.loaded;
  const body = input.body === undefined || input.body === "" ? null : input.body;
  const needsBody = !(input.kind === "release" || (input.kind === "contract_response" && input.decision !== "reject"));
  if (needsBody && body === null) refuse(`A ${input.kind} needs a body${input.kind === "claim" ? " saying why" : ""}; nothing was sent.`);
  const lines: string[] = [];
  const scan: [string, string][] = [];
  if (body !== null) scan.push(["body", body]);
  let data: CollabData[CollabKind];
  let replyTo: string | null = null;
  let localPath: string | undefined;
  let claimUntil: number | undefined;

  switch (input.kind) {
    case "heads_up": {
      const paths = checkPaths(input.paths ?? []);
      paths.forEach((p, i) => scan.push([`paths[${i}]`, p]));
      data = { paths };
      lines.push(...overlapWarnings(view, paths, ctx.peerName));
      break;
    }
    case "claim": {
      if (!input.paths || input.paths.length === 0) refuse("A claim needs paths: the files or globs you are about to change; nothing was sent.");
      const paths = checkPaths(input.paths!);
      paths.forEach((p, i) => scan.push([`paths[${i}]`, p]));
      const ttl = input.ttl_minutes ?? CLAIM_TTL_MIN.default;
      if (!Number.isInteger(ttl) || ttl < CLAIM_TTL_MIN.min || ttl > CLAIM_TTL_MIN.max) {
        refuse(`ttl_minutes must be a whole number from ${CLAIM_TTL_MIN.min} to ${CLAIM_TTL_MIN.max}; nothing was sent.`);
      }
      if (view.claims.ours.length >= MAX_ACTIVE_CLAIMS) refuse(`You already have ${MAX_ACTIVE_CLAIMS} active claims; release one first. Nothing was sent.`);
      data = { paths, ttl_min: ttl };
      claimUntil = Math.min(ctx.now + ttl * MINUTE, ctx.roomExpiresAt);
      lines.push(`Claim active until ${new Date(claimUntil).toISOString()} (advisory; pairwire locks nothing).`);
      lines.push(...overlapWarnings(view, paths, ctx.peerName));
      break;
    }
    case "release": {
      if (!input.reply_to) refuse("A release needs reply_to: the id of your claim; nothing was sent.");
      replyTo = input.reply_to!;
      if (!view.claims.ours.some((c) => c.id === replyTo)) refuse(`No active claim of yours with id ${replyTo}; nothing was sent.`);
      data = {};
      break;
    }
    case "contract_propose": {
      const name = input.contract_name;
      if (!name || !contractNameSchema.safeParse(name).success) {
        refuse("contract_name must be 1 to 64 lowercase letters, digits, '.', '_' or '-', starting with a letter or digit; nothing was sent.");
      }
      if (!input.contract_path) refuse("A contract_propose needs contract_path: the contract file in this project; nothing was sent.");
      if (input.rev !== undefined && !revSchema.safeParse(input.rev).success) refuse("rev must be a git commit id: 7 to 40 lowercase hex characters; nothing was sent.");
      const path = input.contract_path!;
      scan.push(["contract_name", name!], ["contract_path", path], ...(input.rev ? ([["rev", input.rev]] as [string, string][]) : []));
      const file = readFileFor(ctx.projectDir, path, "proposed");
      let content: string | null = null;
      if (input.contract_content !== undefined) {
        if (input.contract_content !== file.text) refuse("contract_content differs from the file at contract_path; not proposed.");
        const why = inlineContentProblem(input.contract_content, file.sha256);
        if (why) refuse(`Not proposed: ${why}. Send it without contract_content (by reference).`);
        content = input.contract_content;
        scan.push(["contract_content", content]);
      }
      // The view would show a new name past our limit as over_limit (02 §6.3.4).
      if (!view.contracts.some((c) => c.name === name) && view.contractNames.ours >= MAX_CONTRACT_NAMES_PER_SIDE) {
        refuse(`You have already proposed ${MAX_CONTRACT_NAMES_PER_SIDE} contract names in this room; propose a new version of one of them instead. Nothing was sent.`);
      }
      const version = view.maxVersion(name!) + 1;
      if (version > MAX_CONTRACT_VERSION) refuse("This contract has reached the highest version pairwire supports; use a new contract_name.");
      replyTo = input.reply_to ?? null;
      data = { name: name!, version, path, sha256: file.sha256, rev: input.rev ?? null, content };
      lines.push(`Contract ${name} v${version}, sha256 ${file.sha256}.`);
      break;
    }
    case "contract_response": {
      if (!input.reply_to) refuse("A contract_response needs reply_to: the id of the proposal; nothing was sent.");
      if (!input.decision) refuse('A contract_response needs decision: "accept" or "reject"; nothing was sent.');
      if (input.local_path !== undefined && input.decision !== "accept") refuse("local_path applies only when accepting; nothing was sent.");
      replyTo = input.reply_to!;
      const { ledger } = ctx.loaded;
      const p = view.proposal("peer", replyTo);
      // Held, dropped, answered, superseded and unknown ids all get this one error (04 §4).
      const open = p && p.counted && view.contracts.includes(p) && p.state === "pending" && ledger.ids.has(replyTo) && !ledger.dropped.has(replyTo);
      if (!open) refuse(`No open proposal from your collaborator with id ${replyTo}; nothing was sent.`);
      if (input.local_path !== undefined) {
        const file = readFileFor(ctx.projectDir, input.local_path, "accepted");
        if (file.sha256 !== p!.sha256) refuse(`Your copy at ${input.local_path} doesn't match the proposal; not accepted.`);
        localPath = input.local_path;
      }
      data = { decision: input.decision!, name: p!.name, version: p!.version, sha256: p!.sha256 };
      lines.push(`Contract ${p!.name} v${p!.version}, sha256 ${p!.sha256}.`);
      break;
    }
  }

  const candidate = {
    v: 1,
    id: "0".repeat(26),
    seq: ctx.nextSeq,
    ts: new Date(ctx.now).toISOString(),
    author: "agent",
    kind: input.kind,
    reply_to: replyTo,
    body,
    acks: null,
    data,
  };
  const parsed = envelopeSchema.safeParse(candidate);
  if (!parsed.success) refuse(`Not sent: ${parsed.error.issues.map((i) => i.message).join("; ")}.`);
  const env = parsed.data as CollabEnvelope;
  const fallback = fallbackBody(env, claimUntil === undefined ? {} : { claimUntil });
  // Both encodings must meet the size limits (02 §6.3.6); this throws EnvelopeTooLargeError.
  serializeEnvelope(env);
  serializeEnvelope(fallbackEnvelope(env, fallback));
  scan.push(["the chat fallback", fallback]);
  return { kind: input.kind, data, body, reply_to: replyTo, fallbackBody: fallback, scan, lines, ...(localPath ? { localPath } : {}) };
}
