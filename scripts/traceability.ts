// Pure logic for scripts/check-traceability.ts (specs/07-testing.md, "Naming").

export interface Exceptions {
  /** id → step number in tests/manual/ACCEPTANCE.md */
  manual: Record<string, number>;
  /** id → milestone (e.g. "M6") the id's test is deferred to */
  deferred: Record<string, string>;
}

export interface Inputs {
  ids: string[];
  titles: string[];
  exceptions: Exceptions;
  manualSteps: Set<number>;
  completedMilestones: Set<string>;
  /** true once task M4-6 is checked: missing ids become errors */
  strict: boolean;
}

export interface Report {
  tested: string[];
  manual: string[];
  deferred: string[];
  missing: string[];
  warnings: string[];
  errors: string[];
}

const ID = String.raw`(?:REQ|INV)-[A-Z0-9]+(?:-[A-Z0-9]+)*`;

/** Requirement and invariant ids defined (in bold) in a spec file, in document order. */
export function definedIds(markdown: string): string[] {
  const ids = [...markdown.matchAll(new RegExp(String.raw`\*\*(${ID})\b`, "g"))].map((m) => m[1]!);
  return [...new Set(ids)];
}

/** Titles of it/test/describe calls (with modifiers such as .skip or .concurrent). */
export function testTitles(source: string): string[] {
  const call = /\b(?:it|test|describe)(?:\.[A-Za-z]+)*\s*\(\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1/g;
  return [...source.matchAll(call)].map((m) => m[2]!);
}

function mentions(title: string, id: string): boolean {
  return new RegExp(String.raw`(?<![A-Za-z0-9-])${id}(?![A-Za-z0-9])`).test(title);
}

export function evaluate(input: Inputs): Report {
  const { ids, titles, exceptions, strict } = input;
  const known = new Set(ids);
  const report: Report = { tested: [], manual: [], deferred: [], missing: [], warnings: [], errors: [] };

  for (const id of [...Object.keys(exceptions.manual), ...Object.keys(exceptions.deferred)]) {
    if (!known.has(id)) report.errors.push(`tests/traceability.json lists unknown id ${id}`);
  }
  for (const id of Object.keys(exceptions.manual)) {
    if (id in exceptions.deferred) report.errors.push(`${id} is listed as both manual and deferred`);
  }

  for (const id of ids) {
    if (titles.some((t) => mentions(t, id))) {
      report.tested.push(id);
      continue;
    }
    const step = exceptions.manual[id];
    if (step !== undefined) {
      report.manual.push(id);
      if (!input.manualSteps.has(step)) {
        report.errors.push(`${id} is marked manual, but tests/manual/ACCEPTANCE.md has no step ${step}`);
      }
      continue;
    }
    const milestone = exceptions.deferred[id];
    if (milestone !== undefined) {
      report.deferred.push(id);
      if (input.completedMilestones.has(milestone)) {
        report.errors.push(`${id} was deferred to ${milestone}, which is complete; it needs a test now`);
      }
      continue;
    }
    report.missing.push(id);
    (strict ? report.errors : report.warnings).push(`${id} has no test`);
  }
  return report;
}

function sections(tasksMd: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let current: string[] | undefined;
  for (const line of tasksMd.split("\n")) {
    const heading = line.match(/^##\s+(M\d+)\b/);
    if (heading) {
      current = [];
      out.set(heading[1]!, current);
    } else if (/^##\s/.test(line)) {
      current = undefined;
    } else if (current && /^- \[[ xX]\]/.test(line)) {
      current.push(line);
    }
  }
  return out;
}

export function isTaskChecked(tasksMd: string, taskId: string): boolean {
  return tasksMd.split("\n").some((l) => new RegExp(String.raw`^- \[[xX]\] \*\*${taskId}\b`).test(l));
}

export function isMilestoneComplete(tasksMd: string, milestone: string): boolean {
  const items = sections(tasksMd).get(milestone);
  return !!items && items.length > 0 && items.every((l) => /^- \[[xX]\]/.test(l));
}

export function completedMilestones(tasksMd: string): Set<string> {
  return new Set([...sections(tasksMd).keys()].filter((m) => isMilestoneComplete(tasksMd, m)));
}

/** Top-level numbered steps ("1. ...") in tests/manual/ACCEPTANCE.md. */
export function manualSteps(markdown: string): Set<number> {
  return new Set([...markdown.matchAll(/^(\d+)\.\s/gm)].map((m) => Number(m[1])));
}
