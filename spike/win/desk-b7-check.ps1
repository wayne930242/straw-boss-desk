<#
.SYNOPSIS
  DRAFT, NOT YET RUN. Desk B7 acceptance on pi-straw-boss 0.46.0 (docs/specs/2026-10-28-desk-b7.md, Acceptance A1 to A5, and task 1's pane-environment check as A0).
.DESCRIPTION
  Run in the Windows VM under the filtered token, as the 0.46.0 pass did, after bootstrap.ps1 and with the prototype installed (for A3):
    powershell -NoProfile -ExecutionPolicy Bypass -File desk-b7-check.ps1 [-Only A0,A1,...] [-Runs 5]
  Each item is one or more steps: PASS / FAIL / SKIP with evidence, in results\desk-b7-<time>.json and desk-b7-latest.json (same shape as the account checks).
  A GUI URL carries the page token: no step, log line, or result holds one (URLs are tested but never printed; the CDP helper reports a token hash).
  Destructive on the kit's own state only: A1 cold runs and A5 remove <agent dir>\straw-boss and herdr's session files; A5 renames the tsx folder and puts it back.
  Items:
    A0  the four slot variables reach a pane (task 1)
    A1  cold and warm starts, -Runs of each: GUI_URL, SB_DIR, 200, status live/desk/primary, no browser process, time to GUI_URL
    A6  (after B7) start.ps1 runs `up --dir`: one home base with one tower tab; a second start makes nothing new; stop then start finds the restored tab
    A7  (after B7) the integration removed: start.ps1 installs it again (`integration: installed`)
    A9  (after B7) a pi started in a pane with the integration missing warns once after 20 s
    A3  the prototype follows restart, kill, and /boss gui stop + Start (needs the prototype installed; uses CDP on 127.0.0.1)
    A4  stop order and leftovers; workspaces come back
    A5  injected failures: herdr not running, up --timeout 5 cold, held lock then retry, tsx missing then repair, server started without the switch
#>
param(
    [string[]]$Only,
    [int]$Runs = 5,
    [string]$ProtoExe = '',
    [int]$CdpPort = 9222
)

# With -File, `-Only A5a,A5b` arrives as one string.
if ($Only) { $Only = @($Only | ForEach-Object { $_ -split ',' } | Where-Object { $_ }) }
. (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'lib.ps1')
Start-AccountCheck 'desk-b7'
$t = Get-ToolPaths
$sbCli = Join-Path $t.AgentNm 'pi-straw-boss\dist\server\cli.mjs'
$sbDir = Join-Path $AgentDir 'straw-boss'
$startJsonl = Join-Path $LogDir 'start.jsonl'
$startFile = Join-Path $StateDir 'start.json'
$cdpEval = Join-Path (Join-Path $KitDir 'lib') 'cdp-eval.mjs'
$psExe = (Get-Command powershell.exe).Source
if (-not $ProtoExe) { $ProtoExe = Join-Path $env:LOCALAPPDATA 'Programs\straw-boss-desk-proto\Straw Boss Desk Proto.exe' }

function Test-Item { param([string]$Id) return ((-not $Only) -or ($Only -contains $Id)) }
# A5 has five injections (A5a to A5e); -Only A5c runs just one (the repair, A5d, needs the network without WARP).
function Test-Sub { param([string]$Sub) return ((-not $Only) -or ($Only -contains 'A5') -or ($Only -contains ('A5' + $Sub))) }

# ---- helpers ----------------------------------------------------------------------------------------------------------

# Runs one kit script the way checks.ps1 starts start.ps1: through cmd.exe started by ShellExecute with its output in a file, so the herdr server it leaves behind
# cannot hold a pipe of this process open.
function Invoke-Kit {
    param([string]$Script, [string[]]$ScriptArgs = @(), [int]$TimeoutSec = 400)
    $name = [IO.Path]::GetFileNameWithoutExtension($Script)
    $out = Join-Path $LogDir "desk-b7-$name.out.log"
    if (Test-Path -LiteralPath $out) { Remove-Item -LiteralPath $out -Force -ErrorAction SilentlyContinue }
    $inner = '"' + $psExe + '" -NoProfile -ExecutionPolicy Bypass -File "' + (Join-Path $KitDir $Script) + '" ' + ($ScriptArgs -join ' ') + ' > "' + $out + '" 2>&1'
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $cmd = Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\cmd.exe') -ArgumentList ('/c "' + $inner + '"') -WindowStyle Hidden -PassThru
    $null = $cmd.Handle
    $exit = $null
    if ($cmd.WaitForExit($TimeoutSec * 1000)) { $exit = $cmd.ExitCode } else { [void](Stop-ProcessTree -ProcessId $cmd.Id -StartTime $cmd.StartTime) }
    $text = Get-Content -LiteralPath $out -Raw -Encoding UTF8 -ErrorAction SilentlyContinue
    # The parsed output keeps the GUI token in memory only; the file on disk is rewritten with the token hidden.
    if ($text) { try { Write-AllTextUtf8 -Path $out -Text (Hide-Token $text) } catch { } }
    [pscustomobject]@{ Exit = $exit; Out = [string]$text; Ms = [int]$sw.ElapsedMilliseconds }
}

function Get-UrlFromOut { param([string]$Out) $m = [regex]::Match($Out, '(?m)^GUI_URL=(http://127\.0\.0\.1:\d+/[0-9a-f]{16,}/)\s*$'); if ($m.Success) { return $m.Groups[1].Value } return $null }
function Get-SbDirFromOut { param([string]$Out) $m = [regex]::Match($Out, '(?m)^SB_DIR=(.+?)\s*$'); if ($m.Success) { return $m.Groups[1].Value } return $null }

# HTTP status of a GET (0 when nothing answers). A 403 is an answer, not an error.
function Get-HttpStatus {
    param([string]$Url)
    try { return [int](Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 5).StatusCode } catch {
        if ($_.Exception.Response) { return [int]$_.Exception.Response.StatusCode }
        return 0
    }
}

function Get-NodeJson {
    param([string[]]$ArgList, [int]$TimeoutSec = 120)
    $r = Invoke-Native -File $t.NodeExe -ArgList $ArgList -TimeoutSec $TimeoutSec
    $line = ($r.StdOut -split "`r?`n" | Where-Object { $_.Trim().StartsWith('{') } | Select-Object -Last 1)
    $err = ($r.StdErr -split "`r?`n" | Where-Object { $_.Trim().StartsWith('{') } | Select-Object -Last 1)
    $j = $null; $e = $null
    if ($line) { try { $j = $line | ConvertFrom-Json } catch { } }
    if ($err) { try { $e = $err | ConvertFrom-Json } catch { } }
    [pscustomobject]@{ Exit = $r.ExitCode; Json = $j; Err = $e; Raw = $r }
}

function Get-Status { return (Get-NodeJson @($sbCli, 'status') 120) }
function Read-GuiRecord { return (Read-JsonFile (Join-Path $sbDir 'gui.json')) }
function Get-TokenHash {
    param([string]$Token)
    if (-not $Token) { return '' }
    $sha = [Security.Cryptography.SHA256]::Create()
    $bytes = $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Token))
    return (($bytes | ForEach-Object { $_.ToString('x2') }) -join '').Substring(0, 12)
}

