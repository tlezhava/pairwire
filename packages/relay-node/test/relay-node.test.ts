import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { base32Encode } from "../../core/src/base32.js";
import { ManualClock } from "../src/clock.js";
import { roomTag } from "../src/log.js";
import { startNodeRelay } from "./ws-relay.js";

describe("relay-node HTTP extras (03)", () => {
  it("answers a non-upgrade GET to a room path with 426, and a bad room id with 400", async () => {
    const relay = await startNodeRelay();
    try {
      expect((await relay.get(`/v1/rooms/${base32Encode(randomBytes(16))}`)).status).toBe(426);
      expect((await relay.get("/v1/rooms/NOT-A-ROOM")).status).toBe(400);
    } finally {
      await relay.close();
    }
  });
});

describe("relay-node logging rules (03, Logging)", () => {
  it("logs counts and codes with a 4-character room tag, never room ids, tokens, IPs or frame contents", async () => {
    const lines: string[] = [];
    const relay = await startNodeRelay((line) => lines.push(line));
    const roomId = base32Encode(randomBytes(16));
    const payload = Uint8Array.from(Buffer.from("PLAINTEXT-MARKER-should-never-be-logged"));
    try {
      const a = await relay.connect(roomId);
      a.sendText('{"t":"join","v":1,"token":null}');
      const joined = JSON.parse(((await a.next()) as { data: string }).data) as { token: string };
      const b = await relay.connect(roomId);
      b.sendText('{"t":"join","v":1,"token":null}');
      await b.next();
      await a.next();
      a.sendBinary(payload);
      await b.next();
      const bad = await relay.connect(roomId);
      bad.sendText("not json");
      expect(await bad.next()).toEqual({ kind: "close", code: 4005 });
      a.sendText('{"t":"leave"}');
      await b.next();
      await b.next();

      const all = lines.join("\n");
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
      expect(all).not.toContain(roomId);
      expect(all).not.toContain(joined.token);
      expect(all).not.toContain("127.0.0.1");
      expect(all).not.toContain("PLAINTEXT-MARKER");
      expect(all).toContain(`"code":4005`);
      expect(all).toContain(`"room":"${roomTag(roomId)}"`);
      expect(roomTag(roomId)).toMatch(/^[0-9a-f]{4}$/);
    } finally {
      await relay.close();
    }
  });
});

describe("ManualClock", () => {
  it("runs due timers in time order, including ones scheduled while advancing, and supports cancel", () => {
    const clock = new ManualClock(1000);
    const ran: string[] = [];
    clock.schedule(1300, () => ran.push("c"));
    clock.schedule(1100, () => {
      ran.push("a");
      clock.schedule(1200, () => ran.push("b"));
    });
    const cancel = clock.schedule(1150, () => ran.push("cancelled"));
    cancel();
    clock.advance(250);
    expect(ran).toEqual(["a", "b"]);
    expect(clock.now()).toBe(1250);
    clock.advance(50);
    expect(ran).toEqual(["a", "b", "c"]);
  });
});
