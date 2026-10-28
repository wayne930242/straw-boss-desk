#!/usr/bin/env bash
# Tower stopgap, to run AFTER 03-up.sh printed the URL (until pi-straw-boss B7's `up --dir` makes the tower): reuses the tower herdr restored, else creates a base
# (workspace) with a tower tab and starts pi in it. No `/boss gui` is typed: `up` already serves the GUI. Mirrors pi-straw-boss src/towertab.ts: a tab with
# STRAW_BOSS_ROLE=tower, then `herdr agent start --kind pi`. Records the tower pane in $SPIKE/run/tower.pane.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -n "${SPIKE_CLEAN:-}" ] || exec "$here/run.sh" "$0" "$@"
# shellcheck source=env.sh
. "$here/env.sh"
# shellcheck source=_isolated.sh
. "$here/_isolated.sh"
# shellcheck source=_proc.sh
. "$here/_proc.sh"
base="$SPIKE/work/base"; mkdir -p "$base"
j() { node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8")); const r=d.result; console.log(eval(process.argv[1]))' "$1"; }
# The herdr tree, for 99-stop.sh to verify nothing of the spike's is left (recorded with start times).
snapshot() { local hp; hp="$(cat "$SPIKE/run/herdr.pid" 2>/dev/null || true)"; if [ -n "$hp" ]; then proc_tree "$hp" > "$SPIKE/run/tree.txt"; fi; }
towers() { herdr agent list | j '(r.agents||[]).filter(a=>a.tokens&&a.tokens.sb_role==="tower").map(a=>a.pane_id).join(" ")'; }

for _ in $(seq 1 50); do [ -S "$HERDR_SOCKET_PATH" ] && break; sleep 0.2; done
[ -S "$HERDR_SOCKET_PATH" ] || { echo "spike herdr is not running"; exit 1; }

# herdr restores workspaces after a restart and, when a pane's pi has a session file, resumes it with its role. This spike's tower never completes a turn (no session
# file is written), so after a stop and start its pane comes back as a plain shell and a new tower tab is added; the wait for a resumed one is short for that reason.
# (Whether the Windows kit's real pi sessions resume is the plan's A2.)
have="$(herdr workspace list | j 'r.workspaces.length')"
if [ "$have" != "0" ]; then
  for _ in $(seq 1 "${RESTORE_TIMEOUT:-8}"); do [ -n "$(towers)" ] && break; sleep 1; done
  restored="$(towers)"
  if [ -n "$restored" ]; then
    echo "tower reused: ${restored%% *}"
    echo "${restored%% *}" > "$SPIKE/run/tower.pane"
    snapshot
    exit 0
  fi
fi
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
herdr agent start "tower-$(printf '%s' "$ws" | tr '[:upper:]' '[:lower:]')" --kind pi --pane "$pane" --timeout 60000 -- --name tower
echo "TIMING pi start $((SECONDS - start))s"
echo "$pane" > "$SPIKE/run/tower.pane"
snapshot