function Invoke-Herdr { param([string[]]$ArgList, [int]$TimeoutSec = 30) Invoke-Native -File $t.HerdrExe -ArgList $ArgList -TimeoutSec $TimeoutSec }

# start.jsonl events written after a moment: [{ts, event, ...}]
function Get-StartEvents {
    param([datetime]$Since)
    if (-not (Test-Path -LiteralPath $startJsonl)) { return @() }
    $rows = @()
    foreach ($line in (Get-Content -LiteralPath $startJsonl -Encoding UTF8)) {
        try { $o = $line | ConvertFrom-Json } catch { continue }
        if ($o.stage -ne 'start' -and $o.stage -ne 'stop') { continue }
        if ((ConvertTo-UtcInstant $o.ts) -ge $Since.ToUniversalTime()) { $rows += $o }
    }
    return $rows
}

# A browser or `cmd /c start` created since a moment: what an opened-by-the-kit window would look like.
function Get-NewBrowserProcs {
    param([datetime]$Since)
    $found = @()
    foreach ($p in @(Get-CimInstance Win32_Process)) {
        if (-not $p.CreationDate -or $p.CreationDate.ToUniversalTime() -lt $Since.ToUniversalTime()) { continue }
        if ($p.Name -eq 'msedge.exe') { $found += "msedge.exe $($p.ProcessId)"; continue }
        if ($p.Name -eq 'cmd.exe' -and $p.CommandLine -match '/c\s+start\s') { $found += "cmd.exe $($p.ProcessId) (/c start)" }
    }
    return $found
}

function Reset-KitState {
    [void](Invoke-Kit 'stop.ps1' @() 300)
    foreach ($p in @($sbDir, (Join-Path $HerdrDir 'session.json'), (Join-Path $HerdrDir 'session-snapshots'))) {
        if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Recurse -Force -ErrorAction SilentlyContinue }
    }
    if (Test-Path -LiteralPath $startFile) { Remove-Item -LiteralPath $startFile -Force -ErrorAction SilentlyContinue }
}

# Any node.exe or herdr.exe that runs from the kit's tools folder or names the kit root: the independent check (no start.json involved).
function Get-KitProcesses {
    $found = @()
    foreach ($p in @(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -or $_.Name -eq 'herdr.exe' })) {
        if (($p.ExecutablePath -and $p.ExecutablePath.StartsWith($SbdRoot, [StringComparison]::OrdinalIgnoreCase)) -or ($p.CommandLine -and $p.CommandLine.IndexOf($SbdRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0)) { $found += "$($p.ProcessId) $($p.Name)" }
    }
    return $found
}

function Test-KitGone {
    param($Rec)
    $left = @()
    foreach ($k in @($Rec.tree)) { if ($k -and $k.Pid -and (Test-ProcessAlive -ProcessId ([int]$k.Pid) -StartTime $k.Created)) { $left += "$($k.Pid) $($k.Name)" } }
    if ($Rec.serverPid -and (Test-ProcessAlive -ProcessId ([int]$Rec.serverPid) -StartTime $Rec.serverStart)) { $left += "$($Rec.serverPid) herdr" }
    if ($Rec.sbServerPid -and (Test-ProcessAlive -ProcessId ([int]$Rec.sbServerPid) -StartTime $Rec.sbServerStart)) { $left += "$($Rec.sbServerPid) sb-server" }
    return $left
}

