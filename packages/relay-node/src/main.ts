// Entry point: `node dist/main.js` (Docker) or `npm run relay:node` (development).
import { readFileSync } from "node:fs";
import { capsFromEnv, type RelayCaps } from "./caps.js";
import { createLogger } from "./log.js";
import { createRelayServer } from "./server.js";
import { openSqliteStore, parseStateSetting, type RoomStore } from "./store.js";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
const log = createLogger();
const port = Number(process.env.PORT ?? 8787);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  log.warn("bad_port", { message: "PORT must be an integer from 0 to 65535" });
  process.exit(1);
}
let caps: Partial<RelayCaps>;
try {
  caps = capsFromEnv(process.env);
} catch (err) {
  log.warn("bad_limit", { message: err instanceof Error ? err.message : String(err) });
  process.exit(1);
}
let store: RoomStore | undefined;
try {
  const setting = parseStateSetting(process.env.PAIRWIRE_RELAY_STATE);
  if (setting.kind === "sqlite") store = openSqliteStore(setting.path);
} catch (err) {
  // Never fall back to memory: the operator asked for state that survives restarts (03).
  log.warn("bad_state", { message: err instanceof Error ? err.message : String(err) });
  process.exit(1);
}

const server = createRelayServer({ port, host: process.env.HOST ?? "0.0.0.0", log, version, caps, ...(store && { store }) });
await server.listen();
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void server.close().then(() => {
      store?.close();
      process.exit(0);
    });
  });
}
