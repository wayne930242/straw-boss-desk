#!/usr/bin/env bash
# Runs the local stub model endpoint in the foreground (start under MonitorCreate). Records its PID.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -n "${SPIKE_CLEAN:-}" ] || exec "$here/run.sh" "$0" "$@"
# shellcheck source=env.sh
. "$here/env.sh"
echo $$ > "$SPIKE/run/stub.pid"
exec node "$here/stub-llm.mjs" 18999
