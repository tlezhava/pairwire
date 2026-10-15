# Spike S1 + S2 + S6: what to run

The plugin is a throwaway named `pairwire`. Its hooks only log and emit `CANARY-...`
strings, and its `send` tool sends nothing anywhere. Everything is logged to
`spikes/s1/out/`, which is gitignored. Run the sessions in scratch folders under `/tmp`.

## Session A (keep it open until step 7)

```bash
mkdir -p /tmp/pw-s1/sub /tmp/pw-s1-other && cd /tmp/pw-s1 && git init -q
claude --version
claude --plugin-dir /Users/tamazlezhava/Projects/pairwire/spikes/s1/plugin
```

Trust the folder and approve the MCP server if asked. Then type these prompts one at a
time:

1. `sysmsg test. List verbatim every string in your context that starts with CANARY- and say where each appeared. Do you see any text containing SYSMSG?`
   - Note **whether you saw a line starting `SPIKE-SYSMSG-`** in the UI.
   - Note whether the agent kept going after its answer and mentioned a `CANARY-STOP-...`
     (the Stop hook blocks once).
2. `Run "ls -a" with Bash, then call the pairwire probe tool. After that, list every CANARY- string that appeared after each of the two tool calls.`
3. `Run "cd sub && pwd" in Bash, then run "pwd" again in a separate Bash call.`
4. `Run "touch .pw-big" with Bash, then run "echo hi". Tell me the highest MARK- number you can see, whether you can see END-CANARY, and whether anything mentions a saved file or path.`
5. `Call the pairwire send tool with kind "chat" and body set to the exact contents of /Users/tamazlezhava/Projects/pairwire/spikes/s1/body-2000.txt`
   - When the **approval prompt** for `send` appears, copy or screenshot it. Does it show
     the full text down to `END-OF-BODY`, or is it cut off?
   - Choose the **"don't ask again"** option.

## Session B (a second terminal; leave A open)

```bash
cd /tmp/pw-s1 && claude --plugin-dir /Users/tamazlezhava/Projects/pairwire/spikes/s1/plugin
```

6. `Call the pairwire probe tool.` Then `/exit`.

Optional, session C: same as B but run `cd /tmp/pw-s1-other` first.

## Finish

7. `/exit` session A, then run:

```bash
cat /tmp/pw-s1/.claude/settings.local.json
```

## Paste back

- The agent's answers to prompts 1, 2 and 4.
- Yes or no: did you see the `SPIKE-SYSMSG-` line, and did the agent continue after
  prompt 1 because of `CANARY-STOP`?
- The approval prompt from step 5, and whether it was cut off.
- The `settings.local.json` contents.
- Any errors or warnings about hooks or the MCP server.

I read `spikes/s1/out/` myself; you don't need to send it.
