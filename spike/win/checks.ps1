<#
.SYNOPSIS
  One command per check; each prints PASS / FAIL / SKIP with evidence and lands in results\checks-<timestamp>.json.
.DESCRIPTION
  Needs bootstrap.ps1 to have run. Starts the stack with start.ps1 when it is not running (use -NoStart to forbid that).
  Account-based checks are separate scripts: check-claude.ps1, check-github.ps1, check-gitlab.ps1, check-ttt.ps1.
.PARAMETER Only
  Run only the named checks (see the Add-Check calls below).
#>
param(
    [string[]]$Only,
    [switch]$NoStart
)

. (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'lib.ps1')
$script:LogFile = Join-Path $LogDir 'checks.jsonl'
Set-SbdEnv
$t = Get-ToolPaths
$libDir = Join-Path $KitDir 'lib'
$guiJson = Join-Path $AgentDir 'straw-boss\gui.json'
$script:Results = New-Object System.Collections.ArrayList
$script:Ctx = @{}

function Add-Check {
    param([string]$Name, [scriptblock]$Body)
    if ($Only -and ($Only -notcontains $Name)) { return }
    $sw = [Diagnostics.Stopwatch]::StartNew()
    try {
        $r = & $Body
        if (-not $r -or -not $r.status) { $r = New-Result $Name 'FAIL' 'check returned nothing' }
    } catch {
        $r = New-Result $Name 'FAIL' ("exception: " + $_.Exception.Message)
    }
    $r | Add-Member -NotePropertyName ms -NotePropertyValue ([int]$sw.ElapsedMilliseconds) -Force
    $r.name = $Name
    [void]$script:Results.Add($r)
    Write-Host ("{0,-4} {1,-26} {2}" -f $r.status, $Name, $r.evidence)
    Write-Log 'check' $Name @{ status = $r.status; ms = $r.ms; evidence = $r.evidence }
}
function Pass { param([string]$Evidence, $Data) New-Result '' 'PASS' $Evidence $Data }
function Fail { param([string]$Evidence, $Data) New-Result '' 'FAIL' $Evidence $Data }
function Skip { param([string]$Evidence) New-Result '' 'SKIP' $Evidence }

function Invoke-Node {
    param([string[]]$ArgList, [int]$TimeoutSec = 90)
    $r = Invoke-Native -File $t.NodeExe -ArgList $ArgList -TimeoutSec $TimeoutSec
    $json = $null
    $line = ($r.StdOut -split "`r?`n" | Where-Object { $_.Trim().StartsWith('{') } | Select-Object -Last 1)
    if ($line) { try { $json = $line | ConvertFrom-Json } catch { } }
    [pscustomobject]@{ Raw = $r; Json = $json }
}
function Invoke-Herdr {
    param([string[]]$ArgList, [int]$TimeoutSec = 30)
    Invoke-Native -File $t.HerdrExe -ArgList $ArgList -TimeoutSec $TimeoutSec
}
function Invoke-Gui {
    param([string]$Cmd, $Arg, [int]$TimeoutSec = 90)
    $a = @((Join-Path $libDir 'gui-client.mjs'), $guiJson, $Cmd)
    if ($Arg) { $a += ($Arg | ConvertTo-Json -Compress) }
    Invoke-Node $a $TimeoutSec
}
function Ensure-Started {
    if ($script:Ctx.Started) { return $true }
    $s = Read-JsonFile (Join-Path $StateDir 'start.json')
    if ($s -and $s.url -and (Test-ProcessAlive -ProcessId ([int]$s.serverPid) -StartTime $s.serverStart)) { $script:Ctx.Started = $true; return $true }
    if ($NoStart) { return $false }
    # start.ps1 leaves a herdr server behind. Run through Invoke-Native (redirected pipes), that server held the pipes open after
    # start.ps1 exited and ReadToEnd/WaitForExit never returned. So the child gets no inherited handles: cmd.exe is started through
    # ShellExecute (Start-Process without a redirect), and cmd itself sends start.ps1's output to a file.
    $ps = (Get-Command powershell.exe).Source
    $startOut = Join-Path $LogDir 'checks-start.out.log'
    if (Test-Path -LiteralPath $startOut) { Remove-Item -LiteralPath $startOut -Force -ErrorAction SilentlyContinue }
    $inner = '"' + $ps + '" -NoProfile -ExecutionPolicy Bypass -File "' + (Join-Path $KitDir 'start.ps1') + '" > "' + $startOut + '" 2>&1'
    $cmd = Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\cmd.exe') -ArgumentList ('/c "' + $inner + '"') -WindowStyle Hidden -PassThru
    $null = $cmd.Handle
    $startExit = $null
    if ($cmd.WaitForExit(400000)) { $startExit = $cmd.ExitCode } else { & taskkill.exe /PID $cmd.Id /T /F 2>&1 | Out-Null }
    $script:Ctx.StartOut = (Get-Content -LiteralPath $startOut -Raw -ErrorAction SilentlyContinue)
    if ($null -eq $startExit) { $script:Ctx.StartOut = 'start.ps1 timed out after 400 s. ' + $script:Ctx.StartOut }
    $script:Ctx.Started = ($startExit -eq 0)
    return $script:Ctx.Started
}

