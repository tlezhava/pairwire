// Smoke test against a deployed relay (M2-6): the relay conformance suite without the
// time-based cases, plus INV-1 blindness. Opt-in, never in CI:
//   PAIRWIRE_LIVE_RELAY=pairwire-relay.tazo.workers.dev npm run test:live
import { describe, it } from "vitest";
import { relayBlindness } from "../../core/test/relay-conformance/blindness.js";
import { relayConformance } from "../../core/test/relay-conformance/suite.js";
import { relayAt } from "./ws-relay.js";

const host = process.env.PAIRWIRE_LIVE_RELAY;

if (host) {
  const secure = !/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host);
  relayConformance(`live ${host}`, async () => relayAt(host, secure), { fakeClock: false });
  relayBlindness(`live ${host}`, async () => relayAt(host, secure));
} else {
  describe.skip("live relay (set PAIRWIRE_LIVE_RELAY to run)", () => {
    it("is skipped", () => {});
  });
}
