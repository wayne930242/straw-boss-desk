#!/usr/bin/env bash
# macOS account checks (docs/specs/2026-11-01 design: ~/.local/share/sbd-review/mac-account/design.md, option 1b): each check process gets its own
# temporary HOME, and with it its own login keychain, so the boss's gh/glab logins and keychain are never opened.
# Runs account-check.mjs in the clean environment of run.sh, with SPIKE=/tmp/sbd-macacct.
#   spike/mac/account-check.sh <command> [options]    (commands and options: see the top of account-check.mjs)
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
node=${SBD_NODE:-$(command -v node)}
[ -x "$node" ] || { echo "node not found; set SBD_NODE"; exit 1; }
SPIKE=${SPIKE:-/tmp/sbd-macacct}
[ "$SPIKE" = /tmp/sbd-macacct ] || { echo "refusing: SPIKE must be /tmp/sbd-macacct"; exit 1; }
export SPIKE
exec "$here/run.sh" "$node" "$here/account-check.mjs" "$@"
