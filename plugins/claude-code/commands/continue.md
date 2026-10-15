---
description: Let your agent keep exchanging messages after the hop budget is reached
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/dist/pairwire.mjs" ctl continue:*)
disable-model-invocation: true
---
```!
node "${CLAUDE_PLUGIN_ROOT}/dist/pairwire.mjs" ctl continue
```

The output above comes from pairwire. Tell the user in one sentence what it says.
