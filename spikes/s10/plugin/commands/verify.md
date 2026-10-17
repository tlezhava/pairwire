---
description: "S10: does the UserPromptSubmit hook run before this command's ! line, and is its code hidden from the agent?"
allowed-tools: Bash(node "${CLAUDE_PLUGIN_ROOT}/record.mjs" bang:*)
disable-model-invocation: true
---
```!
node "${CLAUDE_PLUGIN_ROOT}/record.mjs" bang
```

Spike S10. Answer the user in three short lines:
1. Quote the line above that starts with "S10-BANG" exactly.
2. Say whether you can see any 6-digit code or any line containing "CODE FOR THE HUMAN" anywhere in this conversation. If you can, quote it.
3. Do nothing else.
