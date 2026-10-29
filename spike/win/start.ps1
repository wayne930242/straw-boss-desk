<#
.SYNOPSIS
  Starts a headless herdr server and the pi-straw-boss sb server, makes the home base and its tower, and prints the GUI URL.
.DESCRIPTION
  Uses only published CLIs (herdr, node cli.mjs of pi-straw-boss). Isolated: its own XDG_CONFIG_HOME with herdr's default socket under it
  (so the sb server is the PRIMARY server of this environment), its own PI_CODING_AGENT_DIR, STRAW_BOSS_DESK=1. Records what it started in
  state\start.json so stop.ps1 stops only that.
  Order (desk B7 plan, "Start order, after the B6 + B7 release"):
    1. herdr server (reused only when its pid and start time match and start.json records the same environment fingerprint)
    2. `cli.mjs up --dir <home base folder> --label <name> --timeout 120 --exact`: Herdr's pi integration, the sb server, the home base and its tower
       (the server makes the tower), and the GUI; the URL comes from its answer, no file is read. start.json records workspace, pane, tower, created
       and integration from it.
    3. print GUI_URL= and SB_DIR=
  The home base folder is %USERPROFILE%\Straw Boss (visible, under home); this script makes it when it is missing, since `up --dir` only checks it.
  Lines on stdout: GUI_URL=<url>, SB_DIR=<slot folder>, NOTICE=<text>. The URL holds the page token: it is printed only here and never logged.
  Exit codes: 0 done; 2 a tool is missing (run bootstrap); 3 a stack from another environment or an unrecorded herdr is running (run stop.ps1);
  4 herdr server silent; 8 reserved; up failed: 10 lock, 11 start, 12 hello, 13 exit, 14 herdr, 15 version, 16 server, 17 gui, 18 other,
  19 server cannot run (up exit 3: loader, intercom, acl), 20 up usage error (a bug here), 21 up answered without a usable URL, 22 the sb server
  is not in the primary slot, 23 step base busy (another `up --dir` held desk.lock twice), 24 step base failed (the folder, or Herdr said no),
  25 step integration failed (herdr integration install pi), 26 up answered without a base (workspace).
#>
param(
    [int]$ServerTimeoutSec = 45,
    [int]$UpTimeoutSec = 120,
    [string]$HomeBaseDir = '',
    [string]$HomeBaseLabel = ''
)

