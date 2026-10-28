#!/usr/bin/env bash
# Stops only what the spike started, in the desk B7 plan's stop order, by the pids AND start times it recorded (run/herdr.pid+start, run/sb.pid+start, run/tree.txt):
#   1. `cli.mjs stop` (45 s). It marks the server stopped on purpose, so a pi session's look does not start a new one while herdr shuts down.
#      Exit 0 done; 1 (busy lock, unreachable, scope, exit-timeout) goes on to 2; 3 (acl) is reported; 5 (a `serve` server) is reported and NOT killed.
#   2. wait 10 s for the sb server pid to go; one that stays is killed only while its recorded start time matches.
#   3. `herdr server stop`, then wait for its pid. Workspaces are not closed: herdr restores them at the next start.
#   4. kill what is left of the recorded tree (same start time); the pi-intercom broker only when broker.pid in THIS agent dir names a live node process.
#   5. gui.json and server.json stay (the server owns them); the run files go. Exit 1 when a recorded process still runs.
# The Electron window (05) is not stopped here: stop its monitor first.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -n "${SPIKE_CLEAN:-}" ] || exec "$here/run.sh" "$0" "$@"
# shellcheck source=env.sh
. "$here/env.sh"
# shellcheck source=_isolated.sh
. "$here/_isolated.sh"
# shellcheck source=_proc.sh
. "$here/_proc.sh"
cli="$PI_CODING_AGENT_DIR/npm/node_modules/pi-straw-boss/dist/server/cli.mjs"
run="$SPIKE/run"
slurp() { if [ -s "$1" ]; then cat "$1"; fi; }
herdr_pid="$(slurp "$run/herdr.pid")"; herdr_start="$(slurp "$run/herdr.start")"
sb_pid="$(slurp "$run/sb.pid")"; sb_start="$(slurp "$run/sb.start")"
[ -n "$herdr_pid$sb_pid" ] || { echo "nothing recorded; nothing to stop"; exit 0; }
# The server may have restarted since 03-up.sh recorded it (a restart, an upgrade, a crash and a new start): the record in its own folder names the one that runs now.
cur="$(node -e 'try { console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).pid || ""); } catch { console.log(""); }' "$PI_CODING_AGENT_DIR/straw-boss/server.json")"
if [ -n "$cur" ] && [ "$cur" != "$sb_pid" ] && proc_alive "$cur"; then sb_pid="$cur"; sb_start="$(proc_start "$cur")"; fi

# Runs a command for at most N seconds; 124 when it had to be killed.
bounded() {
  local secs=$1 pid i=0
  shift
  "$@" & pid=$!
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$i" -ge $((secs * 10)) ]; then kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; return 124; fi
    sleep 0.1; i=$((i + 1))
  done
  wait "$pid"
}
wait_gone() { # pid start seconds
  local i
  for i in $(seq 1 $(($3 * 2))); do proc_alive "$1" "$2" || return 0; sleep 0.5; done
  ! proc_alive "$1" "$2"
}
say() { echo "[stop] $*"; }

# The herdr tree is read while herdr is up: panes opened after the start (members) are the spike's too.
tree="$run/tree.txt"
if [ -n "$herdr_pid" ] && proc_alive "$herdr_pid" "$herdr_start"; then proc_tree "$herdr_pid" >> "$tree"; fi

killsb=1
if [ -f "$cli" ] && [ -n "$sb_pid" ]; then
  began=$SECONDS
  rc=0
  bounded 45 node "$cli" stop > "$run/stop.out" 2> "$run/stop.err" || rc=$?
  outcome="$(sed -n 's/.*"outcome":"\([^"]*\)".*/\1/p' "$run/stop.out" | tail -n 1)"
  why="$(grep -v '^Stopping the sb server on purpose' "$run/stop.err" | tail -n 1 | cut -c1-300 || true)"
  say "cli.mjs stop exit $rc outcome=${outcome:-none} ($((SECONDS - began)) s) ${why}"
  case "$rc" in
    5) killsb=0; echo "REPORT: the sb server is a serve server (a supervisor's); not stopped";;
    3) echo "REPORT: cli.mjs stop was refused (acl): $why";;
    0) ;;
    *) echo "REPORT: cli.mjs stop exit $rc: $why";;
  esac
fi
if [ -n "$sb_pid" ]; then
  wait_gone "$sb_pid" "$sb_start" 10 || true
  if [ "$killsb" = 1 ] && proc_alive "$sb_pid" "$sb_start"; then say "sb server $sb_pid ignored stop: killed by pid and start time"; kill "$sb_pid" 2>/dev/null || true; sleep 1; fi
fi

if [ -n "$herdr_pid" ] && proc_alive "$herdr_pid" "$herdr_start"; then
  rc=0; bounded 30 herdr server stop > "$run/herdr-stop.out" 2>&1 || rc=$?
  say "herdr server stop exit $rc"
  wait_gone "$herdr_pid" "$herdr_start" 10 || true
fi

# What is left of the recorded set, with the same start time, is the spike's and goes now.
leftovers() {
  [ -s "$tree" ] || return 0
  local p s
  while IFS='|' read -r p s; do
    [ -n "$p" ] || continue
    if proc_alive "$p" "$s"; then echo "$p"; fi
  done < "$tree" | sort -un
}
left=""
for p in $(leftovers); do kill "$p" 2>/dev/null || true; left="$left $p"; done
if [ -n "$left" ]; then sleep 1; for p in $(leftovers); do kill -9 "$p" 2>/dev/null || true; done; fi
if [ -n "$herdr_pid" ] && proc_alive "$herdr_pid" "$herdr_start"; then kill "$herdr_pid" 2>/dev/null || true; left="$left $herdr_pid(herdr)"; sleep 1; fi
# pi-intercom's broker is detached from the pi that spawned it and outlives the stack. Its pid file is in this spike's agent dir, so the pid is the spike's;
# it is stopped only while that pid is a node process (comm), never by name search.
bpf="$PI_CODING_AGENT_DIR/intercom/broker.pid"
if [ -s "$bpf" ]; then
  bp="$(tr -d '[:space:]' < "$bpf")"
  case "$bp" in
    ''|*[!0-9]*) ;;
    *) if [ "$(basename "$(ps -o comm= -p "$bp" 2>/dev/null || true)")" = node ]; then kill "$bp" 2>/dev/null || true; left="$left $bp(intercom-broker)"; sleep 1; fi;;
  esac
fi
if [ -n "$left" ]; then say "force-killed:$left"; fi

still=""
if [ -n "$sb_pid" ] && proc_alive "$sb_pid" "$sb_start"; then still="$still $sb_pid(sb-server)"; fi
if [ -n "$herdr_pid" ] && proc_alive "$herdr_pid" "$herdr_start"; then still="$still $herdr_pid(herdr)"; fi
for p in $(leftovers); do still="$still $p"; done
if [ -z "$still" ]; then
  if [ -n "$herdr_pid" ]; then rm -f "$HERDR_SOCKET_PATH"; fi
  rm -f "$run/sb.pid" "$run/sb.start" "$run/herdr.pid" "$run/herdr.start" "$run/tower.pane" "$tree" "$run/stop.out" "$run/stop.err" "$run/herdr-stop.out" "$run/up.err" "$run/pane-env.txt"
  echo "stopped"
else
  echo "STILL RUNNING:$still"
  exit 1
fi
