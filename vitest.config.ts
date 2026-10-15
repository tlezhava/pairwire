import { fileURLToPath } from "node:url";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Workspace packages resolve to their TypeScript sources through the "source" export
// condition, so tests never depend on a prior build.
const conditions = ["source", "module", "node", "import", "default"];
const workerConditions = ["source", "workerd", "worker", "browser", "module", "import", "default"];

export default defineConfig({
  resolve: { conditions },
  ssr: { resolve: { conditions, externalConditions: conditions } },
  test: {
    passWithNoTests: true,
    projects: [
      ...["core", "relay-node", "client"].map((name) => ({
        extends: true,
        test: { name, root: `packages/${name}`, include: ["test/**/*.test.ts"] },
      })),
      {
        // Runs inside workerd (Miniflare) with the Durable Object from wrangler.toml.
        plugins: [
          cloudflareTest({
            wrangler: { configPath: fileURLToPath(new URL("packages/relay-worker/wrangler.toml", import.meta.url)) },
          }),
        ],
        resolve: { conditions: workerConditions },
        ssr: { resolve: { conditions: workerConditions, externalConditions: workerConditions } },
        test: { name: "relay-worker", root: "packages/relay-worker", include: ["test/**/*.test.ts"] },
      },
      { extends: true, test: { name: "scripts", root: "scripts", include: ["test/**/*.test.ts"] } },
      // Real `pairwire mcp` processes against a relay-node (npm run test:e2e).
      { extends: true, test: { name: "e2e", root: "tests/e2e", include: ["**/*.test.ts"], testTimeout: 60_000, hookTimeout: 30_000 } },
    ],
  },
});
