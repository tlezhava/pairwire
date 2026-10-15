import { defineConfig } from "vitest/config";

// Workspace packages resolve to their TypeScript sources through the "source" export
// condition, so tests never depend on a prior build.
const conditions = ["source", "module", "node", "import", "default"];

export default defineConfig({
  resolve: { conditions },
  ssr: { resolve: { conditions, externalConditions: conditions } },
  test: {
    passWithNoTests: true,
    projects: [
      ...["core", "relay-node", "relay-worker", "client"].map((name) => ({
        extends: true,
        test: { name, root: `packages/${name}`, include: ["test/**/*.test.ts"] },
      })),
      { extends: true, test: { name: "scripts", root: "scripts", include: ["test/**/*.test.ts"] } },
    ],
  },
});
