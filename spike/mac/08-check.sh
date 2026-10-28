#!/usr/bin/env bash
# M1 assertions after 03-up.sh (and optionally 03-tower.sh): the GUI answers 200, `cli.mjs status` says live, primary and desk, the `open` shim recorded nothing,
# and only one server.json exists (no servers/ folder). Prints PASS/FAIL lines, never the URL's token. Exit 1 on any FAIL.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -n "${SPIKE_CLEAN:-}" ] || exec "$here/run.sh" "$0" "$@"
# shellcheck source=env.sh
. "$here/env.sh"
# shellcheck source=_isolated.sh
. "$here/_isolated.sh"
cli="$PI_CODING_AGENT_DIR/npm/node_modules/pi-straw-boss/dist/server/cli.mjs"
dir="$PI_CODING_AGENT_DIR/straw-boss"
bad=0
check() { # name ok detail
  if [ "$2" = 1 ]; then echo "PASS $1 - $3"; else echo "FAIL $1 - $3"; bad=1; fi
}
status="$(node "$cli" status | tail -n 1)"
field() { printf '%s' "$status" | node -e 'const j=JSON.parse(require("fs").readFileSync(0,"utf8")); const v=process.argv[1].split(".").reduce((o,k)=>o&&o[k],j); console.log(v===undefined?"":v)' "$1"; }
url="$(field url)"
code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$url" || true)"
check "gui-200" "$([ "$code" = 200 ] && echo 1 || echo 0)" "GET the status url -> $code"
check "state-live" "$([ "$(field state)" = live ] && echo 1 || echo 0)" "state=$(field state)"
check "primary" "$([ "$(field primary)" = true ] && echo 1 || echo 0)" "primary=$(field primary)"
check "desk" "$([ "$(field desk)" = true ] && echo 1 || echo 0)" "desk=$(field desk)"
check "herdr-socket" "$([ "$(field herdr)" = "$HERDR_SOCKET_PATH" ] && echo 1 || echo 0)" "the server serves the spike's socket"
opened="$SPIKE/run/opened-urls.txt"
check "no-browser" "$([ ! -s "$opened" ] && echo 1 || echo 0)" "open shim recorded $([ -s "$opened" ] && wc -l < "$opened" | tr -d ' ' || echo 0) call(s)"
check "one-record" "$([ -f "$dir/server.json" ] && [ ! -e "$dir/servers" ] && echo 1 || echo 0)" "server.json at the top level, servers/ $([ -e "$dir/servers" ] && echo present || echo absent)"
exit "$bad"