# ---------------------------------------------------------------- environment
Add-Check 'environment' {
    $info = Get-OsInfo
    $lp = $null
    try { $lp = (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem' -Name LongPathsEnabled).LongPathsEnabled } catch { }
    $def = $null
    try { $m = Get-MpComputerStatus; $def = [ordered]@{ realTime = $m.RealTimeProtectionEnabled; antivirus = $m.AntivirusEnabled; engine = $m.AMEngineVersion } } catch { $def = "unavailable: $($_.Exception.Message)" }
    $py = (Invoke-Native -File 'where.exe' -ArgList @('python3') -TimeoutSec 15)
    $info['longPathsEnabled'] = $lp
    $info['defender'] = $def
    $info['python3OnPath'] = (Get-FirstLine $py.StdOut)
    $info['executionPolicy'] = (Get-ExecutionPolicy).ToString()
    $info['isAdmin'] = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    $ev = "$($info.caption) build $($info.build) $($info.osArchitecture); profile=$($info.userProfile) nonAscii=$($info.profileIsNonAscii); LongPathsEnabled=$lp; admin=$($info.isAdmin); python3='$($info.python3OnPath)'"
    if (-not $info.profileIsNonAscii) { return (New-Result '' 'FAIL' ("profile path is ASCII, the Chinese-profile scenario is not exercised. " + $ev) $info) }
    Pass $ev $info
}

# ---------------------------------------------------------------- tool versions
Add-Check 'tool-versions' {
    $rows = [ordered]@{}
    $bad = @()
    $list = @(
        @('node', $t.NodeExe, @('--version')), @('node.arch', $t.NodeExe, @('-p', 'process.arch')), @('npm', $t.NpmCmd, @('--version')),
        @('git', $t.GitExe, @('--version')), @('bash', $t.BashExe, @('--version')), @('herdr', $t.HerdrExe, @('--version')),
        @('pi', $t.PiCmd, @('--version')), @('ttt', $t.TttCmd, @('--version')), @('playwriter', $t.PwCmd, @('--version'))
    )
    foreach ($e in $list) {
        $r = Invoke-Native -File $e[1] -ArgList $e[2] -TimeoutSec 90
        $line = Get-FirstLine ($r.StdOut + "`n" + $r.StdErr)
        $rows[$e[0]] = [ordered]@{ exit = $r.ExitCode; out = $line; ms = $r.Ms }
        if ($r.ExitCode -ne 0) { $bad += $e[0] }
    }
    $ev = ($rows.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value.out)" }) -join '; '
    if ($bad.Count) { return (Fail ("not running: $($bad -join ', '). " + $ev) $rows) }
    Pass $ev $rows
}

# ---------------------------------------------------------------- bash found by pi
Add-Check 'bash-found-by-pi' {
    $pkgDir = Join-Path $t.PiModules '@earendil-works\pi-coding-agent'
    $r = Invoke-Node @((Join-Path $libDir 'pi-shell.mjs'), $pkgDir)
    if (-not $r.Json) { return (Fail ("pi-shell.mjs printed no JSON: " + (Get-FirstLine ($r.Raw.StdErr + $r.Raw.StdOut)))) }
    $j = $r.Json
    $isPrivate = ($j.shell -like (Join-Path $t.Git '*'))
    $ev = "pi resolves shell=$($j.shell) (settings shellPath=$($j.settingsShellPath); where bash.exe=$(@($j.whereBash) -join ' ; ')) args=$($j.args -join ' ') private=$isPrivate probeStatus=$($j.probeStatus) :: $(($j.probeOut -split "`r?`n" | Where-Object { $_ }) -join ' | ')"
    if ($j.probeStatus -ne 0) { return (Fail $ev $j) }
    if (-not $isPrivate) { return (Fail ("pi picked a different bash than the private PortableGit. " + $ev) $j) }
    Pass $ev $j
}

# ---------------------------------------------------------------- Chinese profile paths
Add-Check 'paths-chinese-profile' {
    if (-not (Test-Path -LiteralPath $WorkDir)) { New-Item -ItemType Directory -Path $WorkDir -Force | Out-Null }
    $n = Invoke-Node @((Join-Path $libDir 'pathcheck.mjs'), $WorkDir)
    $zhName = ([string][char]0x4E2D) + [char]0x6587 + [char]0x5C08 + [char]0x6848
    $repo = Join-Path $WorkDir $zhName
    # A repo left by an earlier run would make `git commit` exit 1 with "nothing to commit" (VM 2026-10-27): start from nothing.
    if (Test-Path -LiteralPath $repo) { Remove-Item -LiteralPath $repo -Recurse -Force -ErrorAction SilentlyContinue }
    $steps = [ordered]@{}
    $steps['node'] = if ($n.Json) { $n.Json } else { "no json: $($n.Raw.StdErr)" }
    $g = $t.GitExe
    [void](Invoke-Native -File $g -ArgList @('init', '-q', $repo))
    Set-Content -LiteralPath (Join-Path $repo ($zhName + '.md')) -Value 'hello' -Encoding UTF8
    $steps['gitAdd'] = (Invoke-Native -File $g -ArgList @('-C', $repo, 'add', '-A')).ExitCode
    $c = Invoke-Native -File $g -ArgList @('-C', $repo, 'commit', '-q', '-m', 'chore: chinese path')
    $steps['gitCommit'] = $c.ExitCode
    $steps['gitLsFiles'] = (Get-FirstLine (Invoke-Native -File $g -ArgList @('-C', $repo, '-c', 'core.quotepath=false', 'ls-files')).StdOut)
    $piList = Invoke-Native -File $t.PiCmd -ArgList @('list') -Cwd $repo -TimeoutSec 120
    $steps['piListFromZhCwd'] = $piList.ExitCode
    $bashOut = Invoke-Native -File $t.BashExe -ArgList @('-c', 'cd "$1" && pwd && ls', '_', $repo) -TimeoutSec 30
    $steps['bashCdZh'] = [ordered]@{ exit = $bashOut.ExitCode; out = ($bashOut.StdOut -replace "`r?`n", ' | ') }
    $nodeOk = $n.Json -and $n.Json.zh.mkdir.ok -and $n.Json.zh.write.ok -and $n.Json.zh.read.ok
    $ok = $nodeOk -and $steps['gitAdd'] -eq 0 -and $steps['gitCommit'] -eq 0 -and $steps['piListFromZhCwd'] -eq 0 -and $bashOut.ExitCode -eq 0
    $ev = "profile=$env:USERPROFILE; node zh-io=$nodeOk; git commit=$($steps['gitCommit']); pi list in zh cwd=$($steps['piListFromZhCwd']); bash cd zh=$($bashOut.ExitCode) ($($steps['bashCdZh'].out))"
    if ($ok) { Pass $ev $steps } else { Fail $ev $steps }
}

# ---------------------------------------------------------------- Defender / long paths during installs
Add-Check 'npm-install-fs-errors' {
    $state = Read-JsonFile (Join-Path $StateDir 'bootstrap-state.json')
    $hits = New-Object System.Collections.ArrayList
    if ($state) {
        foreach ($p in $state.PSObject.Properties) { foreach ($e in @($p.Value.fsErrors)) { if ($e) { [void]$hits.Add("$($p.Name): $e") } } }
    }
    foreach ($f in (Get-ChildItem -LiteralPath $LogDir -Filter '*.log' -ErrorAction SilentlyContinue)) {
        foreach ($e in (Get-FsErrors (Get-Content -LiteralPath $f.FullName -Raw -ErrorAction SilentlyContinue))) { [void]$hits.Add("$($f.Name): $e") }
    }
    $slow = @()
    if ($state) { foreach ($p in $state.PSObject.Properties) { if ($p.Value.ms -gt 120000) { $slow += "$($p.Name)=$([int]($p.Value.ms/1000))s" } } }
    $lp = $null
    try { $lp = (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem' -Name LongPathsEnabled).LongPathsEnabled } catch { }
    $n = Invoke-Node @((Join-Path $libDir 'pathcheck.mjs'), $WorkDir)
    $lpTest = if ($n.Json) { $n.Json.longPath } else { $null }
    $data = [ordered]@{ errors = @($hits); slowStages = $slow; longPathsEnabled = $lp; longPathTest = $lpTest }
    $ev = "EPERM/ENAMETOOLONG/locked-file lines=$($hits.Count); slow stages (>2 min)=$($slow -join ',' ); LongPathsEnabled=$lp; node 330-char path mkdir/write ok=$(if ($lpTest) { $lpTest.mkdir.ok -and $lpTest.write.ok } else { 'n/a' })"
    if ($hits.Count -gt 0) { Fail $ev $data } else { Pass $ev $data }
}

# ---------------------------------------------------------------- pi packages loaded
Add-Check 'pi-packages-installed' {
    # The pins come from pins.json beside this script (the kit copy in the VM), so a stale kit copy checks stale versions: the
    # evidence names the pins file. settings.json is read too: pi loads what it lists, and `pi install` of a new pin can leave the
    # old `npm:<name>@<old version>` entry beside the new one.
    $pins = Get-Pins
    $pinsFile = Join-Path $KitDir 'pins.json'
    $missing = @()
    $gaps = @()
    $stale = @()
    $cfg = Read-JsonFile (Join-Path $AgentDir 'settings.json')
    $listed = @()
    if ($cfg -and $cfg.packages) { $listed = @($cfg.packages | ForEach-Object { if ($_ -is [string]) { $_ } else { [string]$_.source } }) }
    foreach ($pk in $pins.piPackages) {
        $o = Read-JsonFile (Join-Path $t.AgentNm ((($pk.name) -replace '/', '\') + '\package.json'))
        if (-not $o -or $o.version -ne $pk.version) { $missing += "$($pk.name)@$($pk.version) (installed: $(if ($o) { $o.version } else { 'none' }))" }
        $want = "npm:$($pk.name)@$($pk.version)"
        if ($listed -notcontains $want) { $missing += "$want not in settings.json" }
        foreach ($l in $listed) { if ($l -like "npm:$($pk.name)@*" -and $l -ne $want) { $stale += $l } }
        if ($pk.gap) { $gaps += $pk.name }
    }
    $list = Invoke-Native -File $t.PiCmd -ArgList @('list') -TimeoutSec 120
    $intercom = @($pins.piPackages | Where-Object { $_.name -eq 'pi-intercom' })[0].version
    $data = [ordered]@{ pinsFile = $pinsFile; missing = $missing; staleSettingsEntries = $stale; gapsVersusAuthor = $gaps; piList = $list.StdOut }
    if ($missing.Count -or $stale.Count) { return (Fail ("pins=$pinsFile; missing: $($missing -join ', '); stale settings entries: $($stale -join ', ')") $data) }
    Pass "$(@($pins.piPackages).Count) pi packages at pinned versions (pi-intercom $intercom); npm-vs-fork gaps: $($gaps -join ', ')" $data
}

# ---------------------------------------------------------------- anchorloop without python3
Add-Check 'anchorloop-write-edit-no-python' {
    $pkg = Join-Path $t.AgentNm 'pi-anchorloop'
    if (-not (Test-Path -LiteralPath $pkg)) { return (Fail 'pi-anchorloop not installed') }
    $target = Join-Path $WorkDir 'anchorloop-probe.txt'
    Set-Content -LiteralPath $target -Value 'probe' -Encoding UTF8
    $r = Invoke-Node @((Join-Path $libDir 'anchorloop-validate.mjs'), $pkg, $target, $WorkDir)
    if (-not $r.Json) { return (Fail ("no JSON: " + (Get-FirstLine ($r.Raw.StdErr + $r.Raw.StdOut)))) }
    $j = $r.Json
    $py = (Get-FirstLine (Invoke-Native -File 'where.exe' -ArgList @('python3') -TimeoutSec 15).StdOut)
    $data = [ordered]@{ python3Ran = $j.python3Ran; faithfulToSource = $j.faithfulToSource; python3OnPath = $py; validatorMessage = $j.message }
    $ev = "python3 on PATH='$py'; python3Ran=$($j.python3Ran); message appended to every write/edit result: '$($j.message)'"
    if (-not $j.faithfulToSource) { return (Skip ("pi-anchorloop source changed, replica not faithful. " + $ev)) }
    # The behaviour under test is the message itself; with no python it is a warning that lands in the model's context after every edit.
    if ($j.python3Ran) { Pass $ev $data } else { Pass ("(expected gap) " + $ev) $data }
}

# ---------------------------------------------------------------- Claude Code executable from the Agent SDK
Add-Check 'claude-sdk-executable' {
    $bridge = Join-Path $t.AgentNm 'pi-claude-bridge'
    if (-not (Test-Path -LiteralPath $bridge)) { return (Fail 'pi-claude-bridge not installed') }
    $r = Invoke-Node @((Join-Path $libDir 'sdk-exe.mjs'), $bridge) 180
    if (-not $r.Json) { return (Fail ("no JSON: " + (Get-FirstLine ($r.Raw.StdErr + $r.Raw.StdOut)))) }
    $j = $r.Json
    $pk = ($j.packages.PSObject.Properties | ForEach-Object { "$($_.Name -replace '@anthropic-ai/claude-agent-sdk-','')=$($_.Value.installed)" }) -join ' '
    $ran = @($j.executables | Where-Object { $_.status -eq 0 })
    $ev = "node arch=$($j.nodeArch); SDK $($j.sdk.version); platform packages installed: $pk; claude.exe files=$(@($j.claudeExeFiles).Count); ran: $(($ran | ForEach-Object { "$($_.name) -> $($_.out)" }) -join '; ')"
    if ($ran.Count -ge 1) { Pass $ev $j } else { Fail $ev $j }
}

# ---------------------------------------------------------------- start the stack
Add-Check 'stack-start' {
    $ok = Ensure-Started
    $s = Read-JsonFile (Join-Path $StateDir 'start.json')
    if (-not $ok) { return (Fail ("start.ps1 failed. " + (Get-FirstLine $script:Ctx.StartOut) + ' see logs\start.jsonl')) }
    Pass "herdr server pid=$($s.serverPid) sb server pid=$($s.sbServerPid) tower pane=$($s.paneId) url=$($s.url) totalMs=$($s.totalMs)" $s
}

Add-Check 'herdr-pane-runs-pi' {
    if (-not (Ensure-Started)) { return (Skip 'stack not started') }
    $s = Read-JsonFile (Join-Path $StateDir 'start.json')
    $l = Invoke-Herdr @('pane', 'list') 30
    $panes = @((($l.StdOut | ConvertFrom-Json).result.panes))
    $tower = $panes | Where-Object { $_.pane_id -eq $s.paneId } | Select-Object -First 1
    $read = Invoke-Herdr @('pane', 'read', $s.paneId, '--source', 'visible', '--lines', '40') 30
    $lines = @($read.StdOut -split "`r?`n" | Where-Object { $_.Trim() } | Select-Object -First 8)
    $errs = @($read.StdOut -split "`r?`n" | Where-Object { $_ -match 'Failed to load|Cannot find module|Error:|ERR_' } | Select-Object -First 5)
    $data = [ordered]@{ pane = $tower; screenSample = $lines; loadErrors = $errs }
    $ev = "tower pane agent=$($tower.agent) status=$($tower.agent_status) sb_role=$($tower.tokens.sb_role); load-error lines on screen=$($errs.Count)"
    if ($tower.agent -eq 'pi') { if ($errs.Count) { Fail $ev $data } else { Pass $ev $data } } else { Fail $ev $data }
}

Add-Check 'gui-answers-200' {
    if (-not (Ensure-Started)) { return (Skip 'stack not started') }
    $r = Invoke-Gui 'page' $null
    # pi-straw-boss records the owner's start time from `ps` (remote.ts startOf); Windows has no ps, so `started` is probably absent
    # and no surviving session would adopt the server. Recorded here as a finding, not a failure.
    $rec = Read-JsonFile $guiJson
    $hasStarted = [bool]($rec -and $rec.started)
    $ev = "GET gui page -> $($r.Json.status) ($($r.Json.bytes) bytes); gui.json: port=$($rec.port) version=$($rec.version) started-recorded=$hasStarted (false means no adoption by survivors on Windows)"
    $data = [ordered]@{ page = $r.Json; guiJsonHasStarted = $hasStarted; guiJsonKeys = @($rec.PSObject.Properties.Name) }
    if ($r.Json -and $r.Json.status -eq 200) { Pass $ev $data } else { Fail $ev $data }
}

Add-Check 'new-base-via-gui-api' {
    if (-not (Ensure-Started)) { return (Skip 'stack not started') }
    $dir = Join-Path $WorkDir 'base-check'
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $d = Invoke-Gui 'dirs' @{ path = $WorkDir }
    $r = Invoke-Gui 'open-base' @{ dir = $dir; label = 'base-check' } 150
    if (-not $r.Json) { return (Fail ("no JSON: " + (Get-FirstLine ($r.Raw.StdErr + $r.Raw.StdOut)))) }
    $j = $r.Json
    $script:Ctx.BaseSession = $j.body.session
    $script:Ctx.BasePane = $j.body.pane
    $data = [ordered]@{ dirsStatus = $d.Json.status; dirsSample = @($d.Json.body.dirs | Select-Object -First 5); openBase = $j }
    $ev = "POST /api/dirs -> $($d.Json.status); POST /api/open/base -> $($j.status) workspace=$($j.body.workspace) pane=$($j.body.pane) session=$($j.body.session) $($j.body.reason)"
    if ($j.status -eq 200) {
        $l = Invoke-Herdr @('pane', 'list') 30
        $pi = @((($l.StdOut | ConvertFrom-Json).result.panes) | Where-Object { $_.agent -eq 'pi' })
        $data['piPanes'] = $pi.Count
        $ev += "; pi panes now=$($pi.Count)"
        if ($pi.Count -ge 2) { return (Pass $ev $data) }
    }
    Fail $ev $data
}

Add-Check 'terminal-mirror-rows' {
    if (-not (Ensure-Started)) { return (Skip 'stack not started') }
    $arg = @{ waitMs = 25000 }
    if ($script:Ctx.BaseSession) { $arg['key'] = $script:Ctx.BaseSession }
    $r = Invoke-Gui 'mirror' $arg 60
    if (-not $r.Json) { return (Fail ("no JSON: " + (Get-FirstLine ($r.Raw.StdErr + $r.Raw.StdOut)))) }
    $j = $r.Json
    $ev = "mirror attach=$($j.attached.status) frames=$($j.frames) rows=$($j.rows) cols=$($j.cols) nonEmptyRows=$($j.nonEmptyRows) problem=$($j.problem) sample='$(@($j.sample) -join ' / ')'"
    if ($j.rows -gt 0 -and $j.nonEmptyRows -gt 0) { Pass $ev $j } else { Fail $ev $j }
}

Add-Check 'ttt-version-only' {
    $r = Invoke-Native -File $t.TttCmd -ArgList @('--help') -TimeoutSec 60
    $first = Get-FirstLine ($r.StdOut + $r.StdErr)
    if ($r.ExitCode -eq 0) { Pass "ttt --help works: $first" } else { Fail "ttt --help exit $($r.ExitCode): $first" }
}

# ---------------------------------------------------------------- write results
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$summary = [ordered]@{
    startedAt = (Get-Date).ToUniversalTime().ToString('o')
    os = (Get-OsInfo)
    counts = [ordered]@{
        pass = @($Results | Where-Object { $_.status -eq 'PASS' }).Count
        fail = @($Results | Where-Object { $_.status -eq 'FAIL' }).Count
        skip = @($Results | Where-Object { $_.status -eq 'SKIP' }).Count
    }
    checks = $Results
}
$file = Join-Path $ResultDir "checks-$stamp.json"
Write-JsonFile $file $summary 10
Write-JsonFile (Join-Path $ResultDir 'checks-latest.json') $summary 10
Write-Host ''
Write-Host "PASS=$($summary.counts.pass) FAIL=$($summary.counts.fail) SKIP=$($summary.counts.skip)  -> $file"
if ($summary.counts.fail -gt 0) { exit 1 }
