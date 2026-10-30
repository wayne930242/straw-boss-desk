<#
.SYNOPSIS
  Shows what bootstrap.ps1 says for a pinned npm package when the npm registry is down and npm's cache holds an old package list (VM 2026-10-30).
.DESCRIPTION
  Works in a scratch SBD_ROOT under the user's profile: a junction to the real node folder and nothing else of the real install, which is never written.
  A stand-in registry (lib\npm-stale-fixture.mjs) lets npm cache a package list of pi-straw-boss that stops at 0.46.0, then goes away. Then
  `bootstrap.ps1 -Only pkg:pi-straw-boss -Force` runs against it. Plain npm says E404 for pi-straw-boss@0.48.0; bootstrap must say the registry could not
  be reached or is out of date, fail the stage, and install nothing. Needs no network. Prints PASS/FAIL lines; exit 1 on any FAIL.
#>
# Continue, not Stop: Windows PowerShell 5.1 turns a native command's stderr line into a terminating error when it is redirected with 2>&1. Every step is checked below.
$ErrorActionPreference = 'Continue'
$kit = Split-Path -Parent $MyInvocation.MyCommand.Path
$realRoot = if ($env:SBD_ROOT) { $env:SBD_ROOT } else { Join-Path $env:LOCALAPPDATA 'straw-boss-desk' }
$realNode = Join-Path $realRoot 'tools\node'
$scratch = Join-Path $env:USERPROFILE 'sbd-npm-stale'
$root = Join-Path $scratch 'root'
$junction = Join-Path $root 'tools\node'
$port = 18765
$sentence = 'The npm registry could not be reached or is out of date, so pi-straw-boss@0.48.0 was not installed.'
$bad = 0
function Test-Check {
    param([string]$Name, [bool]$Ok, [string]$Detail)
    if ($Ok) { Write-Host "PASS $Name - $Detail" } else { Write-Host "FAIL $Name - $Detail"; $script:bad = 1 }
}
if (-not (Test-Path -LiteralPath (Join-Path $realNode 'node.exe'))) { throw "no node at ${realNode}: run bootstrap.ps1 -Only node first" }

# The junction goes first, with a call that removes only the link: Remove-Item -Recurse could follow it into the real node folder.
function Remove-Scratch {
    if (Test-Path -LiteralPath $junction) {
        [IO.Directory]::Delete($junction, $false)
        if (Test-Path -LiteralPath $junction) { throw "could not remove the junction $junction; $scratch is left alone" }
    }
    if (Test-Path -LiteralPath $scratch) { Remove-Item -LiteralPath $scratch -Recurse -Force -ErrorAction Stop }
}
Remove-Scratch
New-Item -ItemType Directory -Path (Join-Path $root 'tools') -Force -ErrorAction Stop | Out-Null
New-Item -ItemType Junction -Path $junction -Target $realNode -ErrorAction Stop | Out-Null
$saved = @{}
foreach ($k in @('SBD_ROOT', 'NPM_CONFIG_REGISTRY', 'NPM_CONFIG_FETCH_RETRIES', 'NPM_CONFIG_CACHE')) { $saved[$k] = [Environment]::GetEnvironmentVariable($k) }
try {
    $cache = Join-Path $root 'tools\npm-cache'
    $seedOut = & (Join-Path $realNode 'node.exe') (Join-Path $kit 'lib\npm-stale-fixture.mjs') seed $port $cache pi-straw-boss 0.46.0 2>&1 | Out-String
    Test-Check 'seeded' ($LASTEXITCODE -eq 0) $seedOut.Trim()

    $env:SBD_ROOT = $root
    $env:NPM_CONFIG_REGISTRY = "http://127.0.0.1:$port/"
    $env:NPM_CONFIG_FETCH_RETRIES = '0'
    $env:NPM_CONFIG_CACHE = $cache
    $plain = & (Join-Path $realNode 'npm.cmd') view pi-straw-boss@0.48.0 dist.integrity 2>&1 | Out-String
    Test-Check 'plain-npm-says-not-found' ($plain -match 'E404|ETARGET|No match') (($plain -split "`r?`n" | Where-Object { $_.Trim() } | Select-Object -First 2) -join ' | ')

    $boot = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $kit 'bootstrap.ps1') -Only 'pkg:pi-straw-boss' -Force 2>&1 | Out-String
    $code = $LASTEXITCODE
    Test-Check 'bootstrap-fails' ($code -ne 0 -and $boot -match 'FAILED stages: pkg:pi-straw-boss') "exit $code"
    $failLine = ($boot -split "`r?`n" | Where-Object { $_ -match 'pkg:pi-straw-boss\] fail' } | Select-Object -First 1)
    if ($failLine.Length -gt 330) { $failLine = $failLine.Substring(0, 330) + '...' }
    Test-Check 'bootstrap-says-why' ($boot.Contains($sentence)) $failLine
    Test-Check 'bootstrap-keeps-detail' ($boot -match 'this is not an integrity mismatch') 'the technical detail follows the sentence'
    Test-Check 'nothing-installed' (-not (Test-Path -LiteralPath (Join-Path $root 'agent\npm\node_modules\pi-straw-boss'))) 'no pi-straw-boss under the scratch agent folder'
}
finally {
    foreach ($k in $saved.Keys) { [Environment]::SetEnvironmentVariable($k, $saved[$k]) }
    Remove-Scratch
}
Test-Check 'real-node-intact' (Test-Path -LiteralPath (Join-Path $realNode 'node.exe')) 'the junction removal left the real node folder alone'
exit $bad
