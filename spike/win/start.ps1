<#
.SYNOPSIS
  Starts a headless herdr server and the pi-straw-boss sb server, prints the GUI URL, then makes sure a tower pi session exists.
.DESCRIPTION
  Uses only published CLIs (herdr, node cli.mjs of pi-straw-boss, pi). Isolated: its own XDG_CONFIG_HOME with herdr's default socket under it
  (so the sb server is the PRIMARY server of this environment), its own PI_CODING_AGENT_DIR, STRAW_BOSS_DESK=1. Records what it started in
  state\start.json so stop.ps1 stops only that.
  Order (desk B7 plan, "Start order, now (0.46.0)"):
    1. herdr server (reused only when its pid and start time match and start.json records the same environment fingerprint)
    2. `cli.mjs up --timeout 90 --exact`: the sb server and the GUI; the URL comes from its answer, no file is read
    3. print GUI_URL= and SB_DIR= (nothing below delays them)
    4. tower stopgap until pi-straw-boss B7: reuse the tower herdr restored, else create one. A failure here is a NOTICE=, not a failed start.
  Lines on stdout: GUI_URL=<url>, SB_DIR=<slot folder>, NOTICE=<text>. The URL holds the page token: it is printed only here and never logged.
  Exit codes: 0 done; 2 a tool is missing (run bootstrap); 3 a stack from another environment or an unrecorded herdr is running (run stop.ps1);
  4 herdr server silent; 8 reserved; up failed: 10 lock, 11 start, 12 hello, 13 exit, 14 herdr, 15 version, 16 server, 17 gui, 18 other,
  19 server cannot run (up exit 3: loader, intercom, acl), 20 up usage error (a bug here), 21 up answered without a usable URL, 22 the sb server
  is not in the primary slot.
  Spike hack still listed in RUNBOOK.md: the tower is a herdr workspace whose shell has STRAW_BOSS_ROLE=tower, with pi started through `herdr agent start`.
#>
param(
    [int]$ServerTimeoutSec = 45,
    [int]$UpTimeoutSec = 90,
    [int]$RestoreTimeoutSec = 90,
    [switch]$NoTower
)

