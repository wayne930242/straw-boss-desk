<#
.SYNOPSIS
  Stops only what start.ps1 started (the sb server, the herdr server, the panes under it), using the pids and start times it recorded.
.DESCRIPTION
  Order (desk B7 plan, "Stop order"):
    1. `cli.mjs stop` (120 s on Windows). It marks the server stopped on purpose, so a pi session's look does not start a new one while herdr shuts down.
       Exit 0 is done; exit 1 (busy lock, unreachable, scope, exit-timeout) goes on to step 2; exit 3 (acl) is reported; exit 5 (a `serve` server of a
       supervisor) is reported and the server is NOT killed.
    2. Wait 10 s for the recorded sb server pid to go; one that stays is killed by pid only while its recorded start time matches.
    3. `herdr server stop`, then wait for its pid. Workspaces are NOT closed: herdr restores them at the next start (Q3).
    4. Kill whatever of the recorded process tree still runs with its recorded start time; the pi-intercom broker only when broker.pid in this agent dir
       names a node process that runs pi-intercom's broker with the kit root in its command line.
    5. gui.json and server.json stay: the server owns them, and server.json's gui.port is how the next start keeps the port. start.json is removed
       when nothing recorded is left running (kept otherwise, so a second run of this script can finish the job).
  Exit codes: 0 stopped (or nothing recorded); 1 a recorded process still runs.
#>
. (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'lib.ps1')
# The app reads this script's stdout as UTF-8. A piped Windows console writes the OEM code page, which turned the profile's non-ASCII folder name in SB_DIR
# into U+FFFD (VM 2026-10-28) and left the app's follower unable to open the slot folder.
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }
$script:LogFile = Join-Path $LogDir 'start.jsonl'
Set-SbdEnv
$t = Get-ToolPaths
$startFile = Join-Path $StateDir 'start.json'
$s = Read-JsonFile $startFile
if (-not $s) { Write-Host 'nothing recorded; nothing to stop'; exit 0 }

$serverPid = [int]$s.serverPid
# A record without a start time is not ours: nothing of it is touched.
$serverStartOk = [bool]$s.serverStart
$alive = $serverStartOk -and (Test-ProcessAlive -ProcessId $serverPid -StartTime $s.serverStart)
# Refresh the tree while the server is still up: panes opened after start (members) are ours too.
$tree = @()
if ($alive) { $tree = @(Get-ProcessTree $serverPid) }
$known = @($tree) + @($s.tree)
Write-Log 'stop' 'begin' @{ serverPid = $serverPid; alive = $alive; children = @($tree).Count }

