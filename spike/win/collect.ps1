<#
.SYNOPSIS
  Gathers logs, results, and screenshots into one zip to copy back to the Mac. Leaves out everything that holds a credential:
  the claude\ folder, agent\ (auth.json, sessions), gui.json / start.json (the GUI URL is a credential), tools\, and git configuration.
#>
param([string]$Out = (Join-Path $env:USERPROFILE 'sbd-collected.zip'))

. (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'lib.ps1')
$stage = Join-Path $env:TEMP ('sbd-collect-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stage -Force | Out-Null
try {
    foreach ($d in @('logs', 'results')) {
        $src = Join-Path $SbdRoot $d
        if (Test-Path -LiteralPath $src) { Copy-Item -LiteralPath $src -Destination (Join-Path $stage $d) -Recurse -Force }
    }
    $state = Join-Path $stage 'state'
    New-Item -ItemType Directory -Path $state -Force | Out-Null
    $bs = Join-Path $StateDir 'bootstrap-state.json'
    if (Test-Path -LiteralPath $bs) { Copy-Item -LiteralPath $bs -Destination $state }
    $st = Join-Path $AgentDir 'settings.json'
    if (Test-Path -LiteralPath $st) { Copy-Item -LiteralPath $st -Destination (Join-Path $stage 'agent-settings.json') }
    $mine = Join-Path $AgentDir 'herdr-agents\config.json'
    if (Test-Path -LiteralPath $mine) { Copy-Item -LiteralPath $mine -Destination (Join-Path $stage 'herdr-agents-config.json') }
    $shots = Join-Path $env:USERPROFILE 'sbd-shots'
    if (Test-Path -LiteralPath $shots) { Copy-Item -LiteralPath $shots -Destination (Join-Path $stage 'shots') -Recurse -Force }
    # Strip the GUI token from any copied log line.
    foreach ($f in (Get-ChildItem -LiteralPath $stage -Recurse -File -Include '*.jsonl', '*.json', '*.log', '*.txt')) {
        $text = Get-Content -LiteralPath $f.FullName -Raw -ErrorAction SilentlyContinue
        if ($text) {
            $clean = [regex]::Replace($text, 'http://127\.0\.0\.1:(\d+)/[0-9a-f]{16,}/', 'http://127.0.0.1:$1/<token>/')
            if ($clean -ne $text) { Write-AllTextUtf8 $f.FullName $clean }
        }
    }
    $info = Get-OsInfo
    Write-JsonFile (Join-Path $stage 'os.json') $info
    if (Test-Path -LiteralPath $Out) { Remove-Item -LiteralPath $Out -Force }
    $tar = Join-Path $env:SystemRoot 'System32\tar.exe'
    $r = Invoke-Native -File $tar -ArgList @('-a', '-cf', $Out, '-C', $stage, '.') -TimeoutSec 300
    if ($r.ExitCode -ne 0) { throw "tar failed: $($r.StdErr)" }
    Write-Host "collected -> $Out ($([int]((Get-Item -LiteralPath $Out).Length / 1KB)) KB)"
} finally {
    if ($stage -and (Test-Path -LiteralPath $stage) -and $stage.StartsWith($env:TEMP)) { Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue }
}
