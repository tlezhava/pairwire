import { relayConformance } from "../../core/test/relay-conformance/suite.js";
import { startNodeRelay } from "./ws-relay.js";

relayConformance("relay-node", () => startNodeRelay(), { fakeClock: true });
