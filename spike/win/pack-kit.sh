#!/bin/bash
# Zips the kit scripts (not the prototype, not out/) into out/sbd-kit.zip for copying into the VM.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$here/out"
dest="$here/out/sbd-kit.zip"
rm -f "$dest"
cd "$here"
zip -q -r "$dest" bootstrap.ps1 start.ps1 stop.ps1 checks.ps1 check-claude.ps1 check-github.ps1 check-gitlab.ps1 check-ttt.ps1 collect.ps1 ui-run.ps1 shot.ps1 desk-b7-check.ps1 npm-stale-check.ps1 lib.ps1 pins.json lib RUNBOOK.md
unzip -l "$dest" | tail -n 25
