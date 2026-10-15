---
description: "S8: record text via ! (allowed-tools set)"
argument-hint: "<text>"
allowed-tools: Bash(node:*)
---
!`node "${CLAUDE_PLUGIN_ROOT}/record.mjs" say "$ARGUMENTS"`

The line above was produced by a shell command that ran before you saw this prompt. Quote that line to the user exactly, then stop. Do not run anything.
