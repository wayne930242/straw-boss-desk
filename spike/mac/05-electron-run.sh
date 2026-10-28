#!/usr/bin/env bash
# Opens the spike's Electron window on the GUI of the spike's sb server and, with SBD_SHOT=<png>, captures the page and quits.
# The app runs `cli.mjs up --exact` itself (start 02-herdr-server.sh first, under MonitorCreate), so no tower is needed for the page.
# Without SBD_SHOT or SBD_SCRIPT the window stays open and follows the GUI through a restart. Start under MonitorCreate.
# Usage: SBD_SHOT=/abs/path.png 05-electron-run.sh
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -z "${SPIKE_CLEAN:-}" ]; then
  # Only these two knobs cross into the clean environment.
  exec "$here/run.sh" /usr/bin/env "SBD_SHOT=${SBD_SHOT:-}" "SBD_SCRIPT=${SBD_SCRIPT:-}" "SBD_SHOT_DELAY_MS=${SBD_SHOT_DELAY_MS:-8000}" "$0" "$@"
fi
# shellcheck source=env.sh
. "$here/env.sh"
# shellcheck source=_isolated.sh
. "$here/_isolated.sh"
# shellcheck source=_proc.sh
. "$here/_proc.sh"
[ -f "$PI_CODING_AGENT_DIR/npm/node_modules/pi-straw-boss/dist/server/cli.mjs" ] || { echo "pi-straw-boss is not installed under the spike (run 01-install.sh)"; exit 1; }
[ -S "$HERDR_SOCKET_PATH" ] || { echo "the spike's herdr is not running (start 02-herdr-server.sh under MonitorCreate)"; exit 1; }
[ -n "$SBD_SHOT" ] || unset SBD_SHOT
[ -n "$SBD_SCRIPT" ] || unset SBD_SCRIPT
export SBD_USER_DATA="$SPIKE/electron-user-data"
echo $$ > "$SPIKE/run/electron.pid"
proc_start $$ > "$SPIKE/run/electron.start"
export SBD_LOG="$SPIKE/run/electron.log" # the app also appends there: a monitor shortens long lines
exec "$SPIKE/electron-app/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron" "$SPIKE/electron-app/dist/main.js"
