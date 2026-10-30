#!/usr/bin/env bash
# Shows what a pinned install says when npm's registry is down or its cached package list is old (VM 2026-10-30: E404 for a pi-straw-boss version that exists).
# Uses a stand-in registry on 127.0.0.1 and its own npm cache under $SPIKE/npm-stale; needs the spike's Node (01-install.sh) and no network.
# Prints PASS/FAIL lines; exit 1 on any FAIL.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -n "${SPIKE_CLEAN:-}" ] || exec "$here/run.sh" "$0" "$@"
# shellcheck source=env.sh
. "$here/env.sh"
[ -n "$SPIKE" ] && [ "$HOME" = "$SPIKE/home" ] || exit 1
command -v node >/dev/null || { echo "node is not installed in the spike: run 01-install.sh first"; exit 1; }
exec node "$here/npm-stale-test.mjs"
