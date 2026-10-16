// `npm run pack:npm` (04 §9, ADR-021): assembles the publishable `pairwire` npm package in
// build/npm/ from the committed plugin bundle. The workspace package can't be published as is
// (it depends on the private @pairwire/core), so the package is the bundle itself, in the
// plugin's layout (install --codex and --print-config look for hooks/ and skills/ next to dist/),
// with no dependencies. Nothing here publishes; the release workflow runs `npm publish`.
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Files copied from the plugin into the package, in the same place. */
export const PLUGIN_FILES = ["dist", "hooks/run.sh", "skills/pairwire/SKILL.md"] as const;

interface PluginManifest {
  description: string;
  author: { name: string };
  repository: string;
  license: string;
  keywords: string[];
}

/** The package.json of the npm package. */
export function npmManifest(version: string, plugin: PluginManifest): Record<string, unknown> {
  const repo = plugin.repository.replace(/\/$/, "");
  return {
    name: "pairwire",
    version,
    description: plugin.description,
    keywords: plugin.keywords,
    homepage: `${repo}#readme`,
    bugs: { url: `${repo}/issues` },
    repository: { type: "git", url: `git+${repo}.git` },
    license: plugin.license,
    author: plugin.author.name,
    type: "module",
    bin: { pairwire: "dist/pairwire.mjs" },
    files: ["dist", "hooks/run.sh", "skills"],
    engines: { node: ">=20" },
  };
}

/** Writes the package to `out` (replacing it) and returns its manifest. */
export function packNpm(root: string, out: string): Record<string, unknown> {
  const plugin = join(root, "plugins/claude-code");
  for (const f of PLUGIN_FILES) {
    if (!existsSync(join(plugin, f))) throw new Error(`plugins/claude-code/${f} is missing; run npm run build:plugin`);
  }
  const { version } = JSON.parse(readFileSync(join(root, "packages/client/package.json"), "utf8")) as { version: string };
  const manifest = npmManifest(version, JSON.parse(readFileSync(join(plugin, ".claude-plugin/plugin.json"), "utf8")) as PluginManifest);

  rmSync(out, { recursive: true, force: true });
  for (const f of PLUGIN_FILES) {
    mkdirSync(dirname(join(out, f)), { recursive: true });
    cpSync(join(plugin, f), join(out, f), { recursive: true });
  }
  chmodSync(join(out, "dist/pairwire.mjs"), 0o755);
  chmodSync(join(out, "hooks/run.sh"), 0o755);
  for (const f of ["README.md", "LICENSE"]) cpSync(join(root, f), join(out, f));
  writeFileSync(join(out, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const out = join(ROOT, "build/npm");
  const { version } = packNpm(ROOT, out);
  process.stdout.write(`pairwire ${String(version)} assembled in build/npm (not published)\n`);
}
