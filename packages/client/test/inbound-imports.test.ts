// INV-2 static check over the import graph (07-testing.md, client and e2e).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkInboundImports, INBOUND_MODULES } from "../../../scripts/inbound-imports.js";
import { tempDir } from "./state/helpers.js";

describe("inbound path imports", () => {
  it("INV-2 inbound path modules never reach child_process, vm, worker_threads or the config/command modules", () => {
    const root = fileURLToPath(new URL("../../..", import.meta.url));
    expect(checkInboundImports(root)).toEqual([]);
  });

  it("catches a forbidden import reached indirectly", () => {
    const root = tempDir();
    for (const m of INBOUND_MODULES) {
      mkdirSync(join(root, m, ".."), { recursive: true });
      writeFileSync(join(root, m), "export {};\n");
    }
    writeFileSync(join(root, "packages/client/src/transcript.ts"), 'import { x } from "./helper.js";\n');
    writeFileSync(join(root, "packages/client/src/helper.ts"), 'import { spawn } from "node:child_process";\nimport "./config.js";\n');
    writeFileSync(join(root, "packages/client/src/config.ts"), "export {};\n");
    const v = checkInboundImports(root);
    expect(v.map((x) => x.forbidden).sort()).toEqual(["node:child_process", "packages/client/src/config.ts"]);
    expect(v[0]!.chain).toContain("packages/client/src/transcript.ts");
  });
});
