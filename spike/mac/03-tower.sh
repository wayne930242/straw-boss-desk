#!/usr/bin/env bash
# In the spike's herdr: creates a base (workspace), opens the tower tab with pi, and types `/boss gui` into it.
# Mirrors pi-straw-boss src/towertab.ts: tab with STRAW_BOSS_ROLE=tower, then `herdr agent start --kind pi`.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -n "${SPIKE_CLEAN:-}" ] || exec "$here/run.sh" "$0" "$@"
# shellcheck source=env.sh
. "$here/env.sh"
# shellcheck source=_isolated.sh
. "$here/_isolated.sh"
base="$SPIKE/work/base"; mkdir -p "$base"
j() { node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8")); const r=d.result; console.log(eval(process.argv[1]))' "$1"; }

for _ in $(seq 1 50); do [ -S "$HERDR_SOCKET_PATH" ] && break; sleep 0.2; done
[ -S "$HERDR_SOCKET_PATH" ] || { echo "spike herdr is not running"; exit 1; }

ws="$(herdr workspace list | j 'r.workspaces.filter(w=>w.label==="spike-base").map(w=>w.workspace_id)[0]||""')"
if [ -z "$ws" ]; then
  ws="$(herdr workspace create --cwd "$base" --label spike-base --no-focus | j 'r.workspace.workspace_id')"
fi
[ -n "$ws" ] || exit 1
tab="$(herdr tab create --workspace "$ws" --label tower --cwd "$base" --no-focus --env STRAW_BOSS_ROLE=tower)"
pane="$(printf '%s' "$tab" | j 'r.root_pane.pane_id')"
[ -n "$pane" ] || exit 1
echo "workspace=$ws tower pane=$pane"
start=$SECONDS
# TOWER_OPEN=arg passes `/boss gui` as pi's first message instead of typing it into the pane afterwards.
args=(--name tower); [ "${TOWER_OPEN:-type}" != arg ] || args+=("/boss gui")
herdr agent start "tower-$(printf '%s' "$ws" | tr '[:upper:]' '[:lower:]')" --kind pi --pane "$pane" --timeout 60000 -- "${args[@]}"
echo "TIMING pi start $((SECONDS - start))s"
echo "$pane" > "$SPIKE/run/tower.pane"
gui="$PI_CODING_AGENT_DIR/straw-boss/gui.json"
if [ "${TOWER_OPEN:-type}" = arg ]; then
  for _ in $(seq 1 40); do [ -s "$gui" ] && break; sleep 0.5; done
  [ -s "$gui" ] || { echo "gui.json did not appear (TOWER_OPEN=arg)"; exit 1; }
  echo "TIMING gui.json $((SECONDS - start))s"; cat "$SPIKE/run/opened-urls.txt" 2>/dev/null || echo "(no open call recorded)"; exit 0
fi
# Typed input: the default way to make a tower open the GUI (see docs/spikes/mac.md).
herdr pane send-text "$pane" "/boss gui"
# The first Enter after the text only closes pi's slash-command menu, so Enter is sent again until the GUI answers.
for _ in $(seq 1 10); do
  sleep 1; herdr pane send-keys "$pane" enter >/dev/null
  for _ in 1 2 3 4; do [ -s "$gui" ] && break 2; sleep 0.5; done
done
[ -s "$gui" ] || { echo "gui.json did not appear"; exit 1; }
echo "TIMING gui.json $((SECONDS - start))s"
cat "$SPIKE/run/opened-urls.txt" 2>/dev/null || echo "(no open call recorded)"