. (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'lib.ps1')
$script:LogFile = Join-Path $LogDir 'start.jsonl'
Set-SbdEnv
$t = Get-ToolPaths
$startFile = Join-Path $StateDir 'start.json'
$primaryDir = [IO.Path]::GetFullPath((Join-Path $AgentDir 'straw-boss')).TrimEnd('\')

$sbCli = Join-Path $t.AgentNm 'pi-straw-boss\dist\server\cli.mjs'
foreach ($f in @($t.HerdrExe, $t.PiCmd, $t.NodeExe, $t.BashExe, $sbCli)) {
    if (-not (Test-Path -LiteralPath $f)) { Write-Log 'start' 'fail' @{ detail = "missing $f - run bootstrap.ps1 first" }; exit 2 }
}
if (-not (Test-Path -LiteralPath $WorkDir)) { New-Item -ItemType Directory -Path $WorkDir -Force | Out-Null }

function Invoke-Herdr {
    param([string[]]$ArgList, [int]$TimeoutSec = 30)
    Invoke-Native -File $t.HerdrExe -ArgList $ArgList -TimeoutSec $TimeoutSec
}

function Test-HerdrAnswers {
    param([int]$TimeoutSec = 10)
    $r = Invoke-Herdr @('workspace', 'list') $TimeoutSec
    return ($r.ExitCode -eq 0)
}

# The last line of a command's output that is a JSON object (cli.mjs prints one on stdout when it works, one on stderr when `up` fails).
function Get-JsonLine {
    param([string]$Text)
    $found = $null
    foreach ($line in @($Text -split "`r?`n" | Where-Object { $_.Trim().StartsWith('{') })) {
        try { $found = $line | ConvertFrom-Json } catch { }
    }
    return $found
}

# ConvertFrom-Json on Windows PowerShell 5.1 turns ISO strings into DateTime; state is written back as ISO text only.
function Format-Iso {
    param($Value)
    $u = ConvertTo-UtcInstant $Value
    if ($null -eq $u) { return $null }
    return $u.ToString('o')
}

function Add-Notice {
    param([string]$Text)
    $clean = Hide-Token (Get-FirstLine $Text)
    Write-Log 'start' 'notice' @{ detail = $clean }
    Write-Host "NOTICE=$clean"
}

$total = [Diagnostics.Stopwatch]::StartNew()
Write-Log 'start' 'begin' @{ os = (Get-OsInfo); socket = $env:HERDR_SOCKET_PATH; xdg = $env:XDG_CONFIG_HOME; agentDir = $AgentDir; desk = $env:STRAW_BOSS_DESK }

# What a reused herdr server must have been started with. A server started by an older kit, or under another config home, is not ours to reuse.
$fingerprint = [ordered]@{ desk = $true; socket = $env:HERDR_SOCKET_PATH; xdg = $env:XDG_CONFIG_HOME; agentDir = $AgentDir }
function Test-Fingerprint {
    param($Rec)
    $f = $Rec.fingerprint
    if (-not $f) { return $false }
    return (($f.desk -eq $true) -and ($f.socket -eq $fingerprint.socket) -and ($f.xdg -eq $fingerprint.xdg) -and ($f.agentDir -eq $fingerprint.agentDir))
}

# ---- 1. herdr server ----
$sw = [Diagnostics.Stopwatch]::StartNew()
$prev = Read-JsonFile $startFile
$state = [ordered]@{}
if ($prev -and $prev.serverPid -and (Test-ProcessAlive -ProcessId ([int]$prev.serverPid) -StartTime $prev.serverStart)) {
    if (-not (Test-Fingerprint $prev)) {
        Write-Log 'start' 'fail' @{ detail = 'a herdr server from another start (older kit or another environment) is recorded and running; run stop.ps1 first' }
        exit 3
    }
    $serverPid = [int]$prev.serverPid
    $serverStart = Format-Iso $prev.serverStart
    $up = $false
    for ($i = 0; $i -lt $ServerTimeoutSec * 2; $i++) {
        if (Test-HerdrAnswers 10) { $up = $true; break }
        Start-Sleep -Milliseconds 500
    }
    if (-not $up) {
        Write-Log 'start' 'fail' @{ detail = 'the recorded herdr server is alive but does not answer; run stop.ps1 first' }
        exit 4
    }
    $state['serverPid'] = $serverPid
    $state['serverStart'] = $serverStart
    $state['startedAt'] = Format-Iso $prev.startedAt
    $state['herdrReused'] = $true
    Write-Log 'start' 'herdr-reused' @{ ms = [int]$sw.ElapsedMilliseconds; serverPid = $serverPid }
} else {
    # A herdr that answers on our socket without a record in start.json cannot be stopped by pid later: do not start a second one beside it.
    if (Test-HerdrAnswers 8) {
        Write-Log 'start' 'fail' @{ detail = 'a herdr server answers on the kit socket but start.json does not record it; run stop.ps1 or end it by hand' }
        exit 3
    }
    # herdr on Windows rebuilds a new pane's PATH from the registry instead of inheriting the server's (verified in the VM 2026-10-25),
    # so bootstrap's user-path stage puts tools\npm (with a node.exe copy next to the npm shims) on the user PATH.
    # No -RedirectStandard*: a redirect makes Start-Process pass bInheritHandles=TRUE, so the long-lived server would inherit the pipes
    # of whoever runs this script (ssh, checks.ps1) and keep them open after the script ends. Without a redirect Start-Process goes
    # through ShellExecute, which inherits no handles.
    $server = Start-Process -FilePath $t.HerdrExe -ArgumentList 'server' -WindowStyle Hidden -PassThru
    $serverPid = $server.Id
    $serverStart = Get-ProcessStartIso $serverPid
    $up = $false
    for ($i = 0; $i -lt $ServerTimeoutSec * 2; $i++) {
        Start-Sleep -Milliseconds 500
        if ($server.HasExited) { break }
        if (Test-HerdrAnswers 10) { $up = $true; break }
    }
    if (-not $up) {
        Write-Log 'start' 'fail' @{ detail = 'herdr server did not answer'; exited = $server.HasExited }
        if (-not $server.HasExited) { & taskkill.exe /PID $serverPid /T /F | Out-Null }
        exit 4
    }
    $state['serverPid'] = $serverPid
    $state['serverStart'] = $serverStart
    $state['startedAt'] = (Get-Date).ToUniversalTime().ToString('o')
    $state['herdrReused'] = $false
    Write-Log 'start' 'server-up' @{ ms = [int]$sw.ElapsedMilliseconds; serverPid = $serverPid }
}
$status = Invoke-Herdr @('status', '--json') 15
Set-Content -LiteralPath (Join-Path $LogDir 'herdr-status.json') -Value $status.StdOut -Encoding UTF8

# Record now, so stop.ps1 can clean up even if a later step fails.
$state['socket'] = $env:HERDR_SOCKET_PATH
$state['fingerprint'] = $fingerprint
Write-JsonFile $startFile $state

# ---- 2. the sb server and the GUI: `cli.mjs up` ----
# Every pi that herdr starts then finds a live server. The URL comes from `up`'s own answer (the server's, already answering 200); no file is read.
function Invoke-SbUp {
    $r = Invoke-Native -File $t.NodeExe -ArgList @($sbCli, 'up', '--timeout', [string]$UpTimeoutSec, '--exact') -TimeoutSec ($UpTimeoutSec + 30)
    [pscustomobject]@{ Exit = $r.ExitCode; Ok = (Get-JsonLine $r.StdOut); Err = (Get-JsonLine $r.StdErr); Raw = $r }
}

# Which row of the plan's `up` exit table an answer is. 'ok' also needs a URL.
function Get-UpClass {
    param($U)
    if ($U.Exit -eq 0) { if ($U.Ok -and $U.Ok.url) { return 'ok' } else { return 'nourl' } }
    if ($U.Exit -eq 2) { return 'usage' }
    if ($U.Exit -eq 3) {
        $code = ''
        if ($U.Err -and $U.Err.startError) { $code = [string]$U.Err.startError.code }
        if ($code -eq 'loader' -or $code -eq 'intercom' -or $code -eq 'acl') { return $code }
        return 'cannotrun'
    }
    if ($U.Exit -eq 1 -and $U.Err) {
        $step = [string]$U.Err.step
        $wait = [string]$U.Err.wait
        if ($wait -eq 'lock' -or $wait -eq 'start' -or $wait -eq 'hello' -or $wait -eq 'exit') { return $wait }
        if ($step -eq 'herdr' -or $step -eq 'version' -or $step -eq 'server' -or $step -eq 'gui') { return $step }
    }
    return 'other'
}

$upExitCode = @{ 'lock' = 10; 'start' = 11; 'hello' = 12; 'exit' = 13; 'herdr' = 14; 'version' = 15; 'server' = 16; 'gui' = 17; 'other' = 18; 'cannotrun' = 19; 'loader' = 19; 'intercom' = 19; 'acl' = 19; 'usage' = 20; 'nourl' = 21 }

function Stop-WithUpFailure {
    param([string]$Class, $U)
    $reason = ''
    $startErr = $null
    if ($U.Err) {
        $reason = [string]$U.Err.reason
        $startErr = $U.Err.startError
    }
    if (-not $reason) { $reason = (Get-FirstLine ($U.Raw.StdErr + $U.Raw.StdOut)) }
    $data = @{ detail = ("sb server up failed - " + $Class + ": " + (Hide-Token (Get-FirstLine $reason))); class = $Class; exit = $U.Exit; timedOut = $U.Raw.TimedOut }
    if ($U.Err) { $data['step'] = [string]$U.Err.step; $data['wait'] = [string]$U.Err.wait }
    if ($startErr) { $data['startError'] = [string]$startErr.code; $data['startErrorText'] = (Hide-Token ([string]$startErr.text)) }
    Write-Log 'start' 'fail' $data
    # The log's tail is what a person needs for a start that did not answer or a GUI that did not start.
    if ($Class -eq 'start' -or $Class -eq 'gui' -or $Class -eq 'other' -or $Class -eq 'hello') {
        $tail = Invoke-Native -File $t.NodeExe -ArgList @($sbCli, 'logs', '--lines', '40') -TimeoutSec 60
        Set-Content -LiteralPath (Join-Path $LogDir 'start-sb-log-tail.txt') -Value (Hide-Token $tail.StdOut) -Encoding UTF8
    }
    Set-Content -LiteralPath (Join-Path $LogDir 'start-up-stderr.txt') -Value (Hide-Token $U.Raw.StdErr) -Encoding UTF8
    if ($startErr -and $startErr.text) { Write-Host ("FAIL " + $Class + ": " + (Hide-Token ([string]$startErr.text))) }
    else { Write-Host ("FAIL " + $Class + ": " + (Hide-Token (Get-FirstLine $reason))) }
    exit $upExitCode[$Class]
}

# loader (tsx missing) and intercom (pi-intercom older than 0.18.1) are repaired by reinstalling the pinned pi package through the bootstrap's own stage.
function Invoke-PackageRepair {
    param([string]$Code)
    $pkg = 'pkg:pi-straw-boss'
    if ($Code -eq 'intercom') { $pkg = 'pkg:pi-intercom' }
    $psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $r = Invoke-Native -File $psExe -ArgList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $KitDir 'bootstrap.ps1'), '-Only', $pkg, '-Force') -TimeoutSec 1800
    Write-Log 'start' 'repair' @{ code = $Code; stage = $pkg; exit = $r.ExitCode; ms = $r.Ms; detail = (Get-FirstLine $r.StdOut) }
    return ($r.ExitCode -eq 0)
}

