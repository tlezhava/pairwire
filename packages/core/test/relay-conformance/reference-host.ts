// In-memory host for RelayRoom: the reference the conformance suite is checked against in
// M2-1, before the Node and Worker relays exist. No network; the clock is fake.
import { relayInfo } from "../../src/limits.js";
import { RelayRoom, type Output } from "../../src/relay-room.js";
import { FrameQueue } from "./frame-queue.js";
import { UpgradeRefused, type RelayUnderTest, type TestSocket } from "./suite.js";

const ROOM_ID = /^[a-z2-7]{26}$/;

export function createReferenceRelay(): RelayUnderTest {
  let now = Date.UTC(2026, 9, 15, 12);
  const rooms = new Map<string, { room: RelayRoom; alarmAt: number | null }>();
  const queues = new Map<string, FrameQueue>();
  let seq = 0;

  function apply(roomId: string, out: Output): void {
    for (const e of out.effects) {
      const q = queues.get(e.socket);
      if (!q) continue;
      if (e.type === "send") {
        q.push(typeof e.data === "string" ? { kind: "text", data: e.data } : { kind: "binary", data: e.data.slice() });
      } else {
        q.push({ kind: "close", code: e.code });
        queues.delete(e.socket);
      }
    }
    rooms.get(roomId)!.alarmAt = out.alarmAt;
  }

  return {
    async connect(roomId) {
      if (!ROOM_ID.test(roomId)) throw new UpgradeRefused(400);
      if (!rooms.has(roomId)) rooms.set(roomId, { room: new RelayRoom({ now: () => now }), alarmAt: null });
      const { room } = rooms.get(roomId)!;
      const id = `s${seq++}`;
      const queue = new FrameQueue();
      queues.set(id, queue);
      apply(roomId, room.connect(id));
      const live = () => queues.get(id) === queue;
      const socket: TestSocket = {
        sendText: (data) => live() && apply(roomId, room.text(id, data)),
        sendBinary: (data) => live() && apply(roomId, room.binary(id, data.slice())),
        next: (ms) => queue.next(ms),
        quiet: (ms) => queue.quiet(ms),
        close: () => {
          if (!live()) return;
          queues.delete(id);
          apply(roomId, room.disconnect(id));
        },
      };
      return socket;
    },

    async get(path) {
      if (path === "/health") return { status: 200, body: "ok", headers: {} };
      if (path === "/v1/info") return { status: 200, body: JSON.stringify(relayInfo("0.0.0")), headers: {} };
      return { status: 404, body: "not found", headers: {} };
    },

    async advance(ms) {
      const target = now + ms;
      for (;;) {
        let due: [string, { room: RelayRoom; alarmAt: number | null }] | undefined;
        for (const entry of rooms) {
          const at = entry[1].alarmAt;
          if (at !== null && at <= target && (!due || at < due[1].alarmAt!)) due = entry;
        }
        if (!due) break;
        now = Math.max(now, due[1].alarmAt!);
        apply(due[0], due[1].room.alarm());
      }
      now = target;
    },

    async close() {},
  };
}
