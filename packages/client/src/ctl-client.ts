// The client side of the control channel (04 §8): `ctl say`/`continue`, the D3 waiter,
// `wait_cancel` and `doctor`. In a room with a ctl.key the listener must prove it holds that
// key before the client writes its request or acts on anything it reads (INV-10, ADR-029).
import { createConnection } from "node:net";
import { bytesToHex, hexToBytes, randomBytes } from "@noble/hashes/utils.js";
import { base32Decode, CTL_NONCE_BYTES, verifyCtlProof } from "@pairwire/core";
import { ctlProofSchema, type CtlProofKey } from "./ctl-server.js";
import { readCtlKey } from "./ctl-key.js";
import { createLogger, fileSink, roomTag } from "./log.js";
import { hookErrorsPath } from "./paths.js";

/** Why a proof failed; `refused` is a listener that rejects `hello`, as a 0.1.x server does. */
export type CtlProofFailure = "timeout" | "closed" | "malformed" | "wrong_mac" | "refused" | "key_unreadable";

/** Nothing accepted the connection: no server is listening at `ctl_path`. */
export class CtlUnreachableError extends Error {
  override readonly name = "CtlUnreachableError";
}

/** Something accepted the connection but did not prove it is the owning server. */
export class CtlProofError extends Error {
  override readonly name = "CtlProofError";
  constructor(readonly reason: CtlProofFailure) {
    super(`control channel proof failed: ${reason}`);
  }
}

/** Printed by `ctl say` and `ctl continue` when the proof fails (04 §8, Failure). */
export const CTL_PROOF_FAILED_TEXT =
  "pairwire: the program answering on this room's control channel could not prove it is your pairwire session, so nothing was sent. " +
  "If you just restarted or updated your agent session, try again; if it keeps happening, run `pairwire doctor`.";

export interface CtlTarget {
  home: string;
  roomId: string;
  path: string;
  /** Null for a room without ctl.key (0.1.x servers only): no proof, as before. */
  proof: CtlProofKey | null;
}

/** Appends `ctl_proof_failed` (room tag and reason only) to hook-errors.log. Never throws. */
function logFailure(home: string, roomId: string, reason: CtlProofFailure): void {
  createLogger({ sink: fileSink(hookErrorsPath(home)), level: "warn" }).warn("ctl_proof_failed", { room: roomTag(roomId), reason });
}

/** Where and how to reach the room's server. Throws CtlProofError when ctl.key is unreadable. */
export function ctlTarget(home: string, roomId: string, path: string): CtlTarget {
  let key: Uint8Array | null;
  try {
    key = readCtlKey(home, roomId);
  } catch {
    logFailure(home, roomId, "key_unreadable");
    throw new CtlProofError("key_unreadable");
  }
  return { home, roomId, path, proof: key ? { key, roomIdBytes: base32Decode(roomId) } : null };
}

export interface CtlCallOptions {
  /** Give up connecting after this long (the waiter's `wait_cancel`: 50 ms). */
  connectTimeoutMs?: number;
  /** How long the listener has to send its proof (04 §8: 2 s). */
  proofTimeoutMs?: number;
  /** Inactivity limit for the reply, once the request is written; 0 waits forever (the D3 waiter). */
  replyTimeoutMs?: number;
  /** A limit on everything after connecting (`wait_cancel`: 200 ms). */
  deadlineMs?: number;
  /** Write the request and end the connection without waiting for a reply (`wait_cancel`). */
  noReply?: boolean;
  /** Log proof failures to hook-errors.log (default true). */
  log?: boolean;
}

const MAX_PROOF_LINE = 1024;

/**
 * Connects to `target.path`, runs the `hello` exchange when the room has a key, then writes
 * `request` (none: only the proof, for `doctor`) and resolves with the first reply line, or
 * null when the connection ends without one (or `noReply`). Rejects with CtlUnreachableError
 * when nothing accepted the connection and CtlProofError when the listener did not prove
 * itself; in that case nothing but the `hello` was written.
 */
