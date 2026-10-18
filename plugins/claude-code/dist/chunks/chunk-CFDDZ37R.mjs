import { createRequire as __pwCreateRequire } from "node:module";
const require = __pwCreateRequire(import.meta.url);
import {
  ctlProofSchema,
  readCtlKey
} from "./chunk-SPGYXN4T.mjs";
import {
  createLogger,
  fileSink,
  roomTag
} from "./chunk-VSMKZZ5B.mjs";
import {
  hookErrorsPath
} from "./chunk-GVGSGJLD.mjs";
import {
  CTL_NONCE_BYTES,
  base32Decode,
  verifyCtlProof
} from "./chunk-CPUICV65.mjs";
import {
  bytesToHex,
  hexToBytes,
  randomBytes
} from "./chunk-KARZWXGF.mjs";

// packages/client/src/ctl-client.ts
import { createConnection } from "node:net";
var CtlUnreachableError = class extends Error {
  name = "CtlUnreachableError";
};
var CtlProofError = class extends Error {
  constructor(reason) {
    super(`control channel proof failed: ${reason}`);
    this.reason = reason;
  }
  reason;
  name = "CtlProofError";
};
var CTL_PROOF_FAILED_TEXT = "pairwire: the program answering on this room's control channel could not prove it is your pairwire session, so nothing was sent. If you just restarted or updated your agent session, try again; if it keeps happening, run `pairwire doctor`.";
function logFailure(home, roomId, reason) {
  createLogger({ sink: fileSink(hookErrorsPath(home)), level: "warn" }).warn("ctl_proof_failed", { room: roomTag(roomId), reason });
}
function ctlTarget(home, roomId, path) {
  let key;
  try {
    key = readCtlKey(home, roomId);
  } catch {
    logFailure(home, roomId, "key_unreadable");
    throw new CtlProofError("key_unreadable");
  }
  return { home, roomId, path, proof: key ? { key, roomIdBytes: base32Decode(roomId) } : null };
}
var MAX_PROOF_LINE = 1024;
function ctlCall(target, request, o = {}) {
  const proofTimeoutMs = o.proofTimeoutMs ?? 2e3;
  return new Promise((resolve, reject) => {
    const socket = createConnection(target.path);
    socket.setEncoding("utf8");
    let phase = "connecting";
    let buf = "";
    const timers = [];
    const nonce = randomBytes(CTL_NONCE_BYTES);
    const finish = (result) => {
      if (phase === "done") return;
      const failed = "error" in result;
      if (failed && result.error instanceof CtlProofError && o.log !== false) logFailure(target.home, target.roomId, result.error.reason);
      phase = "done";
      for (const t of timers) clearTimeout(t);
      socket.destroy();
      if (failed) reject(result.error);
      else resolve(result.line);
    };
    const proofFailed = (reason) => finish({ error: new CtlProofError(reason) });
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
      if (o.deadlineMs) timers.push(setTimeout(() => phase === "proving" ? proofFailed("timeout") : finish({ line: null }), o.deadlineMs));
      if (!target.proof) return sendRequest();
      phase = "proving";
      socket.write(JSON.stringify({ op: "hello", v: 1, nonce: bytesToHex(nonce) }) + "\n");
      timers.push(setTimeout(() => phase === "proving" && proofFailed("timeout"), proofTimeoutMs));
    });
    socket.on("data", (chunk) => {
      if (phase === "done") return;
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (phase === "proving") {
        if (nl < 0) {
          if (buf.length > MAX_PROOF_LINE) proofFailed("malformed");
          return;
        }
        const failure = checkProof(buf.slice(0, nl), target.proof, nonce);
        if (failure) return proofFailed(failure);
        buf = buf.slice(nl + 1);
        sendRequest();
      }
      const end = buf.indexOf("\n");
      if (phase === "replying" && end >= 0 && !o.noReply) finish({ line: buf.slice(0, end) });
    });
    socket.on("error", (e) => phase === "connecting" ? finish({ error: new CtlUnreachableError(e.message) }) : void 0);
    socket.on("close", () => {
      if (phase === "connecting") finish({ error: new CtlUnreachableError("closed") });
      else if (phase === "proving") proofFailed("closed");
      else finish({ line: null });
    });
  });
}
function checkProof(line, proof, nonce) {
  let v;
  try {
    v = JSON.parse(line);
  } catch {
    return "malformed";
  }
  const parsed = ctlProofSchema.safeParse(v);
  if (!parsed.success) {
    return typeof v === "object" && v !== null && v.ok === false ? "refused" : "malformed";
  }
  return verifyCtlProof(proof.key, proof.roomIdBytes, nonce, hexToBytes(parsed.data.mac)) ? null : "wrong_mac";
}

export {
  CtlUnreachableError,
  CtlProofError,
  CTL_PROOF_FAILED_TEXT,
  ctlTarget,
  ctlCall
};
