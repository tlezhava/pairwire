// Placeholder for npm scripts listed in CLAUDE.md whose implementation lands in a later task.
const [script, task] = process.argv.slice(2);
process.stderr.write(`npm run ${script} is not implemented yet (arrives with task ${task} in specs/tasks.md).\n`);
process.exit(1);
