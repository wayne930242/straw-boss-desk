#!/usr/bin/env bash
# Copies the spike's Electron app to $SPIKE/electron-app (with follow.ts, the file the Windows prototype shares), installs Electron and TypeScript with the private npm, and compiles it.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -n "${SPIKE_CLEAN:-}" ] || exec "$here/run.sh" "$0" "$@"
# shellcheck source=env.sh
. "$here/env.sh"
app="$SPIKE/electron-app"
[ -n "$app" ] || exit 1
rm -rf "${app:?}/src" "${app:?}/dist"; mkdir -p "$app"
cp -R "$here/electron/src" "$here/electron/package.json" "$here/electron/tsconfig.json" "$app/"
cp "$here/../win/proto/src/follow.ts" "$app/src/follow.ts"
cd "$app"
s=$SECONDS
npm install --save-dev --save-exact "electron@$SBD_ELECTRON_VERSION" "typescript@$SBD_TYPESCRIPT_VERSION" "@types/node@24"
echo "TIMING npm install electron $((SECONDS - s))s"
# Electron 45 has no postinstall: the binary is fetched on first use. Fetch it now, and time it.
s=$SECONDS
node node_modules/electron/install.js
echo "TIMING electron binary download $((SECONDS - s))s"
npx tsc -p .
ls -la dist
du -sh node_modules "$ELECTRON_CACHE"
