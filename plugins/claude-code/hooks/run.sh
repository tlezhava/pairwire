#!/bin/sh
# pairwire hook wrapper (specs/04-client.md section 6). POSIX sh so the "hooks never fail the
# harness" rule holds even without Node:
#   1. no room on this machine (no "active" flag): exit 0 without starting Node;
#   2. Node missing or older than 20: tell the human once what to install, exit 0;
#   3. otherwise run the bundled client.
# On native Windows it runs under Git Bash; OS=Windows_NT marks that case (ADR-024).
event="$1"
windows=
[ "${OS-}" = Windows_NT ] && windows=1
if [ -n "$windows" ] && [ -n "${USERPROFILE-}" ]; then
  # Node's os.homedir() reads USERPROFILE on Windows and ignores HOME.
  home="${PAIRWIRE_HOME:-$USERPROFILE/.pairwire}"
else
  home="${PAIRWIRE_HOME:-$HOME/.pairwire}"
fi
# The fast path uses builtins only.
[ -e "$home/active" ] || exit 0

if [ -n "$windows" ]; then
  # Our path may hold backslashes (it comes from CLAUDE_PLUGIN_ROOT); `pwd -W` prints C:/...,
  # a path node.exe can open without MSYS argument conversion.
  script=$(printf '%s\n' "$0" | tr '\\' '/')
  root=$(CDPATH= cd -- "$(dirname -- "$script")/.." && { pwd -W 2>/dev/null || pwd; }) || exit 0
else
  root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd) || exit 0
fi

# `node --version` costs a process start (~13 ms), so a Node binary that passed the check is
# remembered in $home/node-ok and checked again only when that binary changes (builtins only).
nodepath=$(command -v node 2>/dev/null) || nodepath=""
cached=
[ -n "$nodepath" ] && [ -f "$home/node-ok" ] && [ ! "$nodepath" -nt "$home/node-ok" ] && read -r cached <"$home/node-ok"
if [ -n "$nodepath" ] && [ "$cached" = "$nodepath" ]; then
  major=20
else
  version=$(node --version 2>/dev/null) || version=""
  major=${version#v}
  major=${major%%.*}
  case "$major" in '' | *[!0-9]*) major=0 ;; esac
  [ "$major" -ge 20 ] && printf '%s\n' "$nodepath" >"$home/node-ok" 2>/dev/null
fi

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

# The harness, for hooks that find their session by its pid (specs/04-client.md section 10).
PAIRWIRE_HOOK_PPID=$PPID
export PAIRWIRE_HOOK_PPID
exec node "$root/dist/pairwire.mjs" hook "$event"
