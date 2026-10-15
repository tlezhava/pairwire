// No-op hook: read stdin, exit 0 with no output (what a pairwire hook does with nothing to deliver).
process.stdin.resume();
process.stdin.on("end", () => process.exit(0));
