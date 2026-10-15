#!/bin/sh
# Prototype of the 04 §6 hooks/run.sh wrapper.
[ -f "${PAIRWIRE_HOME:-$HOME/.pairwire}/active" ] || exit 0
command -v node >/dev/null 2>&1 || { printf '%s' '{"systemMessage":"pairwire needs Node.js 20 or newer"}'; exit 0; }
exec node "$(dirname "$0")/noop.mjs"
