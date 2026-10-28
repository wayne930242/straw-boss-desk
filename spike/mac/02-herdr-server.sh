#!/usr/bin/env bash
# Runs the spike's own headless herdr server in the foreground (start it under MonitorCreate). Records its PID and start time.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -n "${SPIKE_CLEAN:-}" ] || exec "$here/run.sh" "$0" "$@"
# shellcheck source=env.sh
. "$here/env.sh"
# shellcheck source=_isolated.sh
. "$here/_isolated.sh"
# shellcheck source=_proc.sh
. "$here/_proc.sh"
[ -n "$SPIKE" ] && [ "$HOME" = "$SPIKE/home" ] || exit 1
mkdir -p "$SPIKE/run" "$XDG_CONFIG_HOME/herdr"
[ ! -e "$HERDR_SOCKET_PATH" ] || { echo "socket $HERDR_SOCKET_PATH already exists"; exit 1; }
echo $$ > "$SPIKE/run/herdr.pid"
proc_start $$ > "$SPIKE/run/herdr.start"
exec herdr server
