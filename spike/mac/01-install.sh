#!/usr/bin/env bash
# Installs Node, herdr, pi, pi-straw-boss and pi-intercom into $SPIKE with a throwaway HOME. Prints timings.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -n "${SPIKE_CLEAN:-}" ] || exec "$here/run.sh" "$0" "$@"
# shellcheck source=env.sh
. "$here/env.sh"
# shellcheck source=_npm.sh
. "$here/_npm.sh"
[ -n "$SPIKE" ] && [ "$HOME" = "$SPIKE/home" ] || exit 1
mkdir -p "$HOME/projects/demo" "$TOOLS" "$SPIKE/run" "$SPIKE/tmp" "$SPIKE/dl" "$SPIKE/work" "$PI_CODING_AGENT_DIR" "$XDG_CONFIG_HOME/herdr"
t() { local s=$SECONDS; "$@"; echo "TIMING $1 $((SECONDS - s))s" >&2; }

install_node() {
  [ -x "$TOOLS/node/bin/node" ] && return
  local d="$SPIKE/dl/node" f="node-v$SBD_NODE_VERSION-darwin-arm64.tar.gz"
  rm -rf "$d"; mkdir -p "$d"
  curl -fsSL -o "$d/$f" "https://nodejs.org/dist/v$SBD_NODE_VERSION/$f"
  echo "$SBD_NODE_SHA256  $d/$f" | shasum -a 256 -c -
  mkdir "$d/x"; tar -xzf "$d/$f" -C "$d/x"
  mv "$d/x/node-v$SBD_NODE_VERSION-darwin-arm64" "$TOOLS/node"
  rm -rf "${d:?}"
}
install_herdr() {
  [ -x "$HERDR_BIN_PATH" ] && return
  local d="$SPIKE/dl/herdr"
  rm -rf "$d"; mkdir -p "$d" "$TOOLS/herdr"
  curl -fsSL -o "$d/herdr" "https://github.com/herdrdev/herdr/releases/download/v$SBD_HERDR_VERSION/herdr-macos-aarch64"
  echo "$SBD_HERDR_SHA256  $d/herdr" | shasum -a 256 -c -
  chmod +x "$d/herdr"; mv "$d/herdr" "$HERDR_BIN_PATH"
  rm -rf "${d:?}"
}
install_pi() {
  [ -x "$TOOLS/npm/bin/pi" ] || pinned "@earendil-works/pi-coding-agent@$SBD_PI_VERSION" npm install -g "@earendil-works/pi-coding-agent@$SBD_PI_VERSION"
}
install_packages() {
  pinned "pi-intercom@$SBD_INTERCOM_VERSION" pi install "npm:pi-intercom@$SBD_INTERCOM_VERSION"
  pinned "pi-straw-boss@$SBD_STRAW_BOSS_VERSION" pi install "npm:pi-straw-boss@$SBD_STRAW_BOSS_VERSION"
}
# herdr config: no onboarding, update checks, or sounds; panes start non-login shells so PATH keeps the spike's dirs in front; agents resume after a restart.
write_config() {
  cat > "$HERDR_CONFIG_PATH" <<'TOML'
onboarding = false

[terminal]
shell_mode = "non_login"

[update]
version_check = false
manifest_check = false

# After a restart herdr restores the workspaces and resumes their pi panes, so the tower comes back with its role (as herdr did in the Windows VM passes).
[session]
resume_agents_on_restore = true

[ui.sound]
enabled = false
TOML
  # pi-straw-boss opens the GUI with `open <url>`; the spike records the URL instead of launching the author's browser.
  mkdir -p "$SPIKE/shims"
  printf '#!/bin/sh\necho "$@" >> "%s/run/opened-urls.txt"\n' "$SPIKE" > "$SPIKE/shims/open"
  chmod +x "$SPIKE/shims/open"
}
t write_config
t install_node
t install_herdr
t install_pi
# A local stand-in model (stub-llm.mjs) so pi sessions can complete a turn without credentials or network.
configure_stub() {
  cat > "$PI_CODING_AGENT_DIR/models.json" <<'JSON'
{ "providers": { "stub": { "baseUrl": "http://127.0.0.1:18999/v1", "api": "openai-completions", "apiKey": "stub", "models": [{ "id": "stub-1" }] } } }
JSON
  node -e 'const f=process.argv[1],fs=require("fs"),s=JSON.parse(fs.readFileSync(f,"utf8"));s.defaultProvider="stub";s.defaultModel="stub-1";fs.writeFileSync(f,JSON.stringify(s,null,2))' "$PI_CODING_AGENT_DIR/settings.json"
}
# herdr's pi integration (a pi extension that reports each session's file to herdr) is not installed here: `cli.mjs up --dir` in 03-up.sh installs it.
t install_packages
t configure_stub
node -v; herdr --version; pi --version
du -sh "$TOOLS/node" "$TOOLS/herdr" "$TOOLS/npm" "$PI_CODING_AGENT_DIR" "$SPIKE/npm-cache" 2>&1 | sed "s|$SPIKE|\$SPIKE|"
