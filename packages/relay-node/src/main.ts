// Entry point: `node dist/main.js` (Docker) or `npm run relay:node` (development).
import { readFileSync } from "node:fs";
import { createLogger } from "./log.js";
import { createRelayServer } from "./server.js";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
const log = createLogger();
const port = Number(process.env.PORT ?? 8787);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  log.warn("bad_port", { message: "PORT must be an integer from 0 to 65535" });
  process.exit(1);
}
if (process.env.PAIRWIRE_RELAY_STATE) {
  log.warn("state_ignored", { message: "PAIRWIRE_RELAY_STATE is not supported yet (M7); keeping state in memory" });
}

const server = createRelayServer({ port, host: process.env.HOST ?? "0.0.0.0", log, version });
await server.listen();
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void server.close().then(() => process.exit(0));
  });
}
