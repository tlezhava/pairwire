// Fails if an inbound-path module can reach process spawning or config writers (INV-2).
import { fileURLToPath } from "node:url";
import { checkInboundImports } from "./inbound-imports.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const violations = checkInboundImports(root);
for (const v of violations) console.error(`INV-2: ${v.from} reaches ${v.forbidden} via ${[...v.chain].join(" -> ") || "(direct)"}`);
process.exit(violations.length > 0 ? 1 : 0);
