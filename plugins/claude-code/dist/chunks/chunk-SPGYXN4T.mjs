import { createRequire as __pwCreateRequire } from "node:module";
const require = __pwCreateRequire(import.meta.url);
import {
  PRIVATE_FILE_MODE,
  ensurePrivateDir,
  errorCode,
  removeFile
} from "./chunk-VSMKZZ5B.mjs";
import {
  isNamedPipePath,
  roomFile
} from "./chunk-GVGSGJLD.mjs";
import {
  CTL_KEY_BYTES,
  ctlProof,
  external_exports
} from "./chunk-CPUICV65.mjs";
import {
  bytesToHex,
  hexToBytes,
  randomBytes
} from "./chunk-KARZWXGF.mjs";

// packages/client/src/ctl-key.ts
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, openSync, readSync, renameSync, writeSync } from "node:fs";
var CtlKeyError = class extends Error {
  constructor(problem) {
    super(
      problem === "corrupt" ? "The control channel key is corrupt." : problem === "not_private" ? "The control channel key is not private." : "The control channel key can't be read."
    );
    this.problem = problem;
  }
  problem;
  name = "CtlKeyError";
};
function ensureCtlKey(home, roomId) {
  const path = roomFile(home, roomId, "ctl.key");
  let replace = false;
  try {
    const st = lstatSync(path);
    if (!st.isFile() || st.size === CTL_KEY_BYTES) return;
    replace = true;
  } catch (e) {
    if (errorCode(e) !== "ENOENT") throw e;
  }
  const tmp = `${path}.${process.pid}.${bytesToHex(randomBytes(8))}.tmp`;
  try {
    const fd = openSync(tmp, "wx", PRIVATE_FILE_MODE);
    try {
      const key = randomBytes(CTL_KEY_BYTES);
      let off = 0;
      while (off < key.length) off += writeSync(fd, key, off, key.length - off);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (replace) renameSync(tmp, path);
    else {
      try {
        linkSync(tmp, path);
      } catch (e) {
        if (errorCode(e) !== "EEXIST") throw e;
      }
    }
  } finally {
    removeFile(tmp);
  }
}
var posix = process.platform !== "win32";
function readCtlKey(home, roomId) {
  let fd;
  try {
    fd = openSync(roomFile(home, roomId, "ctl.key"), posix ? constants.O_RDONLY | constants.O_NOFOLLOW : "r");
  } catch (e) {
    if (errorCode(e) === "ENOENT") return null;
    throw new CtlKeyError("unreadable");
  }
  try {
    let st;
    try {
      st = fstatSync(fd);
    } catch {
      throw new CtlKeyError("unreadable");
    }
    if (!st.isFile()) throw new CtlKeyError("unreadable");
    if (posix && (st.uid !== process.getuid?.() || (st.mode & 63) !== 0)) throw new CtlKeyError("not_private");
    if (st.size !== CTL_KEY_BYTES) throw new CtlKeyError("corrupt");
    const key = new Uint8Array(CTL_KEY_BYTES + 1);
    let n = 0;
    try {
      while (n < key.length) {
        const r = readSync(fd, key, n, key.length - n, null);
        if (r === 0) break;
        n += r;
      }
    } catch {
      throw new CtlKeyError("unreadable");
    }
    if (n !== CTL_KEY_BYTES) throw new CtlKeyError("corrupt");
    return key.slice(0, CTL_KEY_BYTES);
  } finally {
    closeSync(fd);
  }
}

// packages/client/src/ctl-server.ts
import { chmodSync, lstatSync as lstatSync2 } from "node:fs";
import { createServer } from "node:net";
import { dirname } from "node:path";
var CTL_MAX_REQUEST = 64 * 1024;
var REQUEST_TIMEOUT_MS = 1e4;
var CTL_LISTEN_RETRIES = 3;
var hex32 = external_exports.string().regex(/^[0-9a-f]{64}$/);
var ctlHelloSchema = external_exports.strictObject({ op: external_exports.literal("hello"), v: external_exports.literal(1), nonce: hex32 });
var ctlProofSchema = external_exports.strictObject({ t: external_exports.literal("proof"), v: external_exports.literal(1), mac: hex32 });
function parseCtlRequest(line) {
  let v;
  try {
    v = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof v !== "object" || v === null) return null;
  const r = v;
  if (r.op === "say" && typeof r.text === "string") return { op: "say", text: r.text };
  if (r.op === "continue" || r.op === "resume") return { op: r.op };
  if ((r.op === "wait" || r.op === "wait_cancel") && typeof r.session === "string") return { op: r.op, session: r.session };
  return null;
}
function answerHello(line, proof) {
  let v;
  try {
    v = JSON.parse(line);
  } catch {
    return null;
  }
  const hello = ctlHelloSchema.safeParse(v);
  if (!hello.success) return null;
  const mac = bytesToHex(ctlProof(proof.key, proof.roomIdBytes, hexToBytes(hello.data.nonce)));
  return JSON.stringify({ t: "proof", v: 1, mac }) + "\n";
}
function isHello(line) {
  try {
    const v = JSON.parse(line);
    return typeof v === "object" && v !== null && v.op === "hello";
  } catch {
    return false;
  }
}
async function listenFresh(path, next, listen, retries = CTL_LISTEN_RETRIES, onRetry) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await listen(path);
    } catch (e) {
      if (!next || attempt >= retries) throw e;
      onRetry?.(e);
      path = next();
    }
  }
}
function preparePrivateDir(dir) {
  ensurePrivateDir(dir);
  const st = lstatSync2(dir);
  const uid = process.getuid?.();
  if (!st.isDirectory() || uid !== void 0 && st.uid !== uid || (st.mode & 63) !== 0) {
    throw new Error(`The control socket directory ${dir} is not private to you.`);
  }
}
async function listenCtl(path, handle, log, wait, proof) {
  const pipe = isNamedPipePath(path);
  if (!pipe) {
    preparePrivateDir(dirname(path));
    removeFile(path);
  }
  const server = createServer((socket) => {
    let buf = "";
    let done = false;
    let lines = 0;
    socket.setEncoding("utf8");
    socket.setTimeout(REQUEST_TIMEOUT_MS, () => socket.destroy());
    const reply = (r) => {
      done = true;
      socket.end(JSON.stringify(r) + "\n");
    };
    const bad = () => reply({ ok: false, text: "pairwire: bad control request." });
    const consume = () => {
      for (; ; ) {
        const nl = buf.indexOf("\n");
        if (nl > CTL_MAX_REQUEST || nl < 0 && buf.length > CTL_MAX_REQUEST) return reply({ ok: false, text: "pairwire: request too large." });
        if (nl < 0) return;
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        lines++;
        if (isHello(line)) {
          const answer = lines === 1 && proof ? answerHello(line, proof) : null;
          if (!answer) return bad();
          socket.write(answer);
          socket.setTimeout(REQUEST_TIMEOUT_MS);
          continue;
        }
        const request = parseCtlRequest(line);
        if (!request) return bad();
        socket.setTimeout(0);
        if (request.op === "wait") {
          done = true;
          if (wait) return wait(request, socket);
          return void socket.end(JSON.stringify({ t: "refused" }) + "\n");
        }
        done = true;
        handle(request).then(reply, (e) => {
          log.error("ctl_failed", e);
          reply({ ok: false, text: "pairwire: internal error; see the MCP server log." });
        });
        return;
      }
    };
    socket.on("data", (chunk) => {
      if (done) return;
      buf += chunk;
      consume();
    });
    socket.on("error", () => {
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      resolve();
    });
  });
  if (!pipe) chmodSync(path, 384);
  server.on("error", (e) => log.error("ctl_server_error", e));
  return {
    close: () => new Promise((resolve) => {
      server.close(() => resolve());
      if (!pipe) removeFile(path);
    })
  };
}

export {
  CtlKeyError,
  ensureCtlKey,
  readCtlKey,
  CTL_MAX_REQUEST,
  CTL_LISTEN_RETRIES,
  ctlProofSchema,
  listenFresh,
  listenCtl
};