$sw.Restart()
$attempts = @{}
$upJson = $null
for ($round = 1; $round -le 8 -and -not $upJson; $round++) {
    $u = Invoke-SbUp
    $class = Get-UpClass $u
    if ($class -eq 'ok') { $upJson = $u.Ok; break }
    $tried = [int]$attempts[$class]
    Write-Log 'start' 'up-attempt-failed' @{ round = $round; class = $class; exit = $u.Exit; ms = $u.Raw.Ms; detail = (Hide-Token (Get-FirstLine ([string]$u.Err.reason))) }
    $retry = $false
    if ($tried -eq 0) {
        switch ($class) {
            # A start under way ahead of this call, or another requester's, did not finish: one more `up`.
            'lock'  { $retry = $true }
            'hello' { $retry = $true }
            'exit'  { $retry = $true }
            'herdr' {
                # A record that serves another socket is a broken install and is shown; a silent herdr gets one more look.
                if (([string]$u.Err.reason) -notmatch 'serves') {
                    for ($i = 0; $i -lt 30 -and -not $retry; $i++) { if (Test-HerdrAnswers 10) { $retry = $true } else { Start-Sleep -Milliseconds 500 } }
                }
            }
            'version' {
                # --exact: the running server is newer than the pin, and the pin is this kit's decision.
                $d = Invoke-Native -File $t.NodeExe -ArgList @($sbCli, 'restart', '--downgrade', '--reason', 'stack.json pin') -TimeoutSec 150
                Write-Log 'start' 'downgrade' @{ exit = $d.ExitCode; detail = (Hide-Token (Get-FirstLine ($d.StdErr + $d.StdOut))) }
                $retry = ($d.ExitCode -eq 0)
            }
            'loader' { $retry = Invoke-PackageRepair 'loader' }
            'intercom' { $retry = Invoke-PackageRepair 'intercom' }
        }
    }
    if (-not $retry) { Stop-WithUpFailure $class $u }
    $attempts[$class] = $tried + 1
    Start-Sleep -Seconds 1
}
if (-not $upJson) { Stop-WithUpFailure 'other' $u }

