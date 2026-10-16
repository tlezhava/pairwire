// The owning MCP server's control socket (04 §8, ctl.sock protocol): one JSON request line,
// one JSON reply line, per connection. Only the human-side `pairwire ctl` talks to it.
import { chmodSync, lstatSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
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
 * lets only this user write to it (04 §8).
 */
export async function listenCtl(path: string, handle: CtlHandler, log: Logger, wait?: WaitHandler): Promise<CtlServer> {
  const pipe = isNamedPipePath(path);
  if (!pipe) {
    preparePrivateDir(dirname(path));
    removeFile(path);
  }
  const server: Server = createServer((socket) => {
    let buf = "";
    let done = false;
    socket.setEncoding("utf8");
    socket.setTimeout(REQUEST_TIMEOUT_MS, () => socket.destroy());
    const reply = (r: CtlReply) => {
      done = true;
      socket.end(JSON.stringify(r) + "\n");
    };
    socket.on("data", (chunk: string) => {
      if (done) return;
      buf += chunk;
      if (buf.length > CTL_MAX_REQUEST) return reply({ ok: false, text: "pairwire: request too large." });
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      const request = parseCtlRequest(buf.slice(0, nl));
      if (!request) return reply({ ok: false, text: "pairwire: bad control request." });
      socket.setTimeout(0);
      if (request.op === "wait") {
        done = true;
        if (wait) return wait(request, socket);
        return void socket.end(JSON.stringify({ t: "refused" } satisfies WaitFrame) + "\n");
      }
      handle(request).then(reply, (e: unknown) => {
        log.error("ctl_failed", e);
        reply({ ok: false, text: "pairwire: internal error; see the MCP server log." });
      });
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