# One start with every assertion A1 makes. Returns the start result so callers can reuse its URL (never printed).
function Test-OneStart {
    param([string]$Label)
    $since = Get-Date
    $r = Invoke-Kit 'start.ps1'
    $url = Get-UrlFromOut $r.Out
    $dir = Get-SbDirFromOut $r.Out
    $rec = Read-JsonFile $startFile
    if ($r.Exit -ne 0 -or -not $url -or -not $dir) {
        Add-Step "$Label.start" 'FAIL' ("start.ps1 exit $($r.Exit); GUI_URL " + [bool]$url + "; SB_DIR " + [bool]$dir + "; " + (Hide-Token (Get-FirstLine ($r.Out -split "`r?`n" | Where-Object { $_ -match '^(FAIL|NOTICE)' } | Select-Object -First 1))))
        return $null
    }
    $code = Get-HttpStatus $url
    $st = (Get-Status).Json
    $browsers = @(Get-NewBrowserProcs $since)
    $okSlot = ($dir.TrimEnd('\') -ieq $sbDir.TrimEnd('\'))
    $ok = ($code -eq 200 -and $st -and $st.state -eq 'live' -and $st.desk -eq $true -and $st.primary -eq $true -and $okSlot -and $browsers.Count -eq 0)
    $ev = "exit 0; GUI_URL answers $code; SB_DIR=primary:$okSlot; status state=$($st.state) desk=$($st.desk) primary=$($st.primary); new browser processes=$($browsers.Count) $($browsers -join ', '); guiMs=$($rec.guiMs) totalMs=$($rec.totalMs)"
    Add-Step "$Label.start" $(if ($ok) { 'PASS' } else { 'FAIL' }) $ev $false ([int]$rec.guiMs)
    return [pscustomobject]@{ Url = $url; Dir = $dir; Rec = $rec; Since = $since; GuiMs = [int]$rec.guiMs }
}

# ---- A0: the four variables reach a pane --------------------------------------------------------------------------------
if (Test-Item 'A0') {
    Reset-KitState
    $s = Test-OneStart 'A0'
    if ($s) {
        $out = Join-Path $env:PUBLIC 'sbd-pane-env.txt'   # an ASCII path: the text is typed into a pane's shell
        if (Test-Path -LiteralPath $out) { Remove-Item -LiteralPath $out -Force }
        $created = Invoke-Herdr @('workspace', 'create', '--cwd', $WorkDir, '--label', 'envcheck', '--no-focus') 30
        $obj = $null
        try { $obj = ($created.StdOut | ConvertFrom-Json).result } catch { }
        if (-not $obj) { Add-Step 'A0.pane-env' 'FAIL' "workspace create: $(Get-FirstLine ($created.StdErr + $created.StdOut))" }
        else {
            $pane = $obj.root_pane.pane_id
            Start-Sleep -Seconds 3
            $js = "require('fs').writeFileSync(process.argv[1],[process.env.STRAW_BOSS_DESK,process.env.XDG_CONFIG_HOME,process.env.HERDR_SOCKET_PATH,process.env.PI_CODING_AGENT_DIR].join('|'))"
            [void](Invoke-Herdr @('pane', 'send-text', $pane, ('node -e "' + $js + '" "' + $out + '"')) 30)
            [void](Invoke-Herdr @('pane', 'send-keys', $pane, 'enter') 30)
            for ($i = 0; $i -lt 40 -and -not (Test-Path -LiteralPath $out); $i++) { Start-Sleep -Milliseconds 500 }
            [void](Invoke-Herdr @('workspace', 'close', $obj.workspace.workspace_id) 30)
            if (-not (Test-Path -LiteralPath $out)) { Add-Step 'A0.pane-env' 'FAIL' 'the pane wrote nothing (node not on the pane PATH, or the text was not run)' }
            else {
                $got = [IO.File]::ReadAllText($out, [Text.Encoding]::UTF8)
                $want = (@('1', $env:XDG_CONFIG_HOME, $env:HERDR_SOCKET_PATH, $env:PI_CODING_AGENT_DIR) -join '|')
                Add-Step 'A0.pane-env' $(if ($got -eq $want) { 'PASS' } else { 'FAIL' }) $(if ($got -eq $want) { 'the pane sees STRAW_BOSS_DESK, XDG_CONFIG_HOME, HERDR_SOCKET_PATH, PI_CODING_AGENT_DIR as the server does' } else { "differs: pane '$got' expected '$want'" })
                Remove-Item -LiteralPath $out -Force -ErrorAction SilentlyContinue
            }
        }
        $one = @(Get-ChildItem -LiteralPath $sbDir -Recurse -Filter 'server.json' -ErrorAction SilentlyContinue)
        Add-Step 'A0.one-record' $(if ($one.Count -eq 1 -and -not (Test-Path -LiteralPath (Join-Path $sbDir 'servers'))) { 'PASS' } else { 'FAIL' }) "server.json files under straw-boss: $($one.Count); servers\ folder $(if (Test-Path -LiteralPath (Join-Path $sbDir 'servers')) { 'present' } else { 'absent' })"
        $link = (Get-Status).Json.link
        Add-Step 'A0.link-state' $(if ($null -ne $link) { 'PASS' } else { 'FAIL' }) "status.link is $(if ($null -ne $link) { 'present (no no_link)' } else { 'null' })"
    }
}

# ---- A1: cold and warm starts -------------------------------------------------------------------------------------------
if (Test-Item 'A1') {
    $cold = @(); $warm = @()
    for ($i = 1; $i -le $Runs; $i++) {
        Reset-KitState
        $s = Test-OneStart "A1.cold-$i"
        if ($s) { $cold += $s.GuiMs }
    }
    for ($i = 1; $i -le $Runs; $i++) {
        [void](Invoke-Kit 'stop.ps1' @() 300)
        $s = Test-OneStart "A1.warm-$i"
        if ($s) { $warm += $s.GuiMs }
    }
    $coldMax = 0; if ($cold.Count) { $coldMax = ($cold | Measure-Object -Maximum).Maximum }
    Add-Step 'A1.cold-time' $(if ($cold.Count -eq $Runs -and $coldMax -lt 20000) { 'PASS' } else { 'FAIL' }) "time to GUI_URL, cold, ms: $($cold -join ', ') (target under 20000; the kit-fix pass took 91000)"
    Add-Step 'A1.warm-time' 'PASS' "time to GUI_URL, warm, ms: $($warm -join ', ') (recorded)"
}

# ---- A6: `up --dir` through start.ps1 -----------------------------------------------------------------------------------
function Get-BasePanes {
    $r = Invoke-Herdr @('pane', 'list') 20
    if ($r.ExitCode -ne 0) { return @() }
    try { return @((($r.StdOut | ConvertFrom-Json).result.panes) | Where-Object { $_.tokens.sb_role -eq 'tower' }) } catch { return @() }
}
function Get-WorkspaceCount {
    $r = Invoke-Herdr @('workspace', 'list') 20
    try { return @((($r.StdOut | ConvertFrom-Json).result.workspaces)).Count } catch { return -1 }
}
function Get-TowerTabCount {
    param([string]$Workspace)
    $r = Invoke-Herdr @('tab', 'list', '--workspace', $Workspace) 20
    try { return @((($r.StdOut | ConvertFrom-Json).result.tabs)).Count } catch { return -1 }
}
if (Test-Item 'A6') {
    Reset-KitState
    $homeBase = Join-Path $env:USERPROFILE 'Straw Boss'
    $s = Test-OneStart 'A6.first'
    if ($s) {
        $rec = $s.Rec
        $panes = @(Get-BasePanes)
        $okFirst = ($rec.created -eq $true -and $rec.workspaceId -and $rec.paneId -and $rec.tower -and (Get-WorkspaceCount) -eq 1 -and (Get-TowerTabCount $rec.workspaceId) -eq 1 -and $panes.Count -eq 1)
        Add-Step 'A6.created' $(if ($okFirst) { 'PASS' } else { 'FAIL' }) "start.json: workspace=$($rec.workspaceId) pane=$($rec.paneId) tower=$($rec.tower) created=$($rec.created) integration=$($rec.integration); workspaces=$(Get-WorkspaceCount); tabs=$(Get-TowerTabCount $rec.workspaceId); sb_role=tower panes=$($panes.Count); base folder $homeBase exists: $(Test-Path -LiteralPath $homeBase)"
        $second = Invoke-Kit 'start.ps1'
        $rec2 = Read-JsonFile $startFile
        $ok2 = ($second.Exit -eq 0 -and (Get-UrlFromOut $second.Out) -and $rec2.created -eq $false -and $rec2.workspaceId -eq $rec.workspaceId -and (Get-TowerTabCount $rec.workspaceId) -eq 1)
        Add-Step 'A6.second-start-no-new-tab' $(if ($ok2) { 'PASS' } else { 'FAIL' }) "exit $($second.Exit); created=$($rec2.created); workspace=$($rec2.workspaceId); tabs=$(Get-TowerTabCount $rec.workspaceId)"
        [void](Invoke-Kit 'stop.ps1' @() 300)
        $third = Invoke-Kit 'start.ps1'
        $rec3 = Read-JsonFile $startFile
        $st3 = (Get-Status).Json
        $towers = @($st3.towers)
        $ok3 = ($third.Exit -eq 0 -and $rec3.created -eq $false -and $rec3.workspaceId -eq $rec.workspaceId -and (Get-TowerTabCount $rec.workspaceId) -eq 1 -and (Get-WorkspaceCount) -eq 1)
        Add-Step 'A6.restored-tab-found' $(if ($ok3) { 'PASS' } else { 'FAIL' }) "stop then start: exit $($third.Exit); created=$($rec3.created); workspace=$($rec3.workspaceId); tabs=$(Get-TowerTabCount $rec.workspaceId); status.towers=$($towers.Count) (the tower service's own view; empty when status does not list it, check the log's tower-registered line)"
    }
}

# ---- A7: the integration is installed by `up --dir` ---------------------------------------------------------------------
if (Test-Item 'A7') {
    Reset-KitState
    $ext = Join-Path $AgentDir 'extensions\herdr-agent-state.ts'
    $s = Test-OneStart 'A7.first'
    if ($s) {
        [void](Invoke-Kit 'stop.ps1' @() 300)
        if (Test-Path -LiteralPath $ext) { Remove-Item -LiteralPath $ext -Force }
        $gone = -not (Test-Path -LiteralPath $ext)
        $r = Invoke-Kit 'start.ps1'
        $rec = Read-JsonFile $startFile
        Add-Step 'A7.reinstalled' $(if ($gone -and $r.Exit -eq 0 -and $rec.integration -eq 'installed' -and (Test-Path -LiteralPath $ext)) { 'PASS' } else { 'FAIL' }) "extension removed: $gone; start.ps1 exit $($r.Exit); integration=$($rec.integration); extension back: $(Test-Path -LiteralPath $ext)"
        [void](Invoke-Kit 'stop.ps1' @() 300)
    }
}

# ---- A9: a pi without the integration warns once after 20 s -------------------------------------------------------------
if (Test-Item 'A9') {
    Reset-KitState
    $ext = Join-Path $AgentDir 'extensions\herdr-agent-state.ts'
    $s = Test-OneStart 'A9.first'
    if ($s) {
        # up --dir installed the integration; remove it again, then start a pi in a new workspace of the base's Herdr.
        if (Test-Path -LiteralPath $ext) { Remove-Item -LiteralPath $ext -Force }
        $ws = Invoke-Herdr @('workspace', 'create', '--cwd', $WorkDir, '--label', 'a9', '--no-focus') 30
        $paneId = $null
        try { $paneId = ($ws.StdOut | ConvertFrom-Json).result.root_pane.pane_id } catch { }
        if (-not $paneId) { Add-Step 'A9.pane' 'FAIL' "workspace create: exit $($ws.ExitCode)" }
        else {
            $ag = Invoke-Herdr @('agent', 'start', 'a9-pi', '--kind', 'pi', '--pane', $paneId, '--timeout', '120000') 150
            $text = ''; $seenAt = $null; $sw = [Diagnostics.Stopwatch]::StartNew()
            while ($sw.Elapsed.TotalSeconds -lt 60 -and -not $seenAt) {
                Start-Sleep -Seconds 2
                $read = Invoke-Herdr @('pane', 'read', $paneId, '--source', 'visible', '--lines', '60') 20
                $text = $read.StdOut
                if ($text -match 'integration is missing') { $seenAt = [int]$sw.Elapsed.TotalSeconds }
            }
            $count = ([regex]::Matches($text, 'integration is missing')).Count
            Add-Step 'A9.warns' $(if ($seenAt -and $seenAt -ge 15 -and $count -eq 1) { 'PASS' } else { 'FAIL' }) "agent start exit $($ag.ExitCode); warning seen after $seenAt s (expected about 20); occurrences on screen: $count"
        }
        [void](Invoke-Kit 'stop.ps1' @() 300)
    }
}

# ---- A3: the prototype follows the GUI ----------------------------------------------------------------------------------
if (Test-Item 'A3') {
    if (-not (Test-Path -LiteralPath $ProtoExe)) { Add-Step 'A3.prototype' 'SKIP' "prototype not installed at $ProtoExe" }
    else {
        $passStart = Get-Date
        $s = Test-OneStart 'A3.stack'
        if ($s) {
            $protoLog = Join-Path $LogDir 'proto.jsonl'
            [void](& (Join-Path $KitDir 'ui-run.ps1') -Exe $ProtoExe -Arguments "--remote-debugging-port=$CdpPort" -Name 'sbd-desk-b7-proto')
            function Get-Window { $r = Invoke-Native -File $t.NodeExe -ArgList @($cdpEval, [string]$CdpPort, 'list') -TimeoutSec 30; try { return (($r.StdOut | ConvertFrom-Json).pages | Where-Object { $_.kind -eq 'gui' } | Select-Object -First 1) } catch { return $null } }
            $win = $null
            for ($i = 0; $i -lt 180 -and -not $win; $i++) { Start-Sleep -Milliseconds 500; $win = Get-Window }
            Add-Step 'A3.window-on-gui' $(if ($win) { 'PASS' } else { 'FAIL' }) $(if ($win) { "the window shows the GUI at port $($win.port)" } else { 'no GUI page in the window within 90 s (CDP port or prototype start)' })
            if ($win) {
                # a: restart
                $oldRec = Read-GuiRecord
                $oldUrl = "http://127.0.0.1:$($oldRec.port)/$($oldRec.token)/"
                $tStart = Get-Date
                $rs = Get-NodeJson @($sbCli, 'restart', '--reason', 'desk-b7 A3') 150
                $newRec = $null; $tAnswered = $null; $tWindow = $null
                for ($i = 0; $i -lt 240 -and -not $tWindow; $i++) {
                    Start-Sleep -Milliseconds 250
                    $newRec = Read-GuiRecord
                    if ($newRec -and $newRec.token -and $newRec.token -ne $oldRec.token) {
                        $newUrl = "http://127.0.0.1:$($newRec.port)/$($newRec.token)/"
                        if (-not $tAnswered -and (Get-HttpStatus $newUrl) -eq 200) { $tAnswered = Get-Date }
                        $w = Get-Window
                        if ($w -and $w.tokenHash -eq (Get-TokenHash $newRec.token)) { $tWindow = Get-Date }
                    }
                }
                $lag = $null; if ($tAnswered -and $tWindow) { $lag = [int](($tWindow - $tAnswered).TotalMilliseconds) }
                $old403 = (Get-HttpStatus $oldUrl)
                $txt = Invoke-Native -File $t.NodeExe -ArgList @($cdpEval, [string]$CdpPort, 'text') -TimeoutSec 30
                $note = ($txt.StdOut -match '(?i)address\s+(was\s+)?replaced')
                $okA = ($rs.Exit -eq 0 -and $tWindow -and $lag -le 10000 -and $old403 -eq 403 -and -not $note)
                Add-Step 'A3.restart' $(if ($okA) { 'PASS' } else { 'FAIL' }) "restart exit $($rs.Exit); window on the new URL after the listener answered: $lag ms (limit 10000); old URL answers $old403; 'address replaced' note on the page: $note"

                # b: kill the sb server (a pi session's look may start another within about 6 s; otherwise the follower's gone rule runs up)
                $recNow = Read-JsonFile (Join-Path $sbDir 'server.json')
                $before = Read-GuiRecord
                # kill the server alone, as a crash would; its broker child stays
                $p = Get-Process -Id ([int]$recNow.pid) -EA SilentlyContinue
                if ($p -and (Test-ProcessAlive -ProcessId $p.Id -StartTime $recNow.started)) { $p.Kill() }
                $tWindow = $null
                for ($i = 0; $i -lt 360 -and -not $tWindow; $i++) {
                    Start-Sleep -Milliseconds 250
                    $g = Read-GuiRecord
                    if ($g -and $g.token -and $g.token -ne $before.token) {
                        $w = Get-Window
                        if ($w -and $w.tokenHash -eq (Get-TokenHash $g.token) -and (Get-HttpStatus "http://127.0.0.1:$($g.port)/$($g.token)/") -eq 200) { $tWindow = Get-Date }
                    }
                }
                Add-Step 'A3.kill' $(if ($tWindow) { 'PASS' } else { 'FAIL' }) $(if ($tWindow) { 'the window ended on the new URL after the server was killed' } else { 'the window did not reach a new URL within 90 s' })

                # c: /boss gui stop in the tower, the shell screen, then its Start button
                $st = Read-JsonFile $startFile
                $before = Read-GuiRecord
                [void](Invoke-Herdr @('agent', 'prompt', [string]$st.paneId, '/boss gui stop') 60)
                $screen = $false
                for ($i = 0; $i -lt 120 -and -not $screen; $i++) {
                    Start-Sleep -Milliseconds 500
                    $r = Invoke-Native -File $t.NodeExe -ArgList @($cdpEval, [string]$CdpPort, 'list') -TimeoutSec 30
                    try { $screen = [bool](($r.StdOut | ConvertFrom-Json).pages | Where-Object { $_.kind -eq 'shell-screen' }) } catch { }
                }
                Add-Step 'A3.gui-stopped-screen' $(if ($screen) { 'PASS' } else { 'FAIL' }) $(if ($screen) { 'the window shows the shell screen' } else { 'no shell screen within 60 s of /boss gui stop' })
                if ($screen) {
                    [void](Invoke-Native -File $t.NodeExe -ArgList @($cdpEval, [string]$CdpPort, 'click', 'start') -TimeoutSec 30)
                    $back = $false
                    for ($i = 0; $i -lt 240 -and -not $back; $i++) {
                        Start-Sleep -Milliseconds 500
                        $g = Read-GuiRecord
                        $w = Get-Window
                        if ($g -and -not $g.stopped -and $w -and $w.tokenHash -eq (Get-TokenHash $g.token) -and (Get-HttpStatus "http://127.0.0.1:$($g.port)/$($g.token)/") -eq 200) { $back = $true }
                    }
                    Add-Step 'A3.start-button' $(if ($back) { 'PASS' } else { 'FAIL' }) $(if ($back) { 'Start brought the GUI back in the window' } else { 'the window did not return to a live GUI within 120 s' })
                }
                # Only the lines this pass wrote: the logs also hold older passes (the old kit logged the URL in start's 'end' line).
                $leak = @()
                foreach ($f in @($startJsonl, $protoLog)) {
                    if (-not (Test-Path -LiteralPath $f)) { continue }
                    foreach ($line in (Get-Content -LiteralPath $f -Encoding UTF8)) {
                        $ts = $null; try { $ts = ConvertTo-UtcInstant (($line | ConvertFrom-Json).ts) } catch { }
                        if ($ts -and $ts -ge $passStart.ToUniversalTime() -and $line -match '127\.0\.0\.1:\d+/[0-9a-f]{16,}') { $leak += (Split-Path -Leaf $f); break }
                    }
                }
                # The kit's captured stdout files (Invoke-Kit hides the token after parsing) must hold none either, whatever their age.
                foreach ($f in @(Get-ChildItem -LiteralPath $LogDir -Filter '*.out.log' -ErrorAction SilentlyContinue)) {
                    if ((Get-Content -LiteralPath $f.FullName -Raw -Encoding UTF8) -match '127\.0\.0\.1:\d+/[0-9a-f]{16,}') { $leak += $f.Name }
                }
                Add-Step 'A3.no-token-in-logs' $(if ($leak.Count -eq 0) { 'PASS' } else { 'FAIL' }) $(if ($leak.Count -eq 0) { 'no URL token in start.jsonl, proto.jsonl or logs\*.out.log' } else { "a URL token is in: $($leak -join ', ')" })
            }
            # d: closing the window quits the app; before-quit holds the quit until stop.ps1 has run, and nothing of the kit is left afterwards.
            $recQuit = Read-JsonFile $startFile
            $sinceQuit = Get-Date
            $procs = @(Get-Process -Name 'Straw Boss Desk Proto' -ErrorAction SilentlyContinue)
            foreach ($p in $procs) { [void]$p.CloseMainWindow() }
            $swQuit = [Diagnostics.Stopwatch]::StartNew()
            while ($swQuit.Elapsed.TotalSeconds -lt 240 -and @(Get-Process -Name 'Straw Boss Desk Proto' -ErrorAction SilentlyContinue).Count -gt 0) { Start-Sleep -Milliseconds 500 }
            $exited = (@(Get-Process -Name 'Straw Boss Desk Proto' -ErrorAction SilentlyContinue).Count -eq 0)
            $evQuit = @(Get-StartEvents $sinceQuit)
            $stopEnd = $evQuit | Where-Object { $_.stage -eq 'stop' -and $_.event -eq 'end' } | Select-Object -First 1
            $cliStop = $evQuit | Where-Object { $_.event -eq 'sb-server-stop' } | Select-Object -First 1
            $leftQuit = @(Test-KitGone $recQuit)
            $okQuit = ($procs.Count -gt 0 -and $exited -and $stopEnd -and $cliStop -and $cliStop.exit -eq 0 -and $leftQuit.Count -eq 0)
            Add-Step 'A3.quit-stops-stack' $(if ($okQuit) { 'PASS' } else { 'FAIL' }) "windows closed: app exited=$exited after $([int]$swQuit.Elapsed.TotalSeconds) s; stop.ps1 ran=$([bool]$stopEnd); cli.mjs stop exit $($cliStop.exit) outcome '$($cliStop.outcome)'; kit processes left: $($leftQuit -join '; ')"
            Get-Process -Name 'Straw Boss Desk Proto' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
        }
    }
}

# ---- A4: stop ----------------------------------------------------------------------------------------------------------
if (Test-Item 'A4') {
    $s = Test-OneStart 'A4.stack'
    if ($s) {
        $rec = Read-JsonFile $startFile
        $wsBefore = @(((Invoke-Herdr @('workspace', 'list') 20).StdOut | ConvertFrom-Json).result.workspaces | ForEach-Object { $_.workspace_id })
        $since = Get-Date
        $stop = Invoke-Kit 'stop.ps1' @() 300
        $ev = @(Get-StartEvents $since)
        $cli = $ev | Where-Object { $_.event -eq 'sb-server-stop' } | Select-Object -First 1
        $hs = $ev | Where-Object { $_.event -eq 'herdr-server-stop' } | Select-Object -First 1
        $order = ($cli -and $hs -and ((ConvertTo-UtcInstant $cli.ts) -lt (ConvertTo-UtcInstant $hs.ts)))
        $lastLine = ($stop.Out -split "`r?`n" | Where-Object { $_.Trim() } | Select-Object -Last 1)
        Add-Step 'A4.order' $(if ($order -and $cli.exit -eq 0 -and $cli.outcome -eq 'stopped') { 'PASS' } else { 'FAIL' }) "cli.mjs stop exit $($cli.exit) outcome '$($cli.outcome)' before herdr server stop: $order; stop.ps1 exit $($stop.Exit), last line '$lastLine'"
        $left = @(Test-KitGone $rec)
        Add-Step 'A4.no-leftovers' $(if ($left.Count -eq 0) { 'PASS' } else { 'FAIL' }) $(if ($left.Count -eq 0) { 'no recorded process of the kit is left (by pid and start time)' } else { "left: $($left -join '; ')" })
        $any = @(Get-KitProcesses)
        $sbRecPid = $null; $sbRec = Read-JsonFile (Join-Path $sbDir 'server.json'); if ($sbRec) { $sbRecPid = [int]$sbRec.pid }
        $sbAlive = ($sbRecPid -and (Get-Process -Id $sbRecPid -ErrorAction SilentlyContinue))
        Add-Step 'A4.no-kit-node-herdr' $(if ($any.Count -eq 0 -and -not $sbAlive) { 'PASS' } else { 'FAIL' }) $(if ($any.Count -eq 0 -and -not $sbAlive) { "no node.exe or herdr.exe runs from or names the kit root; server.json pid $sbRecPid is gone" } else { "left: $($any -join '; '); server.json pid $sbRecPid alive: $([bool]$sbAlive)" })
        $again = Invoke-Kit 'start.ps1'
        $wsAfter = @(((Invoke-Herdr @('workspace', 'list') 20).StdOut | ConvertFrom-Json).result.workspaces | ForEach-Object { $_.workspace_id })
        $missing = @($wsBefore | Where-Object { $wsAfter -notcontains $_ })
        Add-Step 'A4.workspaces-return' $(if ($again.Exit -eq 0 -and $missing.Count -eq 0) { 'PASS' } else { 'FAIL' }) "workspaces before stop: $($wsBefore -join ','); after start: $($wsAfter -join ','); missing: $($missing -join ',')"
    }
}

# ---- A5: injected failures ----------------------------------------------------------------------------------------------
# Five injections, A5a to A5e; -Only A5d runs just the repair (it needs the VM's network with WARP off on the Mac).
function Start-HerdrOnly {
    $h = Start-Process -FilePath $t.HerdrExe -ArgumentList 'server' -WindowStyle Hidden -PassThru
    for ($i = 0; $i -lt 90 -and (Invoke-Herdr @('workspace', 'list') 10).ExitCode -ne 0; $i++) { Start-Sleep -Milliseconds 500 }
    return $h
}

# a. herdr not running: `up` names the herdr step.
if (Test-Sub 'a') {
    Reset-KitState
    $u = Get-NodeJson @($sbCli, 'up', '--timeout', '20', '--exact') 60
    Add-Step 'A5.herdr-down' $(if ($u.Exit -eq 1 -and $u.Err.step -eq 'herdr') { 'PASS' } else { 'FAIL' }) "up exit $($u.Exit), step '$($u.Err.step)' (expected 1, herdr)"
}

# b. up --timeout 1 on a cold start (herdr running, no server): wait=start. The plan says 5 s, but a cold start answers in 2 to 5 s on an idle VM (exit 0 in the pass of
# 2026-10-28), so 5 s proves nothing; 1 s always runs out.
if (Test-Sub 'b') {
    Reset-KitState
    $h = Start-HerdrOnly
    $u = Get-NodeJson @($sbCli, 'up', '--timeout', '1', '--exact') 60
    Add-Step 'A5.up-timeout-1' $(if ($u.Exit -eq 1 -and ($u.Err.wait -eq 'start' -or $u.Err.step -eq 'gui' -or $u.Err.step -eq 'server')) { 'PASS' } else { 'FAIL' }) "up --timeout 1: exit $($u.Exit), step '$($u.Err.step)', wait '$($u.Err.wait)' (expected 1, wait start)"
    [void](Get-NodeJson @($sbCli, 'stop') 150)
    try { if (-not $h.HasExited) { $h.Kill() } } catch { }
    [void](Invoke-Kit 'stop.ps1' @() 300)
}

# c. server.lock held by a live process until 24 s: with -UpTimeoutSec 20 the first up reports wait=lock after its 20 s, start.ps1 retries once, and the retry gets the lock.
if (Test-Sub 'c') {
    Reset-KitState
    [void](Invoke-Kit 'start.ps1')
    [void](Invoke-Kit 'stop.ps1' @() 300)
    $lockFile = Join-Path $sbDir 'server.lock'
    $holder = Start-Process -FilePath $psExe -ArgumentList '-NoProfile -Command Start-Sleep -Seconds 120' -WindowStyle Hidden -PassThru
    $lockBody = (@{ pid = $holder.Id; by = 'desk-b7-check'; since = (Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress)
    Write-AllTextUtf8 $lockFile $lockBody
    $rel = Start-Job -ScriptBlock { param($p, $pidToStop) Start-Sleep -Seconds 24; Remove-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue } -ArgumentList $lockFile
    $since = Get-Date
    $r = Invoke-Kit 'start.ps1' @('-UpTimeoutSec', '20')
    Wait-Job $rel -Timeout 30 | Out-Null; Remove-Job $rel -Force -ErrorAction SilentlyContinue
    try { if (-not $holder.HasExited) { $holder.Kill() } } catch { }
    $retry = @(Get-StartEvents $since | Where-Object { $_.event -eq 'up-attempt-failed' -and $_.class -eq 'lock' })
    Add-Step 'A5.lock-then-retry' $(if ($r.Exit -eq 0 -and $retry.Count -ge 1) { 'PASS' } else { 'FAIL' }) "start.ps1 exit $($r.Exit); up-attempt-failed class lock: $($retry.Count) (expected the lock failure, then success on the retry)"
    [void](Invoke-Kit 'stop.ps1' @() 300)
}

# d. tsx missing: exit 3 loader, then the repair stage reinstalls pi-straw-boss and the retry succeeds.
if (Test-Sub 'd') {
    Reset-KitState
    $tsx = @((Join-Path $t.AgentNm 'tsx'), (Join-Path $t.AgentNm 'pi-straw-boss\node_modules\tsx')) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    if (-not $tsx) { Add-Step 'A5.tsx-missing' 'SKIP' 'no tsx folder found under the agent npm tree' }
    else {
        $off = $tsx + '.b7off'
        Rename-Item -LiteralPath $tsx -NewName (Split-Path -Leaf $off)
        try {
            $since = Get-Date
            $r = Invoke-Kit 'start.ps1' 2400
            $ev = @(Get-StartEvents $since)
            $rep = @($ev | Where-Object { $_.event -eq 'repair' })
            $loader = @($ev | Where-Object { $_.event -eq 'up-attempt-failed' -and $_.class -eq 'loader' })
            $back = Test-Path -LiteralPath $tsx
            Add-Step 'A5.tsx-missing' $(if ($loader.Count -ge 1 -and $rep.Count -ge 1 -and $rep[0].exit -eq 0 -and $r.Exit -eq 0) { 'PASS' } else { 'FAIL' }) "first up class loader: $($loader.Count) (exit $(($loader | ForEach-Object { $_.exit }) -join ',')); repair: $($rep.Count) (package $(($rep | ForEach-Object { $_.package }) -join ',') exit $(($rep | ForEach-Object { $_.exit }) -join ',')); tsx folder back after the repair: $back; start.ps1 exit $($r.Exit)"
        } finally {
            if (Test-Path -LiteralPath $off) { if (Test-Path -LiteralPath $tsx) { Remove-Item -LiteralPath $off -Recurse -Force -ErrorAction SilentlyContinue } else { Rename-Item -LiteralPath $off -NewName (Split-Path -Leaf $tsx) } }
        }
        [void](Invoke-Kit 'stop.ps1' @() 300)
    }
}

# e. a server running without the desk switch (someone ran `up` in a shell without it): start.ps1's `up` restarts it ("desk switch") under a new token and ends with a live desk server.
if (Test-Sub 'e') {
    Reset-KitState
    $r0 = Invoke-Kit 'start.ps1'
    [void](Get-NodeJson @($sbCli, 'stop') 150)
    $saved = $env:STRAW_BOSS_DESK
    Remove-Item Env:STRAW_BOSS_DESK
    $u0 = Get-NodeJson @($sbCli, 'up', '--timeout', '90') 150
    $env:STRAW_BOSS_DESK = $saved
    $tokenBefore = (Read-GuiRecord).token
    $since = Get-Date
    $r = Invoke-Kit 'start.ps1'
    $tokenAfter = (Read-GuiRecord).token
    $st = (Get-Status).Json
    $upEv = @(Get-StartEvents $since | Where-Object { $_.event -eq 'sb-server-up' } | Select-Object -Last 1)
    Add-Step 'A5.desk-switch' $(if ($r0.Exit -eq 0 -and $u0.Exit -eq 0 -and $u0.Json.desk -eq $false -and $r.Exit -eq 0 -and $st.desk -eq $true -and $tokenBefore -ne $tokenAfter -and $upEv.Count -eq 1 -and $upEv[0].server -eq 'restarted') { 'PASS' } else { 'FAIL' }) "first start exit $($r0.Exit); up without the switch: exit $($u0.Exit) desk=$($u0.Json.desk); start.ps1 exit $($r.Exit), up server '$($upEv[0].server)'; status desk=$($st.desk); token moved: $($tokenBefore -ne $tokenAfter)"
    [void](Invoke-Kit 'stop.ps1' @() 300)
}

Save-AccountResult
