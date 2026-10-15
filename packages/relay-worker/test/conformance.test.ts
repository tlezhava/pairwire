import { relayConformance } from "../../core/test/relay-conformance/suite.js";
import { workerRelay } from "./worker-relay.js";

relayConformance("relay-worker", async () => workerRelay(), { fakeClock: false });
