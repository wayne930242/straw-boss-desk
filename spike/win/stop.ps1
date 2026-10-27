<#
.SYNOPSIS
  Stops only what start.ps1 started (the sb server, the herdr server, the panes under it), using the pids and start times it recorded.
  Order: `cli.mjs stop` for the kit's own state folder and Herdr socket first, then the workspaces, then `herdr server stop`.
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

# The sb server (pi-straw-boss 0.45.0+) is created outside the herdr server's process tree (WMI breakaway on Windows), so
# `herdr server stop` never reaches it. `cli.mjs stop` works from the kit's state folder and socket (the environment Set-SbdEnv
# set) and needs no running herdr. Its pid comes from start.json, else from `cli.mjs status`.
$sbCli = Join-Path $t.AgentNm 'pi-straw-boss\dist\server\cli.mjs'
$sbPid = 0
$sbStart = $null
if ($s.sbServerPid) { $sbPid = [int]$s.sbServerPid; $sbStart = $s.sbServerStart }
if ((Test-Path -LiteralPath $sbCli) -and (Test-Path -LiteralPath $t.NodeExe)) {
    if ($sbPid -eq 0) {
        $st = Invoke-Native -File $t.NodeExe -ArgList @($sbCli, 'status') -TimeoutSec 30
        try { $sj = ($st.StdOut -split "`r?`n" | Where-Object { $_.Trim().StartsWith('{') } | Select-Object -Last 1) | ConvertFrom-Json; if ($sj.pid) { $sbPid = [int]$sj.pid; $sbStart = Get-ProcessStartIso $sbPid } } catch { }
    }
    $sr = Invoke-Native -File $t.NodeExe -ArgList @($sbCli, 'stop') -TimeoutSec 60
    Write-Log 'stop' 'sb-server-stop' @{ exit = $sr.ExitCode; pid = $sbPid; detail = (Get-FirstLine ($sr.StdOut + $sr.StdErr)) }
}
if ($sbPid -gt 0) {
    for ($i = 0; $i -lt 20; $i++) {
        if (-not (Test-ProcessAlive -ProcessId $sbPid -StartTime $sbStart)) { break }
        Start-Sleep -Milliseconds 500
    }
}

# herdr restores workspaces and resumes pi panes on its next start, but straw-boss's roles (workspace `tower` token,
# pane sb_role) do not come back with them, so every restored session lands as a member (VM 2026-10-26; upstream gap).
# Until straw-boss re-derives roles after a restore, close every workspace first so the next start is clean.
if ($alive -and (Test-Path -LiteralPath $t.HerdrExe)) {
    $wl = Invoke-Native -File $t.HerdrExe -ArgList @('workspace', 'list') -TimeoutSec 15
    $ids = @()
    try { $ids = @(($wl.StdOut | ConvertFrom-Json).result.workspaces | ForEach-Object { $_.workspace_id }) } catch { }
    foreach ($id in $ids) { [void](Invoke-Native -File $t.HerdrExe -ArgList @('workspace', 'close', $id) -TimeoutSec 15) }
    Write-Log 'stop' 'workspaces-closed' @{ closed = $ids }
}

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
# pi-intercom's broker is detached from the pi that spawned it and outlives the stack, keeping that pi's environment;
# stop it only when broker.pid names a node process running pi-intercom's broker in this agent dir.
$brokerPidFile = Join-Path $AgentDir 'intercom\broker.pid'
if (Test-Path -LiteralPath $brokerPidFile) {
    $brokerPid = 0
    [void][int]::TryParse((Get-Content -LiteralPath $brokerPidFile -Raw).Trim(), [ref]$brokerPid)
    $bp = if ($brokerPid -gt 0) { Get-CimInstance Win32_Process -Filter "ProcessId=$brokerPid" -ErrorAction SilentlyContinue }
    if ($bp -and $bp.Name -eq 'node.exe' -and $bp.CommandLine -match 'pi-intercom' -and $bp.CommandLine -match 'broker') {
        & taskkill.exe /PID $brokerPid /T /F 2>&1 | Out-Null
        $left += "$brokerPid intercom-broker"
    }
}
Start-Sleep -Milliseconds 700
$still = @()
# The recorded sb server pid must be gone; one that ignored `stop` is ours (same start time) and goes now.
if ($sbPid -gt 0 -and (Test-ProcessAlive -ProcessId $sbPid -StartTime $sbStart)) {
    & taskkill.exe /PID $sbPid /T /F 2>&1 | Out-Null
    $left += "$sbPid sb-server"
    Start-Sleep -Milliseconds 500
    if (Test-ProcessAlive -ProcessId $sbPid -StartTime $sbStart) { $still += "$sbPid sb-server" }
}
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
