---
description: "S8: like say, but the model may not invoke it"
argument-hint: "<text>"
allowed-tools: Bash(node:*)
disable-model-invocation: true
---
!`node "${CLAUDE_PLUGIN_ROOT}/record.mjs" say-dmi "$ARGUMENTS"`

Quote the line above to the user exactly, then stop. Do not run anything.
