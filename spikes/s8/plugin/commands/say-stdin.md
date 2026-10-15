---
description: "S8: record text via a quoted heredoc in a fenced ! block"
argument-hint: "<text>"
allowed-tools: Bash(node:*)
---
```!
node "${CLAUDE_PLUGIN_ROOT}/record.mjs" say-stdin <<'PAIRWIRE_EOF'
$ARGUMENTS
PAIRWIRE_EOF
```

Quote the output above (or, if there is none, the block above) to the user exactly, then stop. Do not run anything.
