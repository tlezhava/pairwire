import { describe, expect, it } from "vitest";
import {
  definedIds,
  evaluate,
  isMilestoneComplete,
  isTaskChecked,
  manualSteps,
  testTitles,
  type Inputs,
} from "../traceability.js";

describe("definedIds", () => {
  it("collects bold REQ-* and INV-* definitions in document order, without duplicates", () => {
    const md = [
      "- **REQ-ROOM-1** WHEN a user runs start ...",
      "- **INV-9 Local state is private.** ...",
      "- **REQ-X-1** Clients on different harnesses ...",
      "See REQ-ROOM-1 and INV-9 again (not definitions).",
      "- **REQ-ROOM-1** duplicated definition",
    ].join("\n");
    expect(definedIds(md)).toEqual(["REQ-ROOM-1", "INV-9", "REQ-X-1"]);
  });
});

describe("testTitles", () => {
  it("extracts titles from it/test/describe with modifiers and all quote styles", () => {
    const src = `
      describe("REQ-ROOM-4 room limits", () => {
        it('refuses a third member', () => {});
        it.skip(\`INV-1 relay blindness\`, () => {});
        test.concurrent("REQ-MSG-2: \\"quoted\\" title", () => {});
      });
      notATest("REQ-SAFE-1 should not count");
    `;
    expect(testTitles(src)).toEqual([
      "REQ-ROOM-4 room limits",
      "refuses a third member",
      "INV-1 relay blindness",
      'REQ-MSG-2: \\"quoted\\" title',
    ]);
  });
});

describe("evaluate", () => {
  const base: Inputs = {
    ids: ["REQ-ROOM-1", "REQ-ROOM-10", "INV-1", "REQ-INST-1", "REQ-X-2"],
    titles: ["REQ-ROOM-10 handles ten", "INV-1: relay never sees plaintext"],
    exceptions: { manual: { "REQ-INST-1": 1 }, deferred: { "REQ-X-2": "M6" } },
    manualSteps: new Set([1, 2]),
    completedMilestones: new Set(),
    strict: false,
  };

  it("matches ids on boundaries, so REQ-ROOM-10 does not cover REQ-ROOM-1", () => {
    const r = evaluate(base);
    expect(r.tested).toEqual(["REQ-ROOM-10", "INV-1"]);
    expect(r.missing).toEqual(["REQ-ROOM-1"]);
    expect(r.manual).toEqual(["REQ-INST-1"]);
    expect(r.deferred).toEqual(["REQ-X-2"]);
  });

  it("reports missing ids as warnings before M4-6 and as errors after", () => {
    expect(evaluate(base).errors).toEqual([]);
    expect(evaluate(base).warnings).toEqual(["REQ-ROOM-1 has no test"]);
    const strict = evaluate({ ...base, strict: true });
    expect(strict.errors).toEqual(["REQ-ROOM-1 has no test"]);
    expect(strict.warnings).toEqual([]);
  });

  it("errors when a manual entry points at a missing step in ACCEPTANCE.md", () => {
    const r = evaluate({ ...base, manualSteps: new Set([2]) });
    expect(r.errors).toContain("REQ-INST-1 is marked manual, but tests/manual/ACCEPTANCE.md has no step 1");
  });

  it("errors when a deferred id's milestone is complete", () => {
    const r = evaluate({ ...base, completedMilestones: new Set(["M6"]) });
    expect(r.errors).toContain("REQ-X-2 was deferred to M6, which is complete; it needs a test now");
  });

  it("errors on exceptions for unknown ids and on ids listed as both manual and deferred", () => {
    const r = evaluate({
      ...base,
      exceptions: { manual: { "REQ-INST-1": 1, "REQ-NOPE-1": 2 }, deferred: { "REQ-X-2": "M6", "REQ-INST-1": "M5" } },
    });
    expect(r.errors).toContain("tests/traceability.json lists unknown id REQ-NOPE-1");
    expect(r.errors).toContain("REQ-INST-1 is listed as both manual and deferred");
  });

  it("does not need an exception for an id that also has a test", () => {
    const r = evaluate({ ...base, titles: [...base.titles, "REQ-INST-1 installs in two commands"] });
    expect(r.tested).toContain("REQ-INST-1");
    expect(r.manual).toEqual([]);
  });
});

describe("tasks.md parsing", () => {
  const tasks = [
    "## M4 — Claude Code plugin",
    "- [x] **M4-5 README:** ...",
    "- [ ] **M4-6 Traceability check switches to errors;** ...",
    "## M6 — Cross-harness",
    "- [x] **S7 Codex spike:** ...",
    "- [x] Codex adapter",
    "## M7 — Hardening",
    "- [ ] Native Windows support",
  ].join("\n");

  it("finds whether a task id is checked", () => {
    expect(isTaskChecked(tasks, "M4-5")).toBe(true);
    expect(isTaskChecked(tasks, "M4-6")).toBe(false);
    expect(isTaskChecked(tasks, "M9-9")).toBe(false);
  });

  it("treats a milestone as complete only when it has tasks and all are checked", () => {
    expect(isMilestoneComplete(tasks, "M6")).toBe(true);
    expect(isMilestoneComplete(tasks, "M4")).toBe(false);
    expect(isMilestoneComplete(tasks, "M7")).toBe(false);
    expect(isMilestoneComplete(tasks, "M8")).toBe(false);
  });
});

describe("manualSteps", () => {
  it("collects top-level numbered steps", () => {
    const md = "# Acceptance\n\n1. Install\n2. Start and join\n   1. nested is ignored\n10. Ten\n";
    expect([...manualSteps(md)]).toEqual([1, 2, 10]);
  });
});