$sbPid = [int]$upJson.pid
# `started` may be absent when the server does not know its own start time yet (it arrives late on Windows): read it from the process then.
$sbStart = $null
if ($upJson.started) { $sbStart = Format-Iso $upJson.started } else { $sbStart = Get-ProcessStartIso $sbPid }
$sbLog = [string]$upJson.log
$sbDir = ''
if ($sbLog) { $sbDir = [IO.Path]::GetFullPath((Split-Path -Parent $sbLog)).TrimEnd('\') }
$warnCodes = @($upJson.warnings | ForEach-Object { $_.code })
Write-Log 'start' 'sb-server-up' @{ ms = [int]$sw.ElapsedMilliseconds; pid = $sbPid; version = $upJson.version; server = $upJson.server; mode = $upJson.mode; desk = $upJson.desk; log = $sbLog; steps = @($upJson.steps | ForEach-Object { $_.name + '=' + $_.ms }); warnings = $warnCodes }

$state['sbServerPid'] = $sbPid
$state['sbServerStart'] = $sbStart
$state['sbServerLog'] = $sbLog
$state['sbDir'] = $sbDir
$state['sbServerRecord'] = if ($sbDir) { Join-Path $sbDir 'server.json' } else { $null }
Write-JsonFile $startFile $state

# The URL is checked for its shape only; its token is never logged.
$url = [string]$upJson.url
if ($url -notmatch '^http://127\.0\.0\.1:\d+/[0-9a-f]{16,}/$') {
    Write-Log 'start' 'fail' @{ detail = 'up answered with a URL of an unexpected shape (not logged)' }
    Write-Host 'FAIL nourl: up answered with a URL of an unexpected shape'
    exit 21
}
# Q1: the kit's server must be the primary one, whose files sit in <agent dir>\straw-boss itself. Anything else means the server computed another slot
# than this script's environment names (XDG_CONFIG_HOME or HERDR_SOCKET_PATH did not reach it).
if ($sbDir -ne $primaryDir) {
    Write-Log 'start' 'fail' @{ detail = "the sb server is not in the primary slot: its folder is $sbDir, expected $primaryDir" }
    Write-Host "FAIL slot: the sb server is not in the primary slot ($sbDir)"
    exit 22
}
if ($upJson.desk -ne $true) { Write-Log 'start' 'env-bug' @{ detail = 'up reports desk false although STRAW_BOSS_DESK=1 is set' } }
foreach ($w in @($upJson.warnings)) {
    if (-not $w) { continue }
    switch ([string]$w.code) {
        'breakaway_failed' { Add-Notice ("sb server: " + $w.text) }
        'server_unreachable' { Add-Notice ("sb server: " + $w.text) }
        'desk_on' { Write-Log 'start' 'env-bug' @{ detail = 'warning desk_on: this shell always sets STRAW_BOSS_DESK=1' } }
        'remote_off' { Write-Log 'start' 'warning' @{ detail = 'remote_off' } }
        default { Write-Log 'start' 'warning' @{ detail = [string]$w.code } }
    }
}

# ---- 3. show the GUI ----
$state['guiMs'] = [int]$total.ElapsedMilliseconds
Write-JsonFile $startFile $state
Write-Log 'start' 'gui-url' @{ ms = [int]$total.ElapsedMilliseconds }
Write-Host "GUI_URL=$url"
Write-Host "SB_DIR=$sbDir"

# ---- 4. tower stopgap (until pi-straw-boss B7's `up --dir`); runs after the URL is out, so it delays nothing ----
function Get-Agents {
    $r = Invoke-Herdr @('agent', 'list') 15
    if ($r.ExitCode -ne 0) { return @() }
    try { return @(($r.StdOut | ConvertFrom-Json).result.agents) } catch { return @() }
}
# A restored tower is known by its workspace's `tower` token (the tower session id) plus a pane whose pi reports
# sb_role=tower; both appear only after each resumed pi has loaded straw-boss, so wait for them, not just for the panes.
function Get-Workspaces {
    $r = Invoke-Herdr @('workspace', 'list') 15
    if ($r.ExitCode -ne 0) { return @() }
    try { return @(($r.StdOut | ConvertFrom-Json).result.workspaces) } catch { return @() }
}

function Invoke-TowerStep {
    # herdr restores workspaces and resumes pi panes after a server restart ([session] resume_agents_on_restore), and stop.ps1 no longer closes them,
    # so reuse the restored tower instead of stacking a new one each start (VM 2026-10-26: four bases, three towers).
    $sw2 = [Diagnostics.Stopwatch]::StartNew()
    $agents = @(); $towers = @(); $hadWorkspaces = @(Get-Workspaces).Count -gt 0
    for ($i = 0; $i -lt $RestoreTimeoutSec -and $hadWorkspaces; $i++) {
        Start-Sleep -Seconds 1
        $agents = Get-Agents
        $marked = @(Get-Workspaces | Where-Object { $_.tokens.tower } | ForEach-Object { $_.workspace_id })
        $towers = @($agents | Where-Object { $_.tokens.sb_role -eq 'tower' -and $marked -contains $_.workspace_id } | Sort-Object { $_.workspace_id })
        $pending = @($agents | Where-Object { -not $_.tokens.sb_role })
        if ($towers.Count -gt 0 -and $pending.Count -eq 0) { break }
    }
    Write-Log 'start' 'restored' @{ ms = [int]$sw2.ElapsedMilliseconds; agents = $agents.Count; towers = @($towers | ForEach-Object { $_.pane_id }) }
    if ($towers.Count -gt 0) {
        $keep = $towers[0]
        # An extra tower's workspace closes only when it holds nothing else: its mains and members are the PM's work.
        foreach ($extra in @($towers | Select-Object -Skip 1)) {
            $others = @($agents | Where-Object { $_.workspace_id -eq $extra.workspace_id -and $_.pane_id -ne $extra.pane_id })
            if ($others.Count -gt 0) { Write-Log 'start' 'kept-duplicate-tower' @{ workspaceId = $extra.workspace_id; others = $others.Count }; continue }
            $c = Invoke-Herdr @('workspace', 'close', $extra.workspace_id) 30
            Write-Log 'start' 'closed-duplicate-tower' @{ workspaceId = $extra.workspace_id; exit = $c.ExitCode }
        }
        $state['workspaceId'] = $keep.workspace_id
        $state['paneId'] = $keep.pane_id
        $state['reused'] = $true
        Write-JsonFile $startFile $state
        Write-Log 'start' 'tower-reused' @{ ms = [int]$sw2.ElapsedMilliseconds; workspaceId = $keep.workspace_id; paneId = $keep.pane_id }
        return
    }
    $ws = Invoke-Herdr @('workspace', 'create', '--cwd', $WorkDir, '--label', 'tower', '--no-focus', '--env', 'STRAW_BOSS_ROLE=tower') 30
    if ($ws.ExitCode -ne 0) { throw "workspace create: $(Get-FirstLine ($ws.StdErr + $ws.StdOut))" }
    $wsObj = ($ws.StdOut | ConvertFrom-Json).result
    $workspaceId = $wsObj.workspace.workspace_id
    $paneId = $wsObj.root_pane.pane_id
    $state['workspaceId'] = $workspaceId
    $state['paneId'] = $paneId
    $state['reused'] = $false
    Write-JsonFile $startFile $state
    Write-Log 'start' 'workspace' @{ workspaceId = $workspaceId; paneId = $paneId }

    $agentName = ('tower-' + $workspaceId).ToLowerInvariant()
    $ag = Invoke-Herdr @('agent', 'start', $agentName, '--kind', 'pi', '--pane', $paneId, '--timeout', '120000', '--', '--name', 'tower') 150
    $read = Invoke-Herdr @('pane', 'read', $paneId, '--source', 'visible', '--lines', '60') 20
    Set-Content -LiteralPath (Join-Path $LogDir 'start-tower-pane.txt') -Value $read.StdOut -Encoding UTF8
    if ($ag.ExitCode -ne 0) { throw "agent start pi: $(Get-FirstLine ($ag.StdErr + $ag.StdOut))" }
    Write-Log 'start' 'tower-pi' @{ ms = [int]$sw2.ElapsedMilliseconds; agent = $agentName }
}

if ($NoTower) {
    Write-Log 'start' 'tower-skipped' @{ detail = 'NoTower' }
} else {
    try { Invoke-TowerStep } catch {
        Add-Notice ("tower: " + $_.Exception.Message)
    }
}

# Snapshot of everything under the herdr server, so stop.ps1 can verify nothing of ours remains.
$state['tree'] = @(Get-ProcessTree $serverPid)
$state['totalMs'] = [int]$total.ElapsedMilliseconds
Write-JsonFile $startFile $state
Write-Log 'start' 'end' @{ ms = [int]$total.ElapsedMilliseconds; guiMs = $state['guiMs']; processes = @($state['tree']).Count }
