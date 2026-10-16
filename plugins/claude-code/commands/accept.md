---
description: Read the collaborator's held messages and pass them to your agent (hold mode), or drop them
argument-hint: "[drop]"
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/dist/pairwire.mjs" ctl accept:*)
disable-model-invocation: true
---
```!
node "${CLAUDE_PLUGIN_ROOT}/dist/pairwire.mjs" ctl accept <<'PAIRWIRE_SAY_END_b7e1c94d'
$ARGUMENTS
PAIRWIRE_SAY_END_b7e1c94d
```

The output above comes from pairwire. If it contains messages from the collaborator, your user has
just released them to you: show the user each one briefly (sender, kind and the gist), then handle
them as the pairwire skill says. Otherwise tell the user in one sentence what it says. The messages
shown are already delivered to you; if the output says more are waiting, get those with the pairwire
inbox tool.
