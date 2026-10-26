#!/usr/bin/env bash
# Clears the spike's runtime state (herdr session, pi sessions, straw-boss state, run files) for a fresh run. Keeps the installed tools.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -n "${SPIKE_CLEAN:-}" ] || exec "$here/run.sh" "$0" "$@"
# shellcheck source=env.sh
. "$here/env.sh"
[ -n "$SPIKE" ] && [ "$HOME" = "$SPIKE/home" ] || exit 1
for f in herdr electron; do
  if [ -s "$SPIKE/run/$f.pid" ] && ps -p "$(cat "$SPIKE/run/$f.pid")" > /dev/null 2>&1; then echo "$f is still running (pid $(cat "$SPIKE/run/$f.pid")); stop its monitor first"; exit 1; fi
done
find "${SPIKE:?}/run" -mindepth 1 -not -name stub.pid -delete
rm -rf "${PI_CODING_AGENT_DIR:?}/straw-boss" "${PI_CODING_AGENT_DIR:?}/sessions" "${HOME:?}/.config/herdr/session.json" "${HOME:?}/.config/herdr/session-snapshots"
mkdir -p "$SPIKE/run" "$PI_CODING_AGENT_DIR/sessions" "$HOME/projects/demo"
echo reset
