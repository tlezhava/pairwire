#!/bin/sh
# pairwire hook wrapper (specs/04-client.md section 6). POSIX sh so the "hooks never fail the
# harness" rule holds even without Node:
#   1. no room on this machine (no "active" flag): exit 0 without starting Node;
#   2. Node missing or older than 20: tell the human once what to install, exit 0;
#   3. otherwise run the bundled client.
event="$1"
home="${PAIRWIRE_HOME:-$HOME/.pairwire}"
[ -e "$home/active" ] || exit 0

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd) || exit 0

version=$(node --version 2>/dev/null) || version=""
major=${version#v}
major=${major%%.*}
case "$major" in '' | *[!0-9]*) major=0 ;; esac

if [ "$major" -lt 20 ]; then
  # SessionStart output isn't shown to the human (S1b) and the waiter's stdout is unused.
  case "$event" in session-start | stop-wait) exit 0 ;; esac
  marker="$home/hook-node-warned"
  [ -e "$marker" ] && exit 0
  : >"$marker" 2>/dev/null
  if [ -z "$version" ]; then
    have="Node.js was not found"
  else
    have="Node $version is installed"
  fi
  printf '{"systemMessage":"pairwire: %s, but pairwire needs Node 20 or newer. Install the current LTS from https://nodejs.org, then restart this session."}\n' "$have"
  exit 0
fi

exec node "$root/dist/pairwire.mjs" hook "$event"
