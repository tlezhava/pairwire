// Relay text frames as the client reads them (02 §5, ADR-031).
import { describe, expect, it } from "vitest";
import { parseRelayFrame } from "../src/relay-frames.js";

const TOKEN = "A".repeat(42) + "_";
const joined = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ t: "joined", member: "a", token: TOKEN, epoch: 7, peer_present: false, buffered: 0, expires_at: 1760529600000, ...over });

describe("parseRelayFrame (02 §5)", () => {
  it("reads every frame the relay sends", () => {
    expect(parseRelayFrame(joined())).toEqual({
      ok: true,
      frame: { t: "joined", member: "a", token: TOKEN, epoch: 7, peer_present: false, buffered: 0, expires_at: 1760529600000 },
    });
    expect(parseRelayFrame('{"t":"peer_joined","epoch":8}')).toEqual({ ok: true, frame: { t: "peer_joined", epoch: 8 } });
    expect(parseRelayFrame('{"t":"peer_left","reason":"left"}')).toEqual({ ok: true, frame: { t: "peer_left", reason: "left" } });
    expect(parseRelayFrame('{"t":"error","code":"rate_limited","retry_after":3}')).toEqual({
      ok: true,
      frame: { t: "error", code: "rate_limited", retry_after: 3 },
    });
    expect(parseRelayFrame('{"t":"error","code":"too_large"}')).toEqual({ ok: true, frame: { t: "error", code: "too_large" } });
    expect(parseRelayFrame('{"t":"pong"}')).toEqual({ ok: true, frame: { t: "pong" } });
  });

  it("accepts the u32 bounds of an epoch and drops extra fields", () => {
    expect(parseRelayFrame('{"t":"peer_joined","epoch":0}').ok).toBe(true);
    expect(parseRelayFrame('{"t":"peer_joined","epoch":4294967295,"extra":1}')).toEqual({ ok: true, frame: { t: "peer_joined", epoch: 4294967295 } });
  });

  it("ignores a frame type it does not know, for newer relays", () => {
    expect(parseRelayFrame('{"t":"room_info","x":1}')).toEqual({ ok: false, reason: "unknown_type" });
  });

  it("refuses an epoch outside u32, missing or fractional (the review's crash)", () => {
    for (const epoch of [4294967296, -1, 1.5, "7", null]) {
      expect(parseRelayFrame(JSON.stringify({ t: "peer_joined", epoch }))).toEqual({ ok: false, reason: "invalid", t: "peer_joined", fields: ["epoch"] });
      expect(parseRelayFrame(joined({ epoch }))).toEqual({ ok: false, reason: "invalid", t: "joined", fields: ["epoch"] });
    }
    expect(parseRelayFrame('{"t":"peer_joined"}')).toEqual({ ok: false, reason: "invalid", t: "peer_joined", fields: ["epoch"] });
  });

  it("refuses an unbounded retry_after (the review's busy loop)", () => {
    for (const retry_after of [1e12, 3601, -1, "30"]) {
      expect(parseRelayFrame(JSON.stringify({ t: "error", code: "rate_limited", retry_after }))).toEqual({
        ok: false,
        reason: "invalid",
        t: "error",
        fields: ["retry_after"],
      });
    }
    expect(parseRelayFrame('{"t":"error","code":"rate_limited","retry_after":3600}').ok).toBe(true);
  });

  it("checks the other joined fields and the error code", () => {
    expect(parseRelayFrame(joined({ member: "c" }))).toMatchObject({ ok: false, fields: ["member"] });
    expect(parseRelayFrame(joined({ token: "short" }))).toMatchObject({ ok: false, fields: ["token"] });
    expect(parseRelayFrame(joined({ token: "A".repeat(42) + "=" }))).toMatchObject({ ok: false, fields: ["token"] });
    expect(parseRelayFrame(joined({ expires_at: 2 ** 53 }))).toMatchObject({ ok: false, fields: ["expires_at"] });
    expect(parseRelayFrame(joined({ expires_at: undefined }))).toMatchObject({ ok: false, fields: ["expires_at"] });
    expect(parseRelayFrame(joined({ peer_present: 1 }))).toMatchObject({ ok: false, fields: ["peer_present"] });
    expect(parseRelayFrame(joined({ buffered: -1 }))).toMatchObject({ ok: false, fields: ["buffered"] });
    expect(parseRelayFrame('{"t":"peer_left","reason":"bored"}')).toMatchObject({ ok: false, fields: ["reason"] });
    expect(parseRelayFrame('{"t":"error","code":"<script>"}')).toMatchObject({ ok: false, fields: ["code"] });
    expect(parseRelayFrame(JSON.stringify({ t: "error", code: "x".repeat(33) }))).toMatchObject({ ok: false, fields: ["code"] });
  });

  it("refuses text that is not a JSON object with a string t, naming no relay-chosen text", () => {
    for (const text of ["not json", "[]", "null", "7", '"joined"', "{}", '{"t":7}']) {
      expect(parseRelayFrame(text)).toEqual({ ok: false, reason: "invalid", t: null, fields: [] });
    }
  });
});
