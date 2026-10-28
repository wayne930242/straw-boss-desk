#!/usr/bin/env bash
# Clears the spike's runtime state (herdr session, pi sessions, straw-boss state, run files) for a fresh run. Keeps the installed tools.
# Refuses while a recorded herdr, sb server, or Electron process still runs: stop them first (99-stop.sh, then the Electron monitor).
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
for f in herdr sb electron; do
  if [ -s "$SPIKE/run/$f.pid" ] && proc_alive "$(cat "$SPIKE/run/$f.pid")" "$(cat "$SPIKE/run/$f.start" 2>/dev/null || true)"; then echo "$f is still running (pid $(cat "$SPIKE/run/$f.pid")); stop it first"; exit 1; fi
done
find "${SPIKE:?}/run" -mindepth 1 -not -name stub.pid -delete
rm -rf "${PI_CODING_AGENT_DIR:?}/straw-boss" "${PI_CODING_AGENT_DIR:?}/sessions" "${XDG_CONFIG_HOME:?}/herdr/session.json" "${XDG_CONFIG_HOME:?}/herdr/session-snapshots"
mkdir -p "$SPIKE/run" "$PI_CODING_AGENT_DIR/sessions" "$HOME/projects/demo"
echo reset
