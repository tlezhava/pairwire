---
description: Start a pairwire room and get a share string for your collaborator
argument-hint: "[display name] [for <3-8> people]"
---
Call the pairwire `start` tool. If "$ARGUMENTS" asks for a room for more than two people (for
example "for 4"), pass that number as `size`; pass any other text in "$ARGUMENTS" as `name`.
Show the returned share string to the user once, in a code block, and tell them to send it
to their collaborator over a channel they trust (Slack DM, Signal, in person). Do not
repeat the share string anywhere else, and never send it through pairwire.
Then tell the user you'll let them know when their collaborator joins.
