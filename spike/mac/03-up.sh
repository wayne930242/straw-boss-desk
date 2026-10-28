#!/usr/bin/env bash
# Brings up the sb server and its GUI with `cli.mjs up --exact` in the spike's environment (STRAW_BOSS_DESK=1, primary slot) and prints the shell's two lines:
#   GUI_URL=<url>   SB_DIR=<slot folder>   (the URL carries the page token: it is printed here only, and kept on disk only while this script runs)
# plus NOTICE=<text> for warnings a person should see. Records the sb server's pid and start time in $SPIKE/run/sb.pid and sb.start, for 99-stop.sh.
# Exit codes: 0 done; 2 pi-straw-boss not installed; 4 the spike's herdr is not running; 10+N `up` failed with exit N (11 a step failed, 12 usage, 13 the
# server cannot run); 21 `up` answered without a usable URL; 22 the sb server is not in the primary slot.
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
mkdir -p "$SPIKE/run"
out="$SPIKE/run/up.out"; err="$SPIKE/run/up.err"
# up's stdout holds the URL, so the page token: it stays on disk only while this script runs.
trap 'rm -f "$out"' EXIT
began="$(node -e 'console.log(Date.now())')"
code=0
node "$cli" up --timeout "${UP_TIMEOUT:-30}" --exact > "$out" 2> "$err" || code=$?
ms=$(( $(node -e 'console.log(Date.now())') - began ))
hide() { sed -E 's#(127\.0\.0\.1:[0-9]+/)[0-9a-f]{16,}#\1<token>#g'; }
if [ "$code" -ne 0 ]; then
  echo "FAIL up exit $code: $(tail -n 1 "$err" | hide | cut -c1-400)"
  exit $((10 + code))
fi
# url|pid|started|log|desk|server ; a field may be empty
fields="$(node -e '
  const fs = require("fs");
  const line = fs.readFileSync(process.argv[1], "utf8").split(/\r?\n/).filter((l) => l.trim().startsWith("{")).pop();
  if (!line) process.exit(3);
  const j = JSON.parse(line);
  console.log([j.url || "", j.pid || "", j.started || "", j.log || "", j.desk, j.server || ""].join("|"));
' "$out")" || { echo "FAIL up answered without a JSON line"; exit 21; }
IFS='|' read -r url pid started log desk how <<< "$fields"
case "$url" in http://127.0.0.1:*/*/) ;; *) echo "FAIL up answered with a URL of an unexpected shape (not shown)"; exit 21;; esac
printf '%s' "$url" | grep -Eq '^http://127\.0\.0\.1:[0-9]+/[0-9a-f]{16,}/$' || { echo "FAIL up answered with a URL of an unexpected shape (not shown)"; exit 21; }
sbdir="$(dirname "$log")"
if [ "$sbdir" != "$PI_CODING_AGENT_DIR/straw-boss" ]; then
  echo "FAIL slot: the sb server is not in the primary slot ($sbdir)"; exit 22
fi
echo "$pid" > "$SPIKE/run/sb.pid"; proc_start "$pid" > "$SPIKE/run/sb.start"
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
