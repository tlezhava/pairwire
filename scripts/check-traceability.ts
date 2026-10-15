// Lists every REQ-*/INV-* id without a test (specs/07-testing.md, "Naming").
// Missing ids are warnings until task M4-6 is checked in specs/tasks.md, errors after.
// Usage: npm run traceability
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  completedMilestones,
  definedIds,
  evaluate,
  isTaskChecked,
  manualSteps,
  testTitles,
  type Exceptions,
} from "./traceability.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (p: string) => readFileSync(join(root, p), "utf8");

function testFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && e.name.endsWith(".test.ts") && !e.parentPath.includes("node_modules"))
    .map((e) => join(e.parentPath, e.name));
}

// scripts/test is deliberately excluded: its fixtures contain test titles as data.
const roots = [
  ...readdirSync(join(root, "packages")).map((p) => join(root, "packages", p, "test")),
  join(root, "tests"),
];
const files = roots.flatMap(testFiles);

const ids = [...definedIds(read("specs/00-product.md")), ...definedIds(read("specs/05-security.md"))];
const tasks = read("specs/tasks.md");
const exceptions = JSON.parse(read("tests/traceability.json")) as Exceptions;
const acceptance = existsSync(join(root, "tests/manual/ACCEPTANCE.md")) ? read("tests/manual/ACCEPTANCE.md") : "";
const strict = isTaskChecked(tasks, "M4-6");

const report = evaluate({
  ids,
  titles: files.flatMap((f) => testTitles(readFileSync(f, "utf8"))),
  exceptions: { manual: exceptions.manual ?? {}, deferred: exceptions.deferred ?? {} },
  manualSteps: manualSteps(acceptance),
  completedMilestones: completedMilestones(tasks),
  strict,
});

const gha = process.env.GITHUB_ACTIONS === "true";
const out = (level: "warning" | "error", msg: string) =>
  console.log(gha ? `::${level} title=traceability::${msg}` : `${level}: ${msg}`);

console.log(
  `traceability: ${ids.length} ids, ${files.length} test files — ` +
    `${report.tested.length} tested, ${report.manual.length} manual, ${report.deferred.length} deferred, ` +
    `${report.missing.length} missing. Mode: ${strict ? "errors (M4-6 is checked)" : "warnings until M4-6"}.`,
);
for (const w of report.warnings) out("warning", w);
for (const e of report.errors) out("error", e);
process.exit(report.errors.length > 0 ? 1 : 0);
