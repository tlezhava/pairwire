// Fails if a tracked text file contains a literal invisible or bidi control character.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { findHidden } from "./hidden-chars.js";

const files = execFileSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter((f) => /\.(ts|js|mjs|json|md|sh|yml)$/.test(f));

let failed = false;
for (const file of files) {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue; // deleted in the working tree
  }
  for (const hit of findHidden(text)) {
    console.error(`${file}:${hit.line}: literal ${hit.codePoint}; write it as a \\u escape`);
    failed = true;
  }
}
process.exit(failed ? 1 : 0);
