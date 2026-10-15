// RelayUnderTest adapter for the Node relay over real sockets on 127.0.0.1.
import { WebSocket } from "ws";
import { FrameQueue } from "../../core/test/relay-conformance/frame-queue.js";
import { UpgradeRefused, type RelayUnderTest, type TestSocket } from "../../core/test/relay-conformance/suite.js";
import { ManualClock } from "../src/clock.js";
import type { LogSink } from "../src/log.js";
import { createLogger } from "../src/log.js";
import { createRelayServer } from "../src/server.js";

export async function startNodeRelay(sink: LogSink = () => {}): Promise<RelayUnderTest & { clock: ManualClock; port: number }> {
  const clock = new ManualClock(Date.UTC(2026, 9, 15, 12));
  const server = createRelayServer({ port: 0, host: "127.0.0.1", clock, log: createLogger(sink), version: "0.0.0" });
  const { port } = await server.listen();
  const base = `127.0.0.1:${port}`;
  const open = new Set<WebSocket>();

  return {
    clock,
    port,
    connect(roomId) {
      return new Promise<TestSocket>((resolve, reject) => {
        const ws = new WebSocket(`ws://${base}/v1/rooms/${roomId}`);
        const queue = new FrameQueue();
        ws.on("unexpected-response", (_req, res) => reject(new UpgradeRefused(res.statusCode ?? 0)));
        ws.on("error", (err) => reject(err));
        ws.on("message", (data, isBinary) => {
          const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as Buffer);
          queue.push(isBinary ? { kind: "binary", data: new Uint8Array(buf) } : { kind: "text", data: buf.toString("utf8") });
        });
        ws.on("close", (code) => {
          open.delete(ws);
          queue.push({ kind: "close", code });
        });
        ws.on("open", () => {
          open.add(ws);
          resolve({
            sendText: (d) => ws.readyState === ws.OPEN && ws.send(d),
            sendBinary: (d) => ws.readyState === ws.OPEN && ws.send(d, { binary: true }),
            next: (ms) => queue.next(ms),
            quiet: (ms) => queue.quiet(ms),
            close: () =>
              new Promise<void>((done) => {
                if (ws.readyState === ws.CLOSED) return done();
                ws.once("close", () => done());
                ws.close(1000);
              }),
          });
        });
      });
    },
    async get(path) {
      const res = await fetch(`http://${base}${path}`);
      return { status: res.status, body: await res.text(), headers: Object.fromEntries(res.headers) };
    },
    async advance(ms) {
      const settle = () => new Promise((r) => setTimeout(r, 20));
      await settle(); // let in-flight frames and closes reach the relay first
      clock.advance(ms);
      await settle(); // then let the resulting frames cross the socket
    },
    async close() {
      for (const ws of open) ws.terminate();
      await server.close();
    },
  };
}