export function ctlCall(target: CtlTarget, request: object | null, o: CtlCallOptions = {}): Promise<string | null> {
  const proofTimeoutMs = o.proofTimeoutMs ?? 2000;
  return new Promise((resolve, reject) => {
    const socket = createConnection(target.path);
    socket.setEncoding("utf8");
    let phase: "connecting" | "proving" | "replying" | "done" = "connecting";
    let buf = "";
    const timers: ReturnType<typeof setTimeout>[] = [];
    const nonce = randomBytes(CTL_NONCE_BYTES);
    const finish = (result: { line: string | null } | { error: Error }) => {
      if (phase === "done") return;
      const failed = "error" in result;
      if (failed && result.error instanceof CtlProofError && o.log !== false) logFailure(target.home, target.roomId, result.error.reason);
      phase = "done";
      for (const t of timers) clearTimeout(t);
      socket.destroy();
      if (failed) reject(result.error);
      else resolve(result.line);
    };
    const proofFailed = (reason: CtlProofFailure) => finish({ error: new CtlProofError(reason) });
    const sendRequest = () => {
      phase = "replying";
      if (request === null) return finish({ line: null });
      const line = JSON.stringify(request) + "\n";
      if (o.noReply) {
        socket.end(line);
        return;
      }
      socket.write(line);
      if (o.replyTimeoutMs) socket.setTimeout(o.replyTimeoutMs, () => finish({ line: null }));
    };
    if (o.connectTimeoutMs) timers.push(setTimeout(() => phase === "connecting" && finish({ error: new CtlUnreachableError("connect timeout") }), o.connectTimeoutMs));

    socket.on("connect", () => {
      if (phase !== "connecting") return;
      if (o.deadlineMs) timers.push(setTimeout(() => (phase === "proving" ? proofFailed("timeout") : finish({ line: null })), o.deadlineMs));
      if (!target.proof) return sendRequest();
      phase = "proving";
      socket.write(JSON.stringify({ op: "hello", v: 1, nonce: bytesToHex(nonce) }) + "\n");
      timers.push(setTimeout(() => phase === "proving" && proofFailed("timeout"), proofTimeoutMs));
    });
    socket.on("data", (chunk: string) => {
      if (phase === "done") return;
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (phase === "proving") {
        if (nl < 0) {
          if (buf.length > MAX_PROOF_LINE) proofFailed("malformed");
          return;
        }
        const failure = checkProof(buf.slice(0, nl), target.proof!, nonce);
        if (failure) return proofFailed(failure);
        // Proven: what follows on this connection comes from the owning server.
        buf = buf.slice(nl + 1);
        sendRequest(); // moves to "replying", or "done" for a proof-only call
      }
      const end = buf.indexOf("\n");
      if ((phase as string) === "replying" && end >= 0 && !o.noReply) finish({ line: buf.slice(0, end) });
    });
    socket.on("error", (e) => (phase === "connecting" ? finish({ error: new CtlUnreachableError(e.message) }) : undefined));
    socket.on("close", () => {
      if (phase === "connecting") finish({ error: new CtlUnreachableError("closed") });
      else if (phase === "proving") proofFailed("closed");
      else finish({ line: null });
    });
  });
}

/** Null when `line` is a valid proof for `nonce`, else why not. */
function checkProof(line: string, proof: CtlProofKey, nonce: Uint8Array): CtlProofFailure | null {
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return "malformed";
  }
  const parsed = ctlProofSchema.safeParse(v);
  if (!parsed.success) {
    // An old server answers `hello` with {"ok":false,"text":"pairwire: bad control request."}.
    return typeof v === "object" && v !== null && (v as { ok?: unknown }).ok === false ? "refused" : "malformed";
  }
  return verifyCtlProof(proof.key, proof.roomIdBytes, nonce, hexToBytes(parsed.data.mac)) ? null : "wrong_mac";
}
