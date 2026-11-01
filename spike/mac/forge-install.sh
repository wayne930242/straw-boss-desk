#!/usr/bin/env bash
# F1: install gh and glab for darwin into $TOOLS (the layout forge-cli.mjs launchers expect: $TOOLS/gh/bin/gh, $TOOLS/glab/bin/glab).
# Pins and SHA256 come from spike/win/pins.json. Every download is verified; a wrong pin, a tampered cache and a changed upstream are refused.
#   forge-install.sh install              download (or reuse a verified cache), verify, unpack, print versions
#   forge-install.sh self-test            the three refusal cases against local file:// archives, in a scratch folder
# Needs SPIKE (run through run.sh). Prints PASS/FAIL lines; exit 1 on any failure.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
: "${SPIKE:?run through spike/mac/run.sh}"
case "$SPIKE" in /tmp/sbd-macacct) ;; *) echo "refusing: SPIKE must be /tmp/sbd-macacct"; exit 1;; esac
NODE=${SBD_NODE:?SBD_NODE is the absolute path of node}
PINS="$here/../win/pins.json"
arch=$(uname -m); case "$arch" in arm64) key=darwin-arm64;; x86_64) key=darwin-x64;; *) echo "FAIL unsupported arch $arch"; exit 1;; esac

pin() { "$NODE" -e 'const p=JSON.parse(require("fs").readFileSync(process.argv[1]));const b=p.binaries[process.argv[2]];const k=process.argv[3];process.stdout.write(String(k==="version"?b.version:b[process.argv[4]][k]))' "$PINS" "$@"; }

# fetch <url> <dest> <sha256> : download to dest.part, verify, move into place; a mismatch deletes the part and fails.
fetch() {
  local url=$1 dest=$2 sha=$3 got
  if [ -f "$dest" ]; then
    got=$(shasum -a 256 "$dest" | cut -d' ' -f1)
    if [ "$got" = "$sha" ]; then return 0; fi
    echo "REFUSED cached $(basename "$dest") does not match its pin (got $got); deleting and downloading again"
    rm -f "$dest"
  fi
  curl -fsSL --retry 2 -o "$dest.part" "$url"
  got=$(shasum -a 256 "$dest.part" | cut -d' ' -f1)
  if [ "$got" != "$sha" ]; then
    rm -f "$dest.part"
    echo "REFUSED download of $(basename "$dest") does not match its pin: expected $sha, got $got"
    return 3
  fi
  mv "$dest.part" "$dest"
}

install_one() {
  local cli=$1 url sha file ver dl="$SPIKE/tools/downloads" tmp
  url=$(pin "$cli" url "$key"); sha=$(pin "$cli" sha256 "$key"); file=$(pin "$cli" file "$key"); ver=$(pin "$cli" version)
  mkdir -p "$dl" "$SPIKE/tools"
  fetch "$url" "$dl/$file" "$sha"
  tmp=$(mktemp -d "$SPIKE/tmp/unpack.XXXXXX")
  rm -rf "$SPIKE/tools/$cli"
  case "$file" in
    *.zip) /usr/bin/unzip -q "$dl/$file" -d "$tmp"; mkdir -p "$SPIKE/tools/$cli"; cp -R "$tmp"/*/bin "$SPIKE/tools/$cli/bin";;
    *.tar.gz) /usr/bin/tar -xzf "$dl/$file" -C "$tmp"; mkdir -p "$SPIKE/tools/$cli"; cp -R "$tmp/bin" "$SPIKE/tools/$cli/bin";;
  esac
  rm -rf "$tmp"
  chmod +x "$SPIKE/tools/$cli/bin/$cli"
  echo "installed $cli $ver from $file (sha256 $sha)"
}

case "${1:-install}" in
  install)
    mkdir -p "$SPIKE/tmp"
    install_one gh; install_one glab
    ;;
  self-test)
    st=$(mktemp -d "$SPIKE/tmp/selftest.XXXXXX"); fails=0
    printf 'real archive\n' > "$st/a.bin"; good=$(shasum -a 256 "$st/a.bin" | cut -d' ' -f1)
    # 1: a wrong pin
    mkdir "$st/d1"
    if out=$(fetch "file://$st/a.bin" "$st/d1/a.bin" "$(printf '0%.0s' {1..64})" 2>&1); then echo "FAIL wrong pin accepted"; fails=$((fails+1)); else
      if [ ! -e "$st/d1/a.bin" ] && [ ! -e "$st/d1/a.bin.part" ]; then echo "PASS wrong pin refused, nothing kept: ${out%%$'\n'*}"; else echo "FAIL wrong pin left a file"; fails=$((fails+1)); fi; fi
    # 2: a tampered cache is refused and replaced by a verified download
    mkdir "$st/d2"; printf 'tampered\n' > "$st/d2/a.bin"
    out=$(fetch "file://$st/a.bin" "$st/d2/a.bin" "$good" 2>&1) || true
    if [ "$(shasum -a 256 "$st/d2/a.bin" | cut -d' ' -f1)" = "$good" ] && [[ "$out" == *REFUSED* ]]; then echo "PASS tampered cache refused and replaced"; else echo "FAIL tampered cache handling: $out"; fails=$((fails+1)); fi
    # 3: upstream changed (the pin no longer matches what the URL serves)
    mkdir "$st/d3"; printf 'upstream changed\n' > "$st/b.bin"
    if out=$(fetch "file://$st/b.bin" "$st/d3/a.bin" "$good" 2>&1); then echo "FAIL changed upstream accepted"; fails=$((fails+1)); else
      if [ ! -e "$st/d3/a.bin" ]; then echo "PASS changed upstream refused, nothing kept"; else echo "FAIL changed upstream left a file"; fails=$((fails+1)); fi; fi
    rm -rf "$st"
    [ "$fails" -eq 0 ] && echo "all PASS" || { echo "$fails FAIL"; exit 1; }
    ;;
  *) echo "usage: forge-install.sh install|self-test"; exit 2;;
esac
