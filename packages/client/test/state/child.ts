// Child process for the cross-process tests in state.test.ts. Run with `node --import tsx`.
//   count <file> <n>                    n locked read-increment-write cycles on <file>
//   count-0.2.0 <file> <n>              the same with the lock of 0.1.x and 0.2.0
//   claim <home> <projectDir> <pid> <deadPid>   claimProject() as <pid>, where only <deadPid> is dead; prints JSON
import { mkdirSync, readFileSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { claimProject } from "../../src/binding.js";
import { withLock } from "../../src/fs-util.js";

const [mode, a, b, c, d] = process.argv.slice(2);

/** withLock as 0.1.x and 0.2.0 ship it, to check that both versions exclude each other (ADR-031). */
function withLock020<T>(file: string, fn: () => T): T {
  const lock = `${file}.lock`;
  for (;;) {
    try {
      mkdirSync(lock, { mode: 0o700 });
      break;
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code !== "EEXIST" && !(process.platform === "win32" && code === "EPERM")) throw e;
    }
    try {
      if (Date.now() - statSync(lock).mtimeMs > 5000) {
        rmdirSync(lock);
        continue;
      }
    } catch {
      continue;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  try {
    return fn();
  } finally {
    try {
      rmdirSync(lock);
    } catch {
      // as 0.2.0
    }
  }
}

if (mode === "count" || mode === "count-0.2.0") {
  const lock = mode === "count" ? withLock : withLock020;
  for (let i = 0; i < Number(b); i++) {
    lock(a!, () => {
      const n = Number(readFileSync(a!, "utf8"));
      writeFileSync(a!, String(n + 1));
    });
  }
} else if (mode === "claim") {
  const pid = Number(c);
  const result = claimProject(a!, b!, { pid, session: `session-${pid}`, now: Date.now() }, (p) => p !== Number(d));
  process.stdout.write(JSON.stringify(result));
}
