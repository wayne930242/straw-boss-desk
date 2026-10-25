<#
.SYNOPSIS
  Starts a headless herdr server and a tower pi session that serves the pi-straw-boss GUI, then prints the GUI URL.
.DESCRIPTION
  Uses only published CLIs (herdr, pi) and the file pi-straw-boss writes (gui.json). Isolated: its own herdr socket/config,
  its own PI_CODING_AGENT_DIR. Records what it started in state\start.json so stop.ps1 stops only that.
  Spike hacks (listed in RUNBOOK.md under "upstream seams"):
    - the tower is a herdr workspace whose shell has STRAW_BOSS_ROLE=tower, with pi started through `herdr agent start`
    - the GUI is opened by typing `/boss gui` into the tower (pi-straw-boss has no desk/headless mode); it also tries to open a browser
#>
param(
    [int]$ServerTimeoutSec = 45,
    [int]$GuiTimeoutSec = 120,
    [switch]$NoGui
)

. (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'lib.ps1')
$script:LogFile = Join-Path $LogDir 'start.jsonl'
Set-SbdEnv
$t = Get-ToolPaths
$startFile = Join-Path $StateDir 'start.json'
$guiJson = Join-Path $AgentDir 'straw-boss\gui.json'

foreach ($f in @($t.HerdrExe, $t.PiCmd, $t.NodeExe, $t.BashExe)) {
    if (-not (Test-Path -LiteralPath $f)) { Write-Log 'start' 'fail' @{ detail = "missing $f - run bootstrap.ps1 first" }; exit 2 }
}
if (-not (Test-Path -LiteralPath $WorkDir)) { New-Item -ItemType Directory -Path $WorkDir -Force | Out-Null }

function Invoke-Herdr {
    param([string[]]$ArgList, [int]$TimeoutSec = 30)
    Invoke-Native -File $t.HerdrExe -ArgList $ArgList -TimeoutSec $TimeoutSec
}

function Get-GuiRecord {
    $r = Read-JsonFile $guiJson
    if ($r -and $r.port -and $r.token) { return $r }
    return $null
}

function Test-GuiUrl {
    param([string]$Url)
    try {
        $resp = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 5
        return ($resp.StatusCode -eq 200)
    } catch { return $false }
}

# An earlier start that is still healthy is reused.
$prev = Read-JsonFile $startFile
if ($prev -and $prev.serverPid -and (Test-ProcessAlive -ProcessId ([int]$prev.serverPid) -StartTime $prev.serverStart)) {
    $rec = Get-GuiRecord
    if ($rec) {
        $url = "http://127.0.0.1:$($rec.port)/$($rec.token)/"
        if (Test-GuiUrl $url) {
            Write-Log 'start' 'reuse' @{ detail = 'already running'; url = $url }
            Write-Host "GUI_URL=$url"
            exit 0
        }
    }
    Write-Log 'start' 'stale' @{ detail = 'server alive but GUI not answering; run stop.ps1 first' }
    exit 3
}

$total = [Diagnostics.Stopwatch]::StartNew()
Write-Log 'start' 'begin' @{ os = (Get-OsInfo); socket = $env:HERDR_SOCKET_PATH; agentDir = $AgentDir }

# 1. headless herdr server
$serverOut = Join-Path $LogDir 'herdr-server.out.log'
$serverErr = Join-Path $LogDir 'herdr-server.err.log'
$sw = [Diagnostics.Stopwatch]::StartNew()
$server = Start-Process -FilePath $t.HerdrExe -ArgumentList 'server' -WindowStyle Hidden -PassThru -RedirectStandardOutput $serverOut -RedirectStandardError $serverErr
$serverPid = $server.Id
$serverStart = Get-ProcessStartIso $serverPid
$up = $false
for ($i = 0; $i -lt $ServerTimeoutSec * 2; $i++) {
    Start-Sleep -Milliseconds 500
    if ($server.HasExited) { break }
    $r = Invoke-Herdr @('workspace', 'list') 10
    if ($r.ExitCode -eq 0) { $up = $true; break }
}
if (-not $up) {
    Write-Log 'start' 'fail' @{ detail = 'herdr server did not answer'; exited = $server.HasExited; stderr = (Get-Content -LiteralPath $serverErr -Raw -ErrorAction SilentlyContinue) }
    if (-not $server.HasExited) { & taskkill.exe /PID $serverPid /T /F | Out-Null }
    exit 4
}
Write-Log 'start' 'server-up' @{ ms = [int]$sw.ElapsedMilliseconds; serverPid = $serverPid }
$status = Invoke-Herdr @('status', '--json') 15
Set-Content -LiteralPath (Join-Path $LogDir 'herdr-status.json') -Value $status.StdOut -Encoding UTF8

