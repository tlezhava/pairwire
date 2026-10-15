import { createReferenceRelay } from "./reference-host.js";
import { relayConformance } from "./suite.js";

relayConformance("in-memory reference host", async () => createReferenceRelay(), { fakeClock: true });
