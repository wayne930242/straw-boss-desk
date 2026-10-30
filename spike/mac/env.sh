# Sourced by every spike script, only inside run.sh's clean environment (env -i). Everything lives under $SPIKE.
# The caller's environment is dropped on purpose: a spike started from inside a herdr pane would otherwise inherit
# HERDR_*, PI_*, and SSH_AUTH_SOCK (herdr symlinks the latter next to its socket) and could join the author's net.
[ -n "${SPIKE_CLEAN:-}" ] || { echo "env.sh must run through run.sh"; exit 1; }
export SPIKE="${SPIKE:-/tmp/sbd-spike}"
export HOME="$SPIKE/home"
export TOOLS="$SPIKE/tools"
export PI_CODING_AGENT_DIR="$HOME/.pi/agent"
export XDG_CONFIG_HOME="$HOME/.config"
export HERDR_CONFIG_PATH="$XDG_CONFIG_HOME/herdr/config.toml"
# Herdr's default socket for this XDG_CONFIG_HOME, spelled out: pi-straw-boss calls the server of the default Herdr the PRIMARY one (it holds Straw Link and
# keeps its files in $PI_CODING_AGENT_DIR/straw-boss/ itself), and it compares the text of the two paths. Still a socket of the spike's own, never the author's.
export HERDR_SOCKET_PATH="$XDG_CONFIG_HOME/herdr/herdr.sock"
# The desk shell's switch: the sb server records `desk`, `/boss gui` prints the URL and opens no browser.
export STRAW_BOSS_DESK=1
export HERDR_BIN_PATH="$TOOLS/herdr/herdr"
export NPM_CONFIG_PREFIX="$TOOLS/npm"
export NPM_CONFIG_CACHE="$SPIKE/npm-cache"
export NPM_CONFIG_USERCONFIG="$HOME/.npmrc"
export NPM_CONFIG_UPDATE_NOTIFIER=false
export ELECTRON_CACHE="$SPIKE/electron-cache"
export TMPDIR="$SPIKE/tmp"
export PATH="$SPIKE/shims:$TOOLS/node/bin:$TOOLS/npm/bin:$TOOLS/herdr:/usr/bin:/bin:/usr/sbin:/sbin"
export LANG=en_US.UTF-8
# pi would otherwise report install telemetry and ask pi.dev for its latest version.
export PI_TELEMETRY=0
export PI_SKIP_VERSION_CHECK=1
# Versions, pinned (pi, pi-straw-boss and pi-intercom as spike/win/pins.json; the sb server needs pi-intercom 0.18.1 or newer and exits 3 without it).
# SHA256 values come from nodejs.org SHASUMS256.txt and herdr.dev/latest.json.
export SBD_NODE_VERSION=24.22.1
export SBD_NODE_SHA256=89c682593d76cd44233fa53b1563264e7de9cbb189cad169135c5b4fadfbc0a7
export SBD_HERDR_VERSION=0.9.5
export SBD_HERDR_SHA256=fb77c2232a05a8035421382c894392f4174e4e38a18e48af3dd0290157c3a7e2
export SBD_PI_VERSION=1.4.0
export SBD_STRAW_BOSS_VERSION=0.48.0
export SBD_INTERCOM_VERSION=0.18.1
export SBD_ELECTRON_VERSION=45.0.0
export SBD_TYPESCRIPT_VERSION=7.0.2
