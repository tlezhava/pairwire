import { relayBlindness } from "./blindness.js";
import { createReferenceRelay } from "./reference-host.js";
import { relayConformance } from "./suite.js";

relayConformance("in-memory reference host", async () => createReferenceRelay(), { fakeClock: true });
relayBlindness("in-memory reference host", async () => createReferenceRelay());
