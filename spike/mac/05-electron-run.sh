#!/usr/bin/env bash
# Opens the spike's Electron window on the GUI of the spike's tower and, with SBD_SHOT=<png>, captures the page and quits.
# Start under MonitorCreate. Usage: SBD_SHOT=/abs/path.png 05-electron-run.sh
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -z "${SPIKE_CLEAN:-}" ]; then
  # Only these two knobs cross into the clean environment.
  exec "$here/run.sh" /usr/bin/env "SBD_SHOT=${SBD_SHOT:-}" "SBD_SCRIPT=${SBD_SCRIPT:-}" "SBD_SHOT_DELAY_MS=${SBD_SHOT_DELAY_MS:-8000}" "$0" "$@"
fi
# shellcheck source=env.sh
. "$here/env.sh"
[ -s "$PI_CODING_AGENT_DIR/straw-boss/gui.json" ] || { echo "no gui.json under the spike agent dir"; exit 1; }
[ -n "$SBD_SHOT" ] || unset SBD_SHOT
[ -n "$SBD_SCRIPT" ] || unset SBD_SCRIPT
export SBD_USER_DATA="$SPIKE/electron-user-data"
echo $$ > "$SPIKE/run/electron.pid"
export SBD_LOG="$SPIKE/run/electron.log" # the app also appends there: a monitor shortens long lines
exec "$SPIKE/electron-app/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron" "$SPIKE/electron-app/dist/main.js"
