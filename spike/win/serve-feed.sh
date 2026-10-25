#!/bin/bash
# Serves spike/win/out/feed over HTTP for the electron-updater generic provider and for downloading the installers inside the VM.
# usage: serve-feed.sh [port]      (default 8099; run it with MonitorCreate, never with & or nohup)
# The VM reaches the Mac at 192.168.64.1 (UTM shared network). The server listens on all interfaces so the VM can connect.
set -euo pipefail
port="${1:-8099}"
here="$(cd "$(dirname "$0")" && pwd)"
feed="$here/out/feed"
[ -d "$feed" ] || { echo "no $feed; build first: (cd proto && node scripts/build-installers.mjs)" >&2; exit 1; }
[ -f "$feed/latest.yml" ] || { echo "no latest.yml in $feed" >&2; exit 1; }
echo "serving $feed on 0.0.0.0:$port (pid $$)"
cd "$feed"
exec python3 -I -m http.server "$port" --bind 0.0.0.0
