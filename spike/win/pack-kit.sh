#!/bin/bash
# Zips the kit scripts (not the prototype, not out/) into out/sbd-kit.zip for copying into the VM.
# The team profile stage reads profile/ and recipe/ beside the scripts, so they are staged in from the repository root (no tests, no node_modules).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
mkdir -p "$here/out"
dest="$here/out/sbd-kit.zip"
rm -f "$dest"
stage="$(mktemp -d)"
trap 'rm -r "$stage"' EXIT
cd "$here"
cp -R bootstrap.ps1 start.ps1 stop.ps1 checks.ps1 check-claude.ps1 check-github.ps1 check-gitlab.ps1 check-ttt.ps1 collect.ps1 ui-run.ps1 shot.ps1 desk-b7-check.ps1 npm-stale-check.ps1 account-check.ps1 forge-cli-check.ps1 lib.ps1 pins.json test-recipe.strawboss.json lib RUNBOOK.md "$stage/"
mkdir -p "$stage/test" "$stage/profile" "$stage/recipe"
cp test/forge-cli.test.mjs "$stage/test/"
(cd "$root/profile" && cp -R AGENTS.md package.json config rules skills "$stage/profile/")
(cd "$root/recipe" && cp -R recipe.schema.json secret-patterns.json validate.mjs package.json examples "$stage/recipe/")
(cd "$stage" && zip -q -r "$dest" .)
unzip -l "$dest" | tail -n 25