# 1. The sb server (pi-straw-boss 0.45.0+) is created outside the herdr server's process tree (WMI breakaway on Windows), so
# `herdr server stop` never reaches it. `cli.mjs stop` works from the kit's state folder and socket (the environment Set-SbdEnv
# set) and needs no running herdr. Its pid comes from start.json, else from `cli.mjs status`.
$sbCli = Join-Path $t.AgentNm 'pi-straw-boss\dist\server\cli.mjs'
$sbPid = 0
$sbStart = $null
$killSb = $true
if ($s.sbServerPid) { $sbPid = [int]$s.sbServerPid; $sbStart = $s.sbServerStart }
# The server may have restarted since start.ps1 recorded it (a restart, an upgrade, a crash and a new start): the record in its own folder names the one that runs now.
# Adopted only when the record is live evidence: it has `started`, is not `stopped:true`, and the process holds that start time (a pid alone proves nothing).
if ($s.sbServerRecord) {
    $cur = Read-JsonFile ([string]$s.sbServerRecord)
    if ($cur -and $cur.pid -and $cur.started -and ($cur.stopped -ne $true) -and (([int]$cur.pid -ne $sbPid) -or -not $sbStart) -and (Test-ProcessAlive -ProcessId ([int]$cur.pid) -StartTime $cur.started)) {
        $sbPid = [int]$cur.pid
        $sbStart = $cur.started
        Write-Log 'stop' 'sb-server-moved' @{ pid = $sbPid; detail = 'the running sb server is not the one start.ps1 recorded' }
    }
}
if ((Test-Path -LiteralPath $sbCli) -and (Test-Path -LiteralPath $t.NodeExe)) {
    if ($sbPid -eq 0) {
        $st = Invoke-Native -File $t.NodeExe -ArgList @($sbCli, 'status') -TimeoutSec 60
        try { $sj = ($st.StdOut -split "`r?`n" | Where-Object { $_.Trim().StartsWith('{') } | Select-Object -Last 1) | ConvertFrom-Json; if ($sj.pid -and $sj.started -and ($sj.state -ne 'stopped') -and ($sj.stopped -ne $true) -and (Test-ProcessAlive -ProcessId ([int]$sj.pid) -StartTime $sj.started)) { $sbPid = [int]$sj.pid; $sbStart = $sj.started } } catch { }
    }
    $sr = Invoke-Native -File $t.NodeExe -ArgList @($sbCli, 'stop') -TimeoutSec 120
    $outcome = ''
    try { $oj = ($sr.StdOut -split "`r?`n" | Where-Object { $_.Trim().StartsWith('{') } | Select-Object -Last 1) | ConvertFrom-Json; if ($oj.outcome) { $outcome = [string]$oj.outcome } } catch { }
    # stderr always opens with a warning line about stopping on purpose; the reason of a failure is its last line.
    $why = ''
    if ($sr.ExitCode -ne 0) { $why = Hide-Token (@(($sr.StdErr + "`n" + $sr.StdOut) -split "`r?`n" | Where-Object { $_.Trim() -and $_ -notmatch '^Stopping the sb server on purpose' }) | Select-Object -Last 1) }
    Write-Log 'stop' 'sb-server-stop' @{ exit = $sr.ExitCode; ms = $sr.Ms; timedOut = $sr.TimedOut; outcome = $outcome; pid = $sbPid; detail = $why }
    if ($sr.ExitCode -eq 5) {
        # A `serve` server belongs to a supervisor: never expected for the desk, and not ours to kill.
        $killSb = $false
        Write-Host "REPORT: the sb server is a serve server (a supervisor's); not stopped: $why"
    } elseif ($sr.ExitCode -eq 3) {
        Write-Host "REPORT: cli.mjs stop was refused (acl): $why"
    } elseif ($sr.ExitCode -ne 0) {
        Write-Host "REPORT: cli.mjs stop exit $($sr.ExitCode): $why"
    }
}
# 2. Wait for the server to leave; one that stays is killed by pid only while the recorded start time matches (a pid without a start time is never killed).
if ($sbPid -gt 0) {
    for ($i = 0; $i -lt 20; $i++) {
        if (-not $sbStart -or -not (Test-ProcessAlive -ProcessId $sbPid -StartTime $sbStart)) { break }
        Start-Sleep -Milliseconds 500
    }
}
$left = @()
$still = @()
if ($killSb -and $sbPid -gt 0 -and $sbStart -and (Test-ProcessAlive -ProcessId $sbPid -StartTime $sbStart)) {
    [void](Stop-ProcessTree -ProcessId $sbPid -StartTime $sbStart)
    $left += "$sbPid sb-server"
    Start-Sleep -Milliseconds 500
}

# 3. herdr stops after the sb server: if it stopped first, a detached server would run on, and the panes' pi sessions could start another in between.
# The workspaces are left open on purpose: herdr restores them (and resumes their pi panes) at the next start, which keeps the PM's bases.
if ($alive -and (Test-Path -LiteralPath $t.HerdrExe)) {
    $r = Invoke-Native -File $t.HerdrExe -ArgList @('server', 'stop') -TimeoutSec 30
    Write-Log 'stop' 'herdr-server-stop' @{ exit = $r.ExitCode; ms = $r.Ms; detail = (Get-FirstLine ($r.StdOut + $r.StdErr)) }
    for ($i = 0; $i -lt 20; $i++) {
        if (-not (Test-ProcessAlive -ProcessId $serverPid -StartTime $s.serverStart)) { break }
        Start-Sleep -Milliseconds 500
    }
}

