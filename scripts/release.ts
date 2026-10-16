// `npm run release -- <version>` (04 §9 Releases, ADR-021): writes one version to every place it
// lives, rebuilds the plugin bundle, runs the checks, commits and tags locally. It never pushes;
// pushing the tag starts .github/workflows/release.yml. `--check <version>` (used by that
// workflow) only verifies that every location holds the version.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

export class ReleaseError extends Error {}

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?$/;

/** A release version from the command line: `1.2.3`, `v1.2.3` or `1.2.3-rc.1` (no build metadata). */
export function parseVersion(arg: string | undefined): string {
  const v = (arg ?? "").replace(/^v/, "");
  if (!SEMVER.test(v)) throw new ReleaseError(`"${arg ?? ""}" is not a release version (expected X.Y.Z or X.Y.Z-pre, e.g. 0.1.0)`);
  return v;
}

/** Semver precedence: negative when a < b. Both must pass parseVersion. */
export function compareVersions(a: string, b: string): number {
  const split = (v: string) => {
    const dash = v.indexOf("-");
    return { nums: (dash < 0 ? v : v.slice(0, dash)).split(".").map(Number), pre: dash < 0 ? null : v.slice(dash + 1).split(".") };
  };
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < 3; i++) if (x.nums[i] !== y.nums[i]) return x.nums[i]! - y.nums[i]!;
  if (x.pre === null || y.pre === null) return (x.pre === null ? 1 : 0) - (y.pre === null ? 1 : 0);
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined || q === undefined) return p === undefined ? -1 : 1;
    if (p === q) continue;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) return Number(p) - Number(q);
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

interface Location {
  file: string;
  /** How a mismatch names it. */
  name: string;
  read(text: string): string | null;
  write(text: string, version: string): string;
}

/** The top-level "version" of a JSON manifest, rewritten in place so the formatting stays. */
function manifest(file: string): Location {
  const first = /("version"\s*:\s*)"([^"]*)"/;
  return {
    file,
    name: file,
    read: (text) => (JSON.parse(text) as { version?: string }).version ?? null,
    write(text, version) {
      const current = (JSON.parse(text) as { version?: string }).version;
      if (text.match(first)?.[2] !== current) throw new ReleaseError(`${file}: the first "version" key is not the top-level one`);
      return text.replace(first, `$1"${version}"`);
    },
  };
}

function constant(file: string, name: string): Location {
  const re = new RegExp(`(export const ${name} = )"([^"]*)";`);
  return {
    file,
    name: file,
    read: (text) => text.match(re)?.[2] ?? null,
    write(text, version) {
      if (!re.test(text)) throw new ReleaseError(`${file}: no ${name} constant`);
      return text.replace(re, `$1"${version}";`);
    },
  };
}

/** Workspace entries in package-lock.json; npm writes it as JSON.stringify(_, null, 2). */
function lockfile(key: string): Location {
  type Lock = { packages: Record<string, { version?: string }> };
  return {
    file: "package-lock.json",
    name: `package-lock.json (${key})`,
    read: (text) => (JSON.parse(text) as Lock).packages[key]?.version ?? null,
    write(text, version) {
      const lock = JSON.parse(text) as Lock;
      const entry = lock.packages[key];
      if (!entry) throw new ReleaseError(`package-lock.json: no entry for ${key}`);
      entry.version = version;
      return JSON.stringify(lock, null, 2) + "\n";
    },
  };
}

/** Every place the release version lives (01 Versioning). The first is the npm package's. */
export const LOCATIONS: readonly Location[] = [
  manifest("packages/client/package.json"),
  constant("packages/client/src/version.ts", "CLIENT_VERSION"),
  manifest("plugins/claude-code/.claude-plugin/plugin.json"),
  manifest("packages/relay-node/package.json"),
  manifest("packages/relay-worker/package.json"),
  constant("packages/relay-worker/src/version.ts", "RELAY_VERSION"),
  ...["packages/client", "packages/relay-node", "packages/relay-worker"].map(lockfile),
];

