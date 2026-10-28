#!/usr/bin/env bash
# Task 1 acceptance on macOS: a pane of the spike's herdr sees the same STRAW_BOSS_DESK, XDG_CONFIG_HOME, HERDR_SOCKET_PATH and PI_CODING_AGENT_DIR as the server
# (the variables decide the slot, so a pi in a pane that sees others would start a second server). Opens a scratch workspace, has its shell write the four values
# to a file, compares, and closes the workspace. Needs the spike's herdr (02) running.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -n "${SPIKE_CLEAN:-}" ] || exec "$here/run.sh" "$0" "$@"
# shellcheck source=env.sh
. "$here/env.sh"
# shellcheck source=_isolated.sh
. "$here/_isolated.sh"
[ -S "$HERDR_SOCKET_PATH" ] || { echo "the spike's herdr is not running (start 02-herdr-server.sh under MonitorCreate)"; exit 1; }
j() { node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8")); const r=d.result; console.log(eval(process.argv[1]))' "$1"; }
out="$SPIKE/run/pane-env.txt"; rm -f "$out"
created="$(herdr workspace create --cwd "$SPIKE/work" --label env-check --no-focus)"
ws="$(printf '%s' "$created" | j 'r.workspace.workspace_id')"
pane="$(printf '%s' "$created" | j 'r.root_pane.pane_id')"
sleep 1
herdr pane send-text "$pane" "printf '%s\n' \"\$STRAW_BOSS_DESK\" \"\$XDG_CONFIG_HOME\" \"\$HERDR_SOCKET_PATH\" \"\$PI_CODING_AGENT_DIR\" > '$out'"
herdr pane send-keys "$pane" enter >/dev/null
for _ in $(seq 1 30); do [ -s "$out" ] && break; sleep 0.5; done
herdr workspace close "$ws" >/dev/null 2>&1 || true
[ -s "$out" ] || { echo "FAIL pane-env - the pane wrote nothing"; exit 1; }
want="$(printf '%s\n' "$STRAW_BOSS_DESK" "$XDG_CONFIG_HOME" "$HERDR_SOCKET_PATH" "$PI_CODING_AGENT_DIR")"
if [ "$(cat "$out")" = "$want" ]; then echo "PASS pane-env - the pane sees the server's STRAW_BOSS_DESK, XDG_CONFIG_HOME, HERDR_SOCKET_PATH and PI_CODING_AGENT_DIR"; else echo "FAIL pane-env - differs:"; diff <(printf '%s\n' "$want") "$out" || true; exit 1; fi
