import { builtinModules } from "node:module";
import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig(
  { ignores: ["**/dist/**", "**/node_modules/**", "spikes/**"] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ["**/*.js", "**/*.mjs"],
    languageOptions: { globals: { process: "readonly", console: "readonly" } },
  },
  {
    // No console.log in library code: use the redacting loggers (CLAUDE.md).
    files: ["packages/*/src/**/*.ts"],
    rules: { "no-console": "error" },
  },
  {
    // packages/core must stay isomorphic: it runs in Node and in Cloudflare Workers.
    files: ["packages/core/src/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["node:*", ...builtinModules],
              message: "packages/core must stay isomorphic: no Node built-ins.",
            },
          ],
        },
      ],
      "no-restricted-globals": [
        "error",
        { name: "process", message: "packages/core must stay isomorphic." },
        { name: "Buffer", message: "packages/core must stay isomorphic: use Uint8Array." },
      ],
    },
  },
);
