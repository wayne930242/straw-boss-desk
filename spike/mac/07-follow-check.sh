#!/usr/bin/env bash
# M2 without a screen: the shared Follower follows the spike's real sb server through restart, kill and stop (follow-check.mjs). Needs the spike's herdr (02, under
# MonitorCreate) and the sb server (03-up.sh); leaves the sb server running again at the end (the Start step), so run 99-stop.sh afterwards. Starts no window.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -n "${SPIKE_CLEAN:-}" ] || exec "$here/run.sh" "$0" "$@"
# shellcheck source=env.sh
. "$here/env.sh"
# shellcheck source=_isolated.sh
. "$here/_isolated.sh"
[ -S "$HERDR_SOCKET_PATH" ] || { echo "the spike's herdr is not running (start 02-herdr-server.sh under MonitorCreate)"; exit 1; }
exec node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON "$here/follow-check.mjs"
