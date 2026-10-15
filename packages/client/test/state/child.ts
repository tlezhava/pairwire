// Child process for the cross-process tests in state.test.ts. Run with `node --import tsx`.
//   count <file> <n>                    n locked read-increment-write cycles on <file>
//   claim <home> <projectDir> <pid> <deadPid>   claimProject() as <pid>, where only <deadPid> is dead; prints JSON
import { readFileSync, writeFileSync } from "node:fs";
import { claimProject } from "../../src/binding.js";
import { withLock } from "../../src/fs-util.js";

const [mode, a, b, c, d] = process.argv.slice(2);

if (mode === "count") {
  for (let i = 0; i < Number(b); i++) {
    withLock(a!, () => {
      const n = Number(readFileSync(a!, "utf8"));
      writeFileSync(a!, String(n + 1));
    });
  }
} else if (mode === "claim") {
  const pid = Number(c);
  const result = claimProject(a!, b!, { pid, session: `session-${pid}`, now: Date.now() }, (p) => p !== Number(d));
  process.stdout.write(JSON.stringify(result));
}
