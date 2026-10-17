// The owning MCP server's control socket (04 §8, ctl.sock protocol): one JSON request line,
// one JSON reply line, per connection. Only the human-side `pairwire ctl` talks to it. In a
// room with a ctl.key the client opens with a `hello`, which the server answers with its
// proof before it reads the request (ADR-029).
import { chmodSync, lstatSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { ctlProof } from "@pairwire/core";
import { z } from "zod";
import { ensurePrivateDir, removeFile } from "./fs-util.js";
import type { Logger } from "./log.js";
import { isNamedPipePath } from "./paths.js";

export interface CtlReply {
  ok: boolean;
  text: string;
}

export type CtlRequest =
  | { op: "say"; text: string }
  | { op: "continue" }
  | { op: "resume" }
  | { op: "wait_cancel"; session: string };

/** The D3 waiter's long-lived request (04 §6): the handler owns the socket from then on. */
export interface WaitRequest {
  op: "wait";
  session: string;
}

/** Frames the server sends a waiter; each ends the connection. */
export type WaitFrame = { t: "wake"; text: string } | { t: "superseded" } | { t: "cancelled" } | { t: "refused" };

export type CtlHandler = (request: CtlRequest) => Promise<CtlReply>;
export type WaitHandler = (request: WaitRequest, socket: Socket) => void;

export const CTL_MAX_REQUEST = 64 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;
/** Windows: listen attempts with a fresh pipe name after the first one fails (04 §8). */
export const CTL_LISTEN_RETRIES = 3;

const hex32 = z.string().regex(/^[0-9a-f]{64}$/);
/** The client's challenge, only ever a connection's first line (04 §8, Control-channel server proof). */
export const ctlHelloSchema = z.strictObject({ op: z.literal("hello"), v: z.literal(1), nonce: hex32 });
/** The server's answer to a `hello`. */
export const ctlProofSchema = z.strictObject({ t: z.literal("proof"), v: z.literal(1), mac: hex32 });

/** What the server proves it holds: the room's ctl.key, and room_id_bytes. */
export interface CtlProofKey {
  key: Uint8Array;
  roomIdBytes: Uint8Array;
}

export function parseCtlRequest(line: string): CtlRequest | WaitRequest | null {
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof v !== "object" || v === null) return null;
  const r = v as Record<string, unknown>;
  if (r.op === "say" && typeof r.text === "string") return { op: "say", text: r.text };
  if (r.op === "continue" || r.op === "resume") return { op: r.op };
  if ((r.op === "wait" || r.op === "wait_cancel") && typeof r.session === "string") return { op: r.op, session: r.session };
  return null;
}

/** The proof line answering a `hello` line; null when the line isn't a well-formed v1 `hello`. */
export function answerHello(line: string, proof: CtlProofKey): string | null {
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return null;
  }
  const hello = ctlHelloSchema.safeParse(v);
  if (!hello.success) return null;
  const mac = bytesToHex(ctlProof(proof.key, proof.roomIdBytes, hexToBytes(hello.data.nonce)));
  return JSON.stringify({ t: "proof", v: 1, mac } satisfies z.infer<typeof ctlProofSchema>) + "\n";
}

/** Whether a line asks for the proof at all (its `op` is "hello"), well-formed or not. */
function isHello(line: string): boolean {
  try {
    const v = JSON.parse(line) as unknown;
    return typeof v === "object" && v !== null && (v as { op?: unknown }).op === "hello";
  } catch {
    return false;
  }
}

/**
 * Listens on `path`; when that fails and `next` is given (Windows), on a fresh path from
 * `next()`, up to `retries` more times (04 §8). `next` records each path before it is used.
 */
export async function listenFresh<T>(
  path: string,
  next: (() => string) | null,
  listen: (path: string) => Promise<T>,
  retries = CTL_LISTEN_RETRIES,
  onRetry?: (e: unknown) => void,
): Promise<T> {
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

/** The socket's directory must be ours and private (INV-9); create it if missing. */
function preparePrivateDir(dir: string): void {
  ensurePrivateDir(dir);
  const st = lstatSync(dir);
  const uid = process.getuid?.();
  if (!st.isDirectory() || (uid !== undefined && st.uid !== uid) || (st.mode & 0o077) !== 0) {
    throw new Error(`The control socket directory ${dir} is not private to you.`);
  }
}

export interface CtlServer {
  close(): Promise<void>;
}

/**
 * Listens on `path` (mode 0600). A stale socket file from a dead server is replaced. A Windows
 * named pipe has no directory, file or mode: it vanishes with its server, and its default ACL
 * lets only this user write to it (04 §8). With `proof`, a connection's first line may be a
 * `hello`, answered with the proof before the request line is read; a client that sends its
 * request first (0.1.x) is served as before. Without `proof` a `hello` is a bad request, as
 * in 0.1.x.
 */
export async function listenCtl(path: string, handle: CtlHandler, log: Logger, wait?: WaitHandler, proof?: CtlProofKey): Promise<CtlServer> {
  const pipe = isNamedPipePath(path);
  if (!pipe) {
    preparePrivateDir(dirname(path));
    removeFile(path);
  }
  const server: Server = createServer((socket) => {
    let buf = "";
    let done = false;
    let lines = 0;
    socket.setEncoding("utf8");
    socket.setTimeout(REQUEST_TIMEOUT_MS, () => socket.destroy());
    const reply = (r: CtlReply) => {
      done = true;
      socket.end(JSON.stringify(r) + "\n");
    };
    const bad = () => reply({ ok: false, text: "pairwire: bad control request." });
    /** Handles the complete lines in `buf` until the request (or an error) is answered. */
    const consume = (): void => {
      for (;;) {
        const nl = buf.indexOf("\n");
        // The 64 KiB cap and the timeout apply to each line (04 §8).
        if (nl > CTL_MAX_REQUEST || (nl < 0 && buf.length > CTL_MAX_REQUEST)) return reply({ ok: false, text: "pairwire: request too large." });
        if (nl < 0) return;
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        lines++;
        if (isHello(line)) {
          // Only as the first line, and only from a server that has the key.
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
          return void socket.end(JSON.stringify({ t: "refused" } satisfies WaitFrame) + "\n");
        }
        done = true;
        handle(request).then(reply, (e: unknown) => {
          log.error("ctl_failed", e);
          reply({ ok: false, text: "pairwire: internal error; see the MCP server log." });
        });
        return;
      }
    };
    socket.on("data", (chunk: string) => {
      if (done) return;
      buf += chunk;
      consume();
    });
    socket.on("error", () => {});
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      resolve();
    });
  });
  if (!pipe) chmodSync(path, 0o600);
  server.on("error", (e) => log.error("ctl_server_error", e));
  return {
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        if (!pipe) removeFile(path);
      }),
  };
}
