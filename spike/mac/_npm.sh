# Source from 01-install.sh. Pinned npm installs ask the registry for fresh package metadata and say what a registry failure means.
#
# npm keeps a copy of each package's metadata and trusts it for 5 minutes without asking (the registry sends max-age=300), and when the registry does
# not answer it uses the copy instead of failing. A pinned version published after the copy was made then fails as ETARGET or E404 "not found"
# (VM 2026-10-30: three ETIMEDOUT, then E404 for pi-straw-boss@0.48.0, which exists). prefer-online makes npm ask first; it cannot help when the
# registry does not answer, so such a failure gets a plain sentence. Nothing falls back to another version.
export NPM_CONFIG_PREFER_ONLINE=true

# pinned <name@version> <command...>: run the command, show its output, and on failure add the plain sentence when the output looks like a registry
# problem (network error, or npm found no such version). Returns the command's exit code.
pinned() {
  local what="$1" log rcfile rc
  shift
  log="$(mktemp "${TMPDIR:-/tmp}/pinned.XXXXXX")"
  rcfile="$(mktemp "${TMPDIR:-/tmp}/pinned-rc.XXXXXX")"
  # The exit code goes through a file: it must survive a caller without pipefail, and a caller with `set -e` must not stop before the sentence is printed.
  { "$@" 2>&1 && echo 0 > "$rcfile" || echo $? > "$rcfile"; } | tee "$log"
  rc="$(cat "$rcfile")"
  if [ "$rc" -ne 0 ] && grep -Eq 'ETIMEDOUT|ESOCKETTIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|EPROTO|ERR_SOCKET|CERT_|UNABLE_TO_VERIFY|FETCH_ERROR|E404|ETARGET|notarget|No match found|No matching version|E50[0-4]' "$log"; then
    echo "The npm registry could not be reached or is out of date, so $what was not installed. Check the network and run this again; nothing was installed in its place." >&2
  fi
  rm -f "$log" "$rcfile"
  return "$rc"
}
