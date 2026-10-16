import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { relayBlindness } from "../../core/test/relay-conformance/blindness.js";
import { relayConformance } from "../../core/test/relay-conformance/suite.js";
import { openSqliteStore } from "../src/store.js";
import { startNodeRelay } from "./ws-relay.js";

relayConformance("relay-node", () => startNodeRelay(), { fakeClock: true });
relayBlindness("relay-node", () => startNodeRelay());

// The same suite with SQLite state (03, Persistence), where node:sqlite exists (Node 22.13+).
if (process.getBuiltinModule?.("node:sqlite")) {
  relayConformance(
    "relay-node (sqlite)",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "pairwire-relay-"));
      const store = openSqliteStore(join(dir, "relay.db"));
      const relay = await startNodeRelay(() => {}, { store });
      return {
        ...relay,
        async close() {
          await relay.close();
          store.close();
          rmSync(dir, { recursive: true, force: true });
        },
      };
    },
    { fakeClock: true },
  );
}
