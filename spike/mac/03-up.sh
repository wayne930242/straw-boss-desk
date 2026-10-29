#!/usr/bin/env bash
# Brings up Herdr's pi integration, the sb server, the home base with its tower, and the GUI with `cli.mjs up --dir <home base folder> --label <name> --exact` in
# the spike's environment (STRAW_BOSS_DESK=1, primary slot) and prints the shell's two lines:
#   GUI_URL=<url>   SB_DIR=<slot folder>   (the URL carries the page token: it is printed here only, and kept on disk only while this script runs)
# plus NOTICE=<text> for warnings a person should see. Records the sb server's pid and start time in $SPIKE/run/sb.pid and sb.start, for 99-stop.sh, and what the
# desk steps answered (workspace, pane, tower, created, integration) in $SPIKE/run/base.json. The home base folder is $HOME/Straw Boss, made here when missing.
# Exit codes: 0 done; 2 pi-straw-boss not installed; 4 the spike's herdr is not running; 10+N `up` failed with exit N (11 a step failed, 12 usage, 13 the
# server cannot run); 21 `up` answered without a usable URL; 22 the sb server is not in the primary slot; 23 step base busy (another `up --dir` holds desk.lock);
# 24 step base failed (the folder, or Herdr said no); 25 step integration failed; 26 `up` answered without a base (workspace).
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
[ -f "$cli" ] || { echo "pi-straw-boss is not installed under the spike (run 01-install.sh)"; exit 2; }
for _ in $(seq 1 50); do [ -S "$HERDR_SOCKET_PATH" ] && break; sleep 0.2; done
[ -S "$HERDR_SOCKET_PATH" ] || { echo "the spike's herdr is not running (start 02-herdr-server.sh under MonitorCreate)"; exit 4; }
base_dir="$HOME/Straw Boss"; base_label="Straw Boss"
mkdir -p "$SPIKE/run" "$base_dir"
out="$SPIKE/run/up.out"; err="$SPIKE/run/up.err"
# up's stdout holds the URL, so the page token: it stays on disk only while this script runs.
trap 'rm -f "$out"' EXIT
began="$(node -e 'console.log(Date.now())')"
code=0
node "$cli" up --dir "$base_dir" --label "$base_label" --timeout "${UP_TIMEOUT:-120}" --exact > "$out" 2> "$err" || code=$?
ms=$(( $(node -e 'console.log(Date.now())') - began ))
hide() { sed -E 's#(127\.0\.0\.1:[0-9]+/)[0-9a-f]{16,}#\1<token>#g'; }
if [ "$code" -ne 0 ]; then
  echo "FAIL up exit $code: $(tail -n 1 "$err" | hide | cut -c1-400)"
  # The desk steps' failures get their own codes (the Windows kit's 23 to 25): a busy desk.lock, a base that could not be made, the integration.
  failure="$(node -e '
    const line = require("fs").readFileSync(process.argv[1], "utf8").split(/\r?\n/).filter((l) => l.trim().startsWith("{")).pop();
    try { const j = JSON.parse(line); console.log(j.step === "base" ? (/^busy/.test(String(j.reason)) ? "basebusy" : "base") : j.step === "integration" ? "integration" : ""); } catch { console.log(""); }
  ' "$err")"
  case "$failure" in basebusy) exit 23;; base) exit 24;; integration) exit 25;; esac
  exit $((10 + code))
fi
# url|pid|started|log|desk|server|workspace|pane|tower|created|integration ; a field may be empty
fields="$(node -e '
  const fs = require("fs");
  const line = fs.readFileSync(process.argv[1], "utf8").split(/\r?\n/).filter((l) => l.trim().startsWith("{")).pop();
  if (!line) process.exit(3);
  const j = JSON.parse(line);
  console.log([j.url || "", j.pid || "", j.started || "", j.log || "", j.desk, j.server || "", j.workspace || "", j.pane || "", j.tower || "", j.created, j.integration || ""].join("|"));
' "$out")" || { echo "FAIL up answered without a JSON line"; exit 21; }
IFS='|' read -r url pid started log desk how workspace pane tower created integration <<< "$fields"
case "$url" in http://127.0.0.1:*/*/) ;; *) echo "FAIL up answered with a URL of an unexpected shape (not shown)"; exit 21;; esac
printf '%s' "$url" | grep -Eq '^http://127\.0\.0\.1:[0-9]+/[0-9a-f]{16,}/$' || { echo "FAIL up answered with a URL of an unexpected shape (not shown)"; exit 21; }
[ -n "$workspace" ] || { echo "FAIL up --dir answered without a home base (workspace)"; exit 26; }
printf '{"workspace":"%s","pane":"%s","tower":"%s","created":%s,"integration":"%s","dir":"%s"}\n' "$workspace" "$pane" "$tower" "${created:-null}" "$integration" "$base_dir" > "$SPIKE/run/base.json"
sbdir="$(dirname "$log")"
if [ "$sbdir" != "$PI_CODING_AGENT_DIR/straw-boss" ]; then
  echo "FAIL slot: the sb server is not in the primary slot ($sbdir)"; exit 22
fi
# A pid without a readable start time is never recorded: 99-stop.sh could not tell it from a reused pid.
# It is also recorded only when the server's own UTC `started` (returned by up) equals the pid's start now: otherwise the pid may be another process.
sb_start="$(proc_start "$pid")"
sb_utc="$(TZ=UTC LC_ALL=C ps -o lstart= -p "$pid" 2>/dev/null | sed 's/^ *//;s/ *$//')"
if [ -n "$sb_start" ] && [ -n "$started" ] && [ "$sb_utc" = "$started" ]; then echo "$pid" > "$SPIKE/run/sb.pid"; echo "$sb_start" > "$SPIKE/run/sb.start"; else echo "NOTICE=the sb server pid $pid has no readable or matching start time; not recorded, 99-stop.sh will not kill it" >&2; fi
echo "TIMING up ${ms}ms (server=$how desk=$desk pid=$pid started=${started:-unknown})" >&2
# Warnings: the two a person should see become NOTICE= lines; desk_on would be an environment bug (this script always sets the switch); the rest is logged.
node -e '
  const fs = require("fs");
  const line = fs.readFileSync(process.argv[1], "utf8").split(/\r?\n/).filter((l) => l.trim().startsWith("{")).pop();
  for (const w of JSON.parse(line).warnings || []) {
    const text = String(w.text).replace(/[\r\n]+/g, " ");
    if (w.code === "breakaway_failed" || w.code === "server_unreachable") console.log("NOTICE=sb server: " + text);
    else if (w.code === "desk_on") console.error("env bug: warning desk_on although STRAW_BOSS_DESK=1 is set");
    else console.error("warning: " + w.code);
  }
' "$out"
echo "GUI_URL=$url"
echo "SB_DIR=$sbdir"
