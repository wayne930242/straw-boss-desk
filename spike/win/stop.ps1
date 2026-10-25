<#
.SYNOPSIS
  Stops only what start.ps1 started (herdr server, the panes under it), using the pids and start times it recorded.
#>
. (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'lib.ps1')
$script:LogFile = Join-Path $LogDir 'start.jsonl'
Set-SbdEnv
$t = Get-ToolPaths
$startFile = Join-Path $StateDir 'start.json'
$s = Read-JsonFile $startFile
if (-not $s) { Write-Host 'nothing recorded; nothing to stop'; exit 0 }

$serverPid = [int]$s.serverPid
$alive = Test-ProcessAlive -ProcessId $serverPid -StartTime $s.serverStart
# Refresh the tree while the server is still up: panes opened after start (members) are ours too.
$tree = @()
if ($alive) { $tree = @(Get-ProcessTree $serverPid) }
$known = @($tree) + @($s.tree)
Write-Log 'stop' 'begin' @{ serverPid = $serverPid; alive = $alive; children = @($tree).Count }

if ($alive -and (Test-Path -LiteralPath $t.HerdrExe)) {
    $r = Invoke-Native -File $t.HerdrExe -ArgList @('server', 'stop') -TimeoutSec 30
    Write-Log 'stop' 'herdr-server-stop' @{ exit = $r.ExitCode; detail = (Get-FirstLine ($r.StdOut + $r.StdErr)) }
    for ($i = 0; $i -lt 20; $i++) {
        if (-not (Test-ProcessAlive -ProcessId $serverPid -StartTime $s.serverStart)) { break }
        Start-Sleep -Milliseconds 500
    }
}

# Whatever of the recorded set still runs with the same start time is ours and goes now.
$left = @()
foreach ($k in $known) {
    if (-not $k -or -not $k.Pid) { continue }
    if (Test-ProcessAlive -ProcessId ([int]$k.Pid) -StartTime $k.Created) {
        & taskkill.exe /PID $k.Pid /T /F 2>&1 | Out-Null
        $left += "$($k.Pid) $($k.Name)"
    }
}
if (Test-ProcessAlive -ProcessId $serverPid -StartTime $s.serverStart) {
    & taskkill.exe /PID $serverPid /T /F 2>&1 | Out-Null
    $left += "$serverPid herdr(server)"
}
Start-Sleep -Milliseconds 700
$still = @()
foreach ($k in $known) { if ($k -and $k.Pid -and (Test-ProcessAlive -ProcessId ([int]$k.Pid) -StartTime $k.Created)) { $still += $k.Pid } }
if (Test-ProcessAlive -ProcessId $serverPid -StartTime $s.serverStart) { $still += $serverPid }

foreach ($f in @('gui.json', 'gui.lock', 'gui.lock.stale')) {
    $p = Join-Path $AgentDir "straw-boss\$f"
    if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Recurse -Force -ErrorAction SilentlyContinue }
}
$sockPath = $s.socket
if ($sockPath -and (Test-Path -LiteralPath $sockPath)) { Remove-Item -LiteralPath $sockPath -Force -ErrorAction SilentlyContinue }
Remove-Item -LiteralPath $startFile -Force -ErrorAction SilentlyContinue
Write-Log 'stop' 'end' @{ forceKilled = $left; stillRunning = $still }
if ($still.Count -gt 0) { Write-Host "STILL RUNNING: $($still -join ', ')"; exit 1 }
Write-Host 'stopped'