/** Each location with the version it holds now (null when it can't be found). */
export function readVersions(root: string): { location: string; version: string | null }[] {
  return LOCATIONS.map((l) => ({ location: l.name, version: l.read(readFileSync(join(root, l.file), "utf8")) }));
}

/** One line per location that doesn't hold `version`; empty when all do. */
export function checkVersions(root: string, version: string): string[] {
  return readVersions(root)
    .filter((r) => r.version !== version)
    .map((r) => `${r.location}: ${r.version ?? "no version found"}, expected ${version}`);
}

/** Writes `version` to every location; returns the files it changed. */
export function bumpVersions(root: string, version: string): string[] {
  const texts = new Map<string, string>();
  for (const l of LOCATIONS) {
    const text = texts.get(l.file) ?? readFileSync(join(root, l.file), "utf8");
    texts.set(l.file, l.write(text, version));
  }
  const changed: string[] = [];
  for (const [file, text] of texts) {
    if (readFileSync(join(root, file), "utf8") === text) continue;
    writeFileSync(join(root, file), text);
    changed.push(file);
  }
  return changed;
}

/** Runs git with the given arguments and returns its trimmed stdout. */
export type Git = (...args: string[]) => string;

/** A Git that runs in `cwd`. */
export function gitIn(cwd: string): Git {
  return (...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

const git = gitIn(ROOT);

/**
 * The checks a release makes before it changes anything (04 §9): no changes to tracked files
 * (untracked files, such as a local `.claude/`, don't count), no existing tag `v<version>`, and
 * a version greater than the npm package's current one. Throws ReleaseError on the first failure.
 */
export function preflight(version: string, root: string = ROOT, run: Git = gitIn(root)): void {
  const tag = `v${version}`;
  if (run("status", "--porcelain", "--untracked-files=no") !== "") throw new ReleaseError("The working tree has changes to tracked files; commit or discard them first.");
  if (run("tag", "--list", tag) !== "") throw new ReleaseError(`Tag ${tag} already exists.`);
  const current = readVersions(root)[0]!.version ?? "0.0.0";
  if (compareVersions(version, current) <= 0) throw new ReleaseError(`${version} is not greater than the current version ${current}.`);
}

function release(version: string): void {
  const tag = `v${version}`;
  preflight(version, ROOT, git);

  const changed = bumpVersions(ROOT, version);
  process.stdout.write(`set ${version} in ${changed.join(", ")}\n`);
  for (const script of ["build:plugin", "lint", "test", "test:e2e", "traceability"]) {
    try {
      execFileSync("npm", ["run", script], { cwd: ROOT, stdio: "inherit" });
    } catch {
      throw new ReleaseError(`npm run ${script} failed. Nothing was committed; the version changes are left in the working tree (git checkout -- . undoes them).`);
    }
  }
  const left = checkVersions(ROOT, version);
  if (left.length > 0) throw new ReleaseError(`Versions out of step after the build:\n${left.join("\n")}`);
  git("add", "--", ...changed, "plugins/claude-code");
  git("commit", "-m", `chore: release ${tag}`);
  git("tag", "-a", tag, "-m", `pairwire ${tag}`);
  process.stdout.write(
    `\nCommitted "chore: release ${tag}" and tagged ${tag}. Nothing was pushed.\n` +
      `To publish, push the commit and the tag: git push origin HEAD ${tag}\n`,
  );
}

function main(argv: string[]): number {
  try {
    if (argv[0] === "--check") {
      const version = parseVersion(argv[1]);
      const problems = checkVersions(ROOT, version);
      for (const p of problems) process.stderr.write(`${p}\n`);
      if (problems.length === 0) process.stdout.write(`every version location holds ${version}\n`);
      return problems.length === 0 ? 0 : 1;
    }
    if (argv.length !== 1) throw new ReleaseError("Usage: npm run release -- <version>   (or: tsx scripts/release.ts --check <version>)");
    release(parseVersion(argv[0]));
    return 0;
  } catch (e) {
    if (!(e instanceof ReleaseError)) throw e;
    process.stderr.write(`release: ${e.message}\n`);
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = main(process.argv.slice(2));