# 4. Whatever of the recorded set still runs with the same start time is ours and goes now.
foreach ($k in $known) {
    if (-not $k -or -not $k.Pid) { continue }
    if (Test-ProcessAlive -ProcessId ([int]$k.Pid) -StartTime $k.Created) {
        [void](Stop-ProcessTree -ProcessId ([int]$k.Pid) -StartTime $k.Created)
        $left += "$($k.Pid) $($k.Name)"
    }
}
if ($serverStartOk -and (Test-ProcessAlive -ProcessId $serverPid -StartTime $s.serverStart)) {
    [void](Stop-ProcessTree -ProcessId $serverPid -StartTime $s.serverStart)
    $left += "$serverPid herdr(server)"
}
# pi-intercom's broker is detached from the pi that spawned it and outlives the stack, keeping that pi's environment;
# stop it only when broker.pid names a node process running pi-intercom's broker in this agent dir.
$brokerPidFile = Join-Path $AgentDir 'intercom\broker.pid'
if (Test-Path -LiteralPath $brokerPidFile) {
    $brokerPid = 0
    # ReadAllText: Get-Content -Raw on an empty file outputs nothing, and [string] of nothing is $null in Windows PowerShell 5.1 (VM 2026-10-28).
    $brokerText = ''
    try { $brokerText = [IO.File]::ReadAllText($brokerPidFile) } catch { }
    [void][int]::TryParse($brokerText.Trim(), [ref]$brokerPid)
    $bp = if ($brokerPid -gt 0) { Get-CimInstance Win32_Process -Filter "ProcessId=$brokerPid" -ErrorAction SilentlyContinue }
    if ($bp -and $bp.Name -eq 'node.exe' -and $bp.CommandLine -match 'pi-intercom' -and $bp.CommandLine -match 'broker' -and $bp.CommandLine.IndexOf($SbdRoot.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase) -ge 0) {
        $brokerStart = $null
        try { if ($bp.CreationDate) { $brokerStart = $bp.CreationDate.ToUniversalTime() } } catch { }
        [void](Stop-ProcessTree -ProcessId $brokerPid -StartTime $brokerStart)
        $left += "$brokerPid intercom-broker"
    }
}
Start-Sleep -Milliseconds 700
if ($sbPid -gt 0 -and $sbStart -and (Test-ProcessAlive -ProcessId $sbPid -StartTime $sbStart)) { $still += "$sbPid sb-server" }
foreach ($k in $known) { if ($k -and $k.Pid -and (Test-ProcessAlive -ProcessId ([int]$k.Pid) -StartTime $k.Created)) { $still += $k.Pid } }
if ($serverStartOk -and (Test-ProcessAlive -ProcessId $serverPid -StartTime $s.serverStart)) { $still += $serverPid }

# 5. gui.json, gui.lock and server.json are the sb server's and stay (server.json's gui.port is how the next start keeps the port).
# Only herdr's own stale socket marker is cleared, and only once its server is gone.
$sockPath = $s.socket
if ($sockPath -and (Test-Path -LiteralPath $sockPath) -and -not ($serverStartOk -and (Test-ProcessAlive -ProcessId $serverPid -StartTime $s.serverStart))) { Remove-Item -LiteralPath $sockPath -Force -ErrorAction SilentlyContinue }
if ($still.Count -eq 0) { Remove-Item -LiteralPath $startFile -Force -ErrorAction SilentlyContinue }
Write-Log 'stop' 'end' @{ forceKilled = $left; stillRunning = $still }
if ($still.Count -gt 0) { Write-Host "STILL RUNNING: $($still -join ', ')"; exit 1 }
Write-Host 'stopped'
