---
description: Start a pairwire room and get a share string for your collaborator
argument-hint: "[display name]"
---
Call the pairwire `start` tool (pass "$ARGUMENTS" as `name` if it is not empty).
Show the returned share string to the user once, in a code block, and tell them to send it
to their collaborator over a channel they trust (Slack DM, Signal, in person). Do not
repeat the share string anywhere else, and never send it through pairwire.
Then tell the user you'll let them know when their collaborator joins.