. (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'lib.ps1')
# The app reads this script's stdout as UTF-8. A piped Windows console writes the OEM code page, which turned the profile's non-ASCII folder name in SB_DIR
# into U+FFFD (VM 2026-10-28) and left the app's follower unable to open the slot folder.
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }
$script:LogFile = Join-Path $LogDir 'start.jsonl'
if (-not $HomeBaseDir) { $HomeBaseDir = $BaseDir }
if (-not $HomeBaseLabel) { $HomeBaseLabel = $BaseLabel }
Set-SbdEnv
$t = Get-ToolPaths
$startFile = Join-Path $StateDir 'start.json'
$primaryDir = [IO.Path]::GetFullPath((Join-Path $AgentDir 'straw-boss')).TrimEnd('\')

$sbCli = Join-Path $t.AgentNm 'pi-straw-boss\dist\server\cli.mjs'
foreach ($f in @($t.HerdrExe, $t.PiCmd, $t.NodeExe, $t.BashExe, $sbCli)) {
    if (-not (Test-Path -LiteralPath $f)) { Write-Log 'start' 'fail' @{ detail = "missing $f - run bootstrap.ps1 first" }; exit 2 }
}
if (-not (Test-Path -LiteralPath $WorkDir)) { New-Item -ItemType Directory -Path $WorkDir -Force | Out-Null }
if (-not (Test-Path -LiteralPath $HomeBaseDir)) { New-Item -ItemType Directory -Path $HomeBaseDir -Force | Out-Null }

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
if ($prev -and $prev.serverPid -and $prev.serverStart -and (Test-ProcessAlive -ProcessId ([int]$prev.serverPid) -StartTime $prev.serverStart)) {
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
    # The start time comes from the held handle; without it the pid is never recorded (it could be reused later).
    $serverStart = $null
    try { if ($server.StartTime) { $serverStart = $server.StartTime.ToUniversalTime().ToString('o') } } catch { }
    if (-not $serverStart) {
        Write-Log 'start' 'fail' @{ detail = 'herdr exited'; exited = $server.HasExited }
        exit 4
    }
    # Record at once: a quit during the start (the app waits, then runs stop.ps1) must find this herdr, not report "nothing recorded".
    Write-JsonFile $startFile ([ordered]@{ serverPid = $serverPid; serverStart = $serverStart; startedAt = (Get-Date).ToUniversalTime().ToString('o'); herdrReused = $false; socket = $env:HERDR_SOCKET_PATH; fingerprint = $fingerprint })
    $up = $false
    for ($i = 0; $i -lt $ServerTimeoutSec * 2; $i++) {
        Start-Sleep -Milliseconds 500
        if ($server.HasExited) { break }
        if (Test-HerdrAnswers 10) { $up = $true; break }
    }
    if (-not $up) {
        Write-Log 'start' 'fail' @{ detail = 'herdr server did not answer'; exited = $server.HasExited }
        if (-not $server.HasExited) { [void](Stop-ProcessTree -ProcessId $serverPid -StartTime $serverStart) }
        # This run wrote the record a moment ago; a herdr that is gone leaves nothing for stop.ps1 to stop, so no dead pid stays recorded.
        if (-not (Test-ProcessAlive -ProcessId $serverPid -StartTime $serverStart)) { Remove-Item -LiteralPath $startFile -Force -ErrorAction SilentlyContinue }
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

# ---- 2. integration, the sb server, the home base with its tower, and the GUI: `cli.mjs up --dir --label` ----
# Every pi that herdr starts then finds a live server. The URL comes from `up`'s own answer (the server's, already answering 200); no file is read.
function Invoke-SbUp {
    $r = Invoke-Native -File $t.NodeExe -ArgList @($sbCli, 'up', '--dir', $HomeBaseDir, '--label', $HomeBaseLabel, '--timeout', [string]$UpTimeoutSec, '--exact') -TimeoutSec ($UpTimeoutSec + 30)
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
        # A busy `base` is another `up --dir` holding desk.lock; any other `base` failure is the folder or Herdr.
        if ($step -eq 'base' -and ([string]$U.Err.reason) -match '^busy') { return 'basebusy' }
        if ($step -eq 'herdr' -or $step -eq 'version' -or $step -eq 'server' -or $step -eq 'gui' -or $step -eq 'base' -or $step -eq 'integration') { return $step }
    }
    return 'other'
}

$upExitCode = @{ 'lock' = 10; 'start' = 11; 'hello' = 12; 'exit' = 13; 'herdr' = 14; 'version' = 15; 'server' = 16; 'gui' = 17; 'other' = 18; 'cannotrun' = 19; 'loader' = 19; 'intercom' = 19; 'acl' = 19; 'usage' = 20; 'nourl' = 21; 'basebusy' = 23; 'base' = 24; 'integration' = 25; 'nobase' = 26 }

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
    Write-Log 'start' 'repair' @{ code = $Code; package = $pkg; exit = $r.ExitCode; ms = $r.Ms; detail = (Get-FirstLine $r.StdOut) }
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
            'basebusy' { $retry = $true }
            'hello' { $retry = $true }
            'exit'  { $retry = $true }
            'herdr' {
                # A record that serves another socket is a broken install and is shown; a silent herdr gets one more look.
                if (([string]$u.Err.reason) -notmatch 'serves') {
                    for ($i = 0; $i -lt 30 -and -not $retry; $i++) { if (Test-HerdrAnswers 10) { $retry = $true } else { Start-Sleep -Milliseconds 500 } }
                    if (-not $retry -and -not $state['herdrReused']) {
                        # Still silent: restart the herdr this script started, once (plan table), and record the new one.
                        [void](Stop-ProcessTree -ProcessId $serverPid -StartTime $serverStart)
                        if (Test-ProcessAlive -ProcessId $serverPid -StartTime $serverStart) {
                            # The old herdr survived: its record stays so stop.ps1 can still find it, and no second one is started.
                            Write-Log 'start' 'fail' @{ detail = 'the herdr to restart did not stop' }
                            exit 4
                        }
                        $server = Start-Process -FilePath $t.HerdrExe -ArgumentList 'server' -WindowStyle Hidden -PassThru
                        $serverPid = $server.Id
                        $serverStart = $null
                        try { if ($server.StartTime) { $serverStart = $server.StartTime.ToUniversalTime().ToString('o') } } catch { }
                        if (-not $serverStart) {
                            Write-Log 'start' 'fail' @{ detail = 'herdr exited'; exited = $server.HasExited }
                            # Through the held handle: a herdr that is alive but has no readable start time must not stay behind unrecorded.
                            try { if (-not $server.HasExited) { $server.Kill() } } catch { }
                            # The herdr recorded before this restart was stopped just above; no dead pid stays recorded.
                            Remove-Item -LiteralPath $startFile -Force -ErrorAction SilentlyContinue
                            exit 4
                        }
                        $state['serverPid'] = $serverPid
                        $state['serverStart'] = $serverStart
                        Write-JsonFile $startFile $state
                        Write-Log 'start' 'herdr-restarted' @{ serverPid = $serverPid }
                        for ($i = 0; $i -lt $ServerTimeoutSec * 2 -and -not $retry; $i++) { if (Test-HerdrAnswers 10) { $retry = $true } else { Start-Sleep -Milliseconds 500 } }
                    }
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
# `started` may be absent when the server does not know its own start time yet (it arrives late on Windows).
$sbStart = $null
# Without `started` the start time stays null: the PID's current holder is not known to be the server, and stop.ps1 then asks `cli.mjs stop` and never kills by pid.
if ($upJson.started) { $sbStart = Format-Iso $upJson.started }
$sbLog = [string]$upJson.log
$sbDir = ''
if ($sbLog) { $sbDir = [IO.Path]::GetFullPath((Split-Path -Parent $sbLog)).TrimEnd('\') }
$warnCodes = @($upJson.warnings | ForEach-Object { $_.code })
Write-Log 'start' 'sb-server-up' @{ workspace = [string]$upJson.workspace; pane = [string]$upJson.pane; tower = [string]$upJson.tower; created = $upJson.created; integration = [string]$upJson.integration; ms = [int]$sw.ElapsedMilliseconds; pid = $sbPid; version = $upJson.version; server = $upJson.server; mode = $upJson.mode; desk = $upJson.desk; log = $sbLog; steps = @($upJson.steps | ForEach-Object { $_.name + '=' + $_.ms }); warnings = $warnCodes }

$state['sbServerPid'] = $sbPid
$state['sbServerStart'] = $sbStart
$state['sbServerLog'] = $sbLog
$state['sbDir'] = $sbDir
$state['sbServerRecord'] = if ($sbDir) { Join-Path $sbDir 'server.json' } else { $null }
# What the desk steps answered: the home base, its pane, the tower the server made, whether this run made the base or the tower, and the integration's state.
$state['workspaceId'] = [string]$upJson.workspace
$state['paneId'] = [string]$upJson.pane
$state['tower'] = [string]$upJson.tower
$state['created'] = $upJson.created
$state['integration'] = [string]$upJson.integration
$state['baseDir'] = $HomeBaseDir
Write-JsonFile $startFile $state

if (-not $upJson.workspace) {
    Write-Log 'start' 'fail' @{ detail = 'up --dir answered without a workspace (no home base)' }
    Write-Host 'FAIL nobase: up answered without a home base'
    exit 26
}
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

# Snapshot of everything under the herdr server, so stop.ps1 can verify nothing of ours remains.
$state['tree'] = @(Get-ProcessTree $serverPid)
$state['totalMs'] = [int]$total.ElapsedMilliseconds
Write-JsonFile $startFile $state
Write-Log 'start' 'end' @{ ms = [int]$total.ElapsedMilliseconds; guiMs = $state['guiMs']; processes = @($state['tree']).Count }