# Record now, so stop.ps1 can clean up even if a later step fails.
$state = [ordered]@{ serverPid = $serverPid; serverStart = $serverStart; socket = $env:HERDR_SOCKET_PATH; startedAt = (Get-Date).ToUniversalTime().ToString('o') }
Write-JsonFile $startFile $state

# 2. tower workspace + pi
$sw.Restart()
$ws = Invoke-Herdr @('workspace', 'create', '--cwd', $WorkDir, '--label', 'tower', '--no-focus', '--env', 'STRAW_BOSS_ROLE=tower') 30
if ($ws.ExitCode -ne 0) { Write-Log 'start' 'fail' @{ detail = "workspace create: $($ws.StdErr) $($ws.StdOut)" }; exit 5 }
$wsObj = ($ws.StdOut | ConvertFrom-Json).result
$workspaceId = $wsObj.workspace.workspace_id
$paneId = $wsObj.root_pane.pane_id
$state['workspaceId'] = $workspaceId
$state['paneId'] = $paneId
Write-JsonFile $startFile $state
Write-Log 'start' 'workspace' @{ workspaceId = $workspaceId; paneId = $paneId }

$agentName = ('tower-' + $workspaceId).ToLowerInvariant()
$ag = Invoke-Herdr @('agent', 'start', $agentName, '--kind', 'pi', '--pane', $paneId, '--timeout', '120000', '--', '--name', 'tower') 150
$read = Invoke-Herdr @('pane', 'read', $paneId, '--source', 'visible', '--lines', '60') 20
Set-Content -LiteralPath (Join-Path $LogDir 'start-tower-pane.txt') -Value $read.StdOut -Encoding UTF8
if ($ag.ExitCode -ne 0) {
    Write-Log 'start' 'fail' @{ detail = "agent start pi: $($ag.StdErr) $($ag.StdOut)"; pane = $read.StdOut }
    exit 6
}
Write-Log 'start' 'tower-pi' @{ ms = [int]$sw.ElapsedMilliseconds; agent = $agentName }

if ($NoGui) { Write-Log 'start' 'end' @{ detail = 'NoGui' }; exit 0 }

# 3. ask the tower to serve the GUI, then wait for gui.json
$sw.Restart()
$url = $null
for ($attempt = 1; $attempt -le 3 -and -not $url; $attempt++) {
    $p = Invoke-Herdr @('agent', 'prompt', $paneId, '/boss gui', '--timeout', '30000') 60
    Write-Log 'start' 'boss-gui-sent' @{ attempt = $attempt; exit = $p.ExitCode; detail = (Get-FirstLine ($p.StdOut + $p.StdErr)) }
    $deadline = (Get-Date).AddSeconds([int]($GuiTimeoutSec / 3))
    while ((Get-Date) -lt $deadline -and -not $url) {
        Start-Sleep -Milliseconds 700
        $rec = Get-GuiRecord
        if ($rec) {
            $candidate = "http://127.0.0.1:$($rec.port)/$($rec.token)/"
            if (Test-GuiUrl $candidate) { $url = $candidate; $state['guiPid'] = $rec.pid }
        }
    }
}
$read = Invoke-Herdr @('pane', 'read', $paneId, '--source', 'visible', '--lines', '60') 20
Set-Content -LiteralPath (Join-Path $LogDir 'start-tower-pane-after.txt') -Value $read.StdOut -Encoding UTF8
if (-not $url) {
    Write-Log 'start' 'fail' @{ detail = 'gui.json never appeared or the URL did not answer 200'; guiJson = $guiJson; pane = $read.StdOut }
    exit 7
}
Write-Log 'start' 'gui-up' @{ ms = [int]$sw.ElapsedMilliseconds }

# Snapshot of everything under the server, so stop.ps1 can verify nothing of ours remains.
$state['url'] = $url
$state['tree'] = @(Get-ProcessTree $serverPid)
$state['totalMs'] = [int]$total.ElapsedMilliseconds
Write-JsonFile $startFile $state
Write-AllTextUtf8 (Join-Path $StateDir 'gui-url.txt') $url
Write-Log 'start' 'end' @{ ms = [int]$total.ElapsedMilliseconds; url = $url; processes = @($state['tree']).Count }
Write-Host "GUI_URL=$url"
