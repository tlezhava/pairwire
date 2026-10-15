// RelayUnderTest adapter for the Worker relay, running inside workerd via the vitest plugin.
import { SELF } from "cloudflare:test";
import { FrameQueue } from "../../core/test/relay-conformance/frame-queue.js";
import { UpgradeRefused, type RelayUnderTest, type TestSocket } from "../../core/test/relay-conformance/suite.js";

const ORIGIN = "https://relay.test";

export async function connectRaw(roomId: string): Promise<{ ws: WebSocket; socket: TestSocket }> {
  const res = await SELF.fetch(`${ORIGIN}/v1/rooms/${roomId}`, { headers: { Upgrade: "websocket" } });
  const ws = res.webSocket;
  if (!ws) throw new UpgradeRefused(res.status);
  const queue = new FrameQueue();
  let closed = false;
  const closeWaiters: (() => void)[] = [];
  ws.accept();
  // workerd delivers binary frames to this side as Blobs; convert them in arrival order.
  let order = Promise.resolve();
  ws.addEventListener("message", (e) => {
    const data = e.data as string | ArrayBuffer | Blob;
    order = order.then(async () => {
      if (typeof data === "string") return queue.push({ kind: "text", data });
      const buf = data instanceof Blob ? await data.arrayBuffer() : data;
      queue.push({ kind: "binary", data: new Uint8Array(buf) });
    });
  });
  ws.addEventListener("close", (e) => {
    closed = true;
    order = order.then(() => {
      queue.push({ kind: "close", code: e.code });
      for (const w of closeWaiters.splice(0)) w();
    });
  });
  const socket: TestSocket = {
    sendText: (d) => !closed && ws.send(d),
    sendBinary: (d) => !closed && ws.send(d),
    next: (ms) => queue.next(ms),
    quiet: (ms) => queue.quiet(ms),
    close: () =>
      new Promise<void>((done) => {
        if (closed) return done();
        closeWaiters.push(done);
        ws.close(1000);
        setTimeout(done, 200); // the runtime may not echo a close event to the closing side
      }),
  };
  return { ws, socket };
}

export function workerRelay(): RelayUnderTest {
  return {
    connect: async (roomId) => (await connectRaw(roomId)).socket,
    async get(path) {
      const res = await SELF.fetch(`${ORIGIN}${path}`);
      return { status: res.status, body: await res.text(), headers: Object.fromEntries(res.headers) };
    },
    async close() {},
  };
}
