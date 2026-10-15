---
description: Send your own words to your collaborator, marked as written by you
argument-hint: "<message>"
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/dist/pairwire.mjs" ctl say:*)
disable-model-invocation: true
---
```!
node "${CLAUDE_PLUGIN_ROOT}/dist/pairwire.mjs" ctl say <<'PAIRWIRE_SAY_END_b7e1c94d'
$ARGUMENTS
PAIRWIRE_SAY_END_b7e1c94d
```

The output above comes from pairwire, which already handled the user's message. Tell the user in one
sentence what it says. Do not send the message again and do not call any pairwire tool.
