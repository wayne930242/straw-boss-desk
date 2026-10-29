# Shared helpers for the straw-boss-desk Windows spike kit.
# Dot-source this file; it never touches anything outside $SbdRoot except the spike workspace in the user's home.
# Written for Windows PowerShell 5.1 (the OpenSSH default on Windows 11) and PowerShell 7: ASCII only, no ?? or ternary.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }

$script:KitDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if ($env:SBD_ROOT) { $script:SbdRoot = $env:SBD_ROOT } else { $script:SbdRoot = Join-Path $env:LOCALAPPDATA 'straw-boss-desk' }
$script:Tools     = Join-Path $SbdRoot 'tools'
$script:AgentDir  = Join-Path $SbdRoot 'agent'
$script:LogDir    = Join-Path $SbdRoot 'logs'
$script:StateDir  = Join-Path $SbdRoot 'state'
$script:ResultDir = Join-Path $SbdRoot 'results'
# The app-owned XDG_CONFIG_HOME. Herdr's default socket for that environment is <ConfigHome>\herdr\herdr.sock, and pi-straw-boss calls the server of the default
# Herdr the primary one (it holds Straw Link and keeps its files in <agent dir>\straw-boss\ itself). The text must equal what pi-straw-boss's
# path.win32.join builds, hence GetFullPath (no forward slashes, no trailing separator, no '..').
$script:ConfigHome = [IO.Path]::GetFullPath((Join-Path $SbdRoot 'config')).TrimEnd('\')
$script:HerdrDir  = Join-Path $ConfigHome 'herdr'
$script:ClaudeDir = Join-Path $SbdRoot 'claude'
$script:NpmPrefix = Join-Path $Tools 'npm'
$script:NpmCache  = Join-Path $Tools 'npm-cache'
$script:DlDir     = Join-Path $Tools 'downloads'
# The folder panes start in. It sits under the user's profile (the GUI folder picker never leaves home) and keeps the profile's non-ASCII name in play.
$script:WorkDir   = Join-Path $env:USERPROFILE 'sbd-playground'
# The home base (desk-mode spec, Notes for the shell): a visible folder under home. `up --dir` needs it to exist and `--label` names the workspace.
$script:BaseDir   = Join-Path $env:USERPROFILE 'Straw Boss'
$script:BaseLabel = 'Straw Boss'

foreach ($d in @($SbdRoot, $Tools, $AgentDir, $LogDir, $StateDir, $ResultDir, $HerdrDir, $ClaudeDir, $DlDir)) {
    if (-not (Test-Path -LiteralPath $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
}

function Get-Pins { Get-Content -LiteralPath (Join-Path $KitDir 'pins.json') -Raw -Encoding UTF8 | ConvertFrom-Json }

function Get-Utf8NoBom { New-Object System.Text.UTF8Encoding($false) }

function Write-AllTextUtf8 {
    param([string]$Path, [string]$Text)
    $dir = Split-Path -Parent $Path
    if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    [IO.File]::WriteAllText($Path, $Text, (Get-Utf8NoBom))
}

# One JSON object per line. $script:LogFile is set by the calling script.
function Write-Log {
    param([string]$Stage, [string]$Event, $Data)
    $o = [ordered]@{ ts = (Get-Date).ToUniversalTime().ToString('o'); stage = $Stage; event = $Event }
    if ($Data) { foreach ($k in $Data.Keys) { $o[$k] = $Data[$k] } }
    $line = ($o | ConvertTo-Json -Compress -Depth 6)
    if ($script:LogFile) {
        $dir = Split-Path -Parent $script:LogFile
        if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
        [IO.File]::AppendAllText($script:LogFile, $line + [Environment]::NewLine, (Get-Utf8NoBom))
    }
    $msg = "[$Stage] $Event"
    if ($Data -and $Data.ContainsKey('detail')) { $msg += ' - ' + $Data['detail'] }
    if ($Data -and $Data.ContainsKey('ms')) { $msg += ' (' + $Data['ms'] + ' ms)' }
    Write-Host $msg
}

function Get-Arch {
    param([string]$Requested)
    if ($Requested) { return $Requested }
    # PROCESSOR_ARCHITEW6432 is set for an x86/emulated process on a 64-bit OS; the VM is ARM64 but PMs use x64, so default to x64.
    return 'x64'
}

function Join-ArgString {
    param([string[]]$ArgList)
    $parts = foreach ($a in $ArgList) {
        if ($null -eq $a) { continue }
        if ($a -eq '') { '""'; continue }
        if ($a -notmatch '[\s"]') { $a; continue }
        $q = $a -replace '(\\*)"', '$1$1\"'
        $q = $q -replace '(\\+)$', '$1$1'
        '"' + $q + '"'
    }
    ($parts -join ' ')
}

# Runs a program, captures stdout and stderr completely, never throws on a non-zero exit.
function Invoke-Native {
    param(
        [string]$File,
        [string[]]$ArgList = @(),
        [string]$Cwd,
        [int]$TimeoutSec = 600,
        [string]$StdIn,
        [hashtable]$Env
    )
    $resolved = $File
    if (-not [IO.Path]::IsPathRooted($File)) {
        $cmd = Get-Command $File -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $cmd) { return [pscustomobject]@{ ExitCode = 9009; StdOut = ''; StdErr = "not found: $File"; Ms = 0; TimedOut = $false; Started = $false } }
        $resolved = $cmd.Source
        if (-not $resolved) { $resolved = $cmd.Path }
    }
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $resolved
    $psi.Arguments = Join-ArgString $ArgList
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.RedirectStandardInput = ($null -ne $StdIn -and $StdIn -ne '')
    $psi.CreateNoWindow = $true
    $psi.StandardOutputEncoding = [Text.Encoding]::UTF8
    $psi.StandardErrorEncoding = [Text.Encoding]::UTF8
    if ($Cwd) { $psi.WorkingDirectory = $Cwd }
    if ($Env) { foreach ($k in $Env.Keys) { if ($null -eq $Env[$k]) { [void]$psi.EnvironmentVariables.Remove($k) } else { $psi.EnvironmentVariables[$k] = [string]$Env[$k] } } }
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $p = New-Object System.Diagnostics.Process
    $p.StartInfo = $psi
    try { [void]$p.Start() } catch {
        return [pscustomobject]@{ ExitCode = 9009; StdOut = ''; StdErr = $_.Exception.Message; Ms = 0; TimedOut = $false; Started = $false }
    }
    $outTask = $p.StandardOutput.ReadToEndAsync()
    $errTask = $p.StandardError.ReadToEndAsync()
    if ($psi.RedirectStandardInput) { $p.StandardInput.Write($StdIn); $p.StandardInput.Close() }
    $timedOut = $false
    if (-not $p.WaitForExit($TimeoutSec * 1000)) {
        $timedOut = $true
        try { $pStart = $null; try { $pStart = $p.StartTime } catch { }; [void](Stop-ProcessTree -ProcessId $p.Id -StartTime $pStart) } catch { }
    }
    $p.WaitForExit()
    $sw.Stop()
    [pscustomobject]@{ ExitCode = $p.ExitCode; StdOut = $outTask.Result; StdErr = $errTask.Result; Ms = [int]$sw.ElapsedMilliseconds; TimedOut = $timedOut; Started = $true }
}

# Kills exact pids, never through `taskkill /T`: its walk uses ParentProcessId alone, so a reused pid reaches csrss, winlogon and dwm of an old session.
# The tree comes from Get-ProcessTree (which compares creation times); children go first, each only while its start time still matches.
# Never throws: under $ErrorActionPreference = 'Stop', a failing kill must not abort stop.ps1 half way (VM 2026-10-28).
function Stop-ProcessTree {
    param([int]$ProcessId, $StartTime)
    # A pid without a start time is never killed: it may have been reused.
    $rootStart = $StartTime
    if ($null -eq $rootStart -or $rootStart -eq '') { return $false }
    # The root first: a pid that no longer holds the process recorded for it (reused) is not ours, and neither are its children (VM 2026-10-28: they were killed).
    if (-not (Test-ProcessAlive -ProcessId $ProcessId -StartTime $rootStart)) { return $false }
    $victims = @()
    try { $victims = @(Get-ProcessTree $ProcessId) } catch { }
    [array]::Reverse($victims)
    $victims += [pscustomobject]@{ Pid = $ProcessId; Created = $rootStart }
    $ok = $true
    foreach ($v in $victims) {
        if (-not (Test-ProcessAlive -ProcessId ([int]$v.Pid) -StartTime $v.Created)) { continue }
        try { Stop-Process -Id ([int]$v.Pid) -Force -ErrorAction Stop } catch { $ok = $false }
    }
    return $ok
}

# Filesystem trouble that Defender, long paths, or locked files cause during installs.
function Get-FsErrors {
    param([string]$Text)
    if (-not $Text) { return @() }
    $hits = @()
    foreach ($m in [regex]::Matches($Text, '(EPERM|ENAMETOOLONG|EBUSY|EACCES|EMFILE|ENOTEMPTY|ENOSPC)[^\r\n]{0,160}')) { $hits += $m.Value }
    foreach ($m in [regex]::Matches($Text, '[^\r\n]{0,80}(Access is denied|path is too long|being used by another process|virus|Operation did not complete successfully)[^\r\n]{0,80}')) { $hits += $m.Value }
    return @($hits | Select-Object -First 20)
}

function Get-Sha256 {
    param([string]$Path)
    (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Save-Download {
    param([string]$Url, [string]$Dest, [string]$Sha256)
    if (Test-Path -LiteralPath $Dest) {
        if ((Get-Sha256 $Dest) -eq $Sha256.ToLowerInvariant()) { return 'cached' }
        Remove-Item -LiteralPath $Dest -Force
    }
    $part = $Dest + '.part'
    if (Test-Path -LiteralPath $part) { Remove-Item -LiteralPath $part -Force }
    $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
    if ($curl) {
        $r = Invoke-Native -File $curl.Source -ArgList @('-fL', '--retry', '3', '--retry-delay', '2', '-sS', '-o', $part, $Url) -TimeoutSec 1800
        if ($r.ExitCode -ne 0) { throw "download failed ($($r.ExitCode)): $Url $($r.StdErr)" }
    } else {
        Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $part
    }
    $got = Get-Sha256 $part
    if ($got -ne $Sha256.ToLowerInvariant()) {
        Remove-Item -LiteralPath $part -Force
        throw "SHA256 mismatch for $Url`n  expected $Sha256`n  got      $got"
    }
    Move-Item -LiteralPath $part -Destination $Dest -Force
    return 'downloaded'
}

# Windows 11 ships bsdtar (tar.exe), which reads zip and is far faster than Expand-Archive on Windows PowerShell 5.1.
function Expand-Zip {
    param([string]$Zip, [string]$Dest)
    if (-not (Test-Path -LiteralPath $Dest)) { New-Item -ItemType Directory -Path $Dest -Force | Out-Null }
    $tar = Join-Path $env:SystemRoot 'System32\tar.exe'
    if (Test-Path -LiteralPath $tar) {
        $r = Invoke-Native -File $tar -ArgList @('-xf', $Zip, '-C', $Dest) -TimeoutSec 900
        if ($r.ExitCode -eq 0) { return 'tar.exe' }
    }
    Expand-Archive -LiteralPath $Zip -DestinationPath $Dest -Force
    return 'Expand-Archive'
}

function Get-ToolPaths {
    $node = Join-Path $Tools 'node'
    $git = Join-Path $Tools 'git'
    [pscustomobject]@{
        Node      = $node
        NodeExe   = Join-Path $node 'node.exe'
        NpmCmd    = Join-Path $node 'npm.cmd'
        Git       = $git
        GitExe    = Join-Path $git 'cmd\git.exe'
        BashExe   = Join-Path $git 'bin\bash.exe'
        Gcm       = Join-Path $git 'ucrt64\bin\git-credential-manager.exe'
        Herdr     = Join-Path $Tools 'herdr'
        HerdrExe  = Join-Path $Tools 'herdr\herdr.exe'
        Npm       = $NpmPrefix
        PiCmd     = Join-Path $NpmPrefix 'pi.cmd'
        TttCmd    = Join-Path $NpmPrefix 'ttt.cmd'
        PwCmd     = Join-Path $NpmPrefix 'playwriter.cmd'
        PiModules = Join-Path $NpmPrefix 'node_modules'
        AgentNm   = Join-Path $AgentDir 'npm\node_modules'
    }
}

# Puts the private tools first on PATH and points every tool's state at the private folders, for this process and its children only.
function Set-SbdEnv {
    $t = Get-ToolPaths
    $dirs = @($t.Node, $NpmPrefix, (Join-Path $t.Git 'cmd'), (Join-Path $t.Git 'bin'), $t.Herdr)
    $existing = @($dirs | Where-Object { Test-Path -LiteralPath $_ })
    $clean = @(($env:PATH -split ';') | Where-Object { $_ -and ($existing -notcontains $_) })
    $env:PATH = (($existing + $clean) -join ';')
    $env:PI_CODING_AGENT_DIR = $AgentDir
    $env:NPM_CONFIG_PREFIX = $NpmPrefix
    $env:NPM_CONFIG_CACHE = $NpmCache
    $env:NPM_CONFIG_UPDATE_NOTIFIER = 'false'
    $env:NPM_CONFIG_FUND = 'false'
    $env:NPM_CONFIG_AUDIT = 'false'
    # Desk mode and the primary slot: the same variables go to herdr, to every cli.mjs call, and (through herdr) to every pane's pi, so they all compute
    # the one slot (desk-b7 plan, task 1). Nothing here points at the user's own %APPDATA%\herdr.
    $env:STRAW_BOSS_DESK = '1'
    $env:XDG_CONFIG_HOME = $ConfigHome
    $env:HERDR_CONFIG_PATH = Join-Path $HerdrDir 'config.toml'
    $env:HERDR_SOCKET_PATH = Join-Path $HerdrDir 'herdr.sock'
    $env:HERDR_DISABLE_SOUND = '1'
    $env:CLAUDE_CONFIG_DIR = $ClaudeDir
    $env:GIT_CONFIG_GLOBAL = Join-Path $SbdRoot 'gitconfig'
    $env:GCM_INTERACTIVE = 'true'
    # A pi started from another pi session would make every pane's pi act as a subagent (pi-straw-boss AGENTS.md).
    foreach ($v in @('PI_SUBAGENT_ID', 'PI_INTERCOM_SESSION_ID', 'HERDR_ENV', 'HERDR_PANE_ID', 'HERDR_WORKSPACE_ID', 'HERDR_TAB_ID', 'HERDR_SESSION', 'STRAW_BOSS_ROLE')) {
        Remove-Item -Path ("Env:" + $v) -ErrorAction SilentlyContinue
    }
}

function Get-OsInfo {
    $os = Get-CimInstance Win32_OperatingSystem
    $isArm = ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') -or ($env:PROCESSOR_ARCHITEW6432 -eq 'ARM64')
    [ordered]@{
        caption = $os.Caption
        build = $os.BuildNumber
        osArchitecture = $os.OSArchitecture
        processorArchitecture = $env:PROCESSOR_ARCHITECTURE
        processorArchitectureW6432 = $env:PROCESSOR_ARCHITEW6432
        hostIsArm64 = $isArm
        psVersion = $PSVersionTable.PSVersion.ToString()
        user = $env:USERNAME
        userProfile = $env:USERPROFILE
        localAppData = $env:LOCALAPPDATA
        profileIsNonAscii = [bool]($env:USERPROFILE -match '[^\u0000-\u007f]')
        sbdRoot = $SbdRoot
    }
}

# ConvertFrom-Json turns ISO date strings into DateTime, so a recorded start time can arrive as either; both are compared as instants.
function ConvertTo-UtcInstant {
    param($Value)
    if ($null -eq $Value -or $Value -eq '') { return $null }
    if ($Value -is [datetime]) { return $Value.ToUniversalTime() }
    return [datetime]::Parse([string]$Value, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime()
}

# The start time of a process as UTC. Windows PowerShell 5.1 under a filtered token cannot read .StartTime of SYSTEM, other-user or elevated processes
# ("Access is denied"); Win32_Process.CreationDate needs no access right. $null when the process is gone or no start time can be read.
function Get-ProcessStartUtc {
    param([int]$ProcessId)
    $p = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if (-not $p) { return $null }
    $started = $null
    try { $started = $p.StartTime } catch { }
    if ($null -ne $started) { return $started.ToUniversalTime() }
    try {
        $w = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction Stop
        if ($w -and $w.CreationDate) { return $w.CreationDate.ToUniversalTime() }
    } catch { }
    return $null
}

# Alive; with -StartTime, alive AND started then. A process whose start time cannot be read at all is not ours: false (a process that exits during
# the read is gone, which is false as well).
function Test-ProcessAlive {
    param([int]$ProcessId, $StartTime)
    $p = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if (-not $p) { return $false }
    $want = ConvertTo-UtcInstant $StartTime
    if ($null -eq $want) { return $true }
    $started = Get-ProcessStartUtc $ProcessId
    if ($null -eq $started) { return $false }
    # Get-Process and CIM round differently; a reused pid starts at a very different time.
    return ([math]::Abs(($started - $want).TotalSeconds) -lt 3)
}

function Get-ProcessStartIso {
    param([int]$ProcessId)
    $u = Get-ProcessStartUtc $ProcessId
    if ($null -eq $u) { return $null }
    return $u.ToString('o')
}

# Descendants of a process, by parent id, with creation times so a reused pid is never mistaken for ours.
# A child that was created BEFORE its "parent" is not a child: Windows reuses pids, and csrss, winlogon, fontdrvhost and dwm of an old session still name
# the (long dead) session manager's pid as their parent (VM 2026-10-28: a herdr server got that pid, and stop.ps1 would have taskkill-ed them).
function Get-ProcessTree {
    param([int]$RootPid)
    $all = @(Get-CimInstance Win32_Process)
    $created = @{}
    foreach ($p in $all) { $created[[int]$p.ProcessId] = $p.CreationDate }
    $found = @()
    $queue = New-Object System.Collections.Queue
    $queue.Enqueue($RootPid)
    while ($queue.Count -gt 0) {
        $id = $queue.Dequeue()
        $parentCreated = $created[$id]
        foreach ($c in ($all | Where-Object { $_.ParentProcessId -eq $id })) {
            if ($null -eq $parentCreated -or $null -eq $c.CreationDate -or $c.CreationDate -lt $parentCreated) { continue }
            if ([int]$c.ProcessId -eq $id) { continue }
            $found += [pscustomobject]@{ Pid = [int]$c.ProcessId; Name = $c.Name; Created = $c.CreationDate.ToUniversalTime().ToString('o') }
            $queue.Enqueue([int]$c.ProcessId)
        }
    }
    return $found
}

function Read-JsonFile {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    try { Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json } catch { $null }
}

function Write-JsonFile {
    param([string]$Path, $Object, [int]$Depth = 8)
    Write-AllTextUtf8 -Path $Path -Text ($Object | ConvertTo-Json -Depth $Depth)
}

# A GUI URL carries the page's token, which is a credential: no log line, notice, or result file may hold it.
function Hide-Token {
    param([string]$Text)
    if (-not $Text) { return '' }
    return ($Text -replace '(?i)(127\.0\.0\.1:\d+/)[0-9a-f]{16,}', '$1<token>')
}

function Get-FirstLine {
    param([string]$Text)
    if (-not $Text) { return '' }
    ($Text -split "`r?`n" | Where-Object { $_.Trim() } | Select-Object -First 1)
}

# Reads a secret without echoing it; returns a plain string for the caller to place in a child's environment only.
function Read-HiddenText {
    param([string]$Prompt)
    $s = Read-Host -Prompt $Prompt -AsSecureString
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
    try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}

# Two-column evidence in a results file: PASS | FAIL | SKIP.
function New-Result {
    param([string]$Name, [string]$Status, [string]$Evidence, $Data)
    $o = [ordered]@{ name = $Name; status = $Status; evidence = $Evidence }
    if ($Data) { $o['data'] = $Data }
    [pscustomobject]$o
}

# ---- account checks: steps with PASS/FAIL/SKIP, whether they needed the person, and evidence; secrets never enter a step ----
$script:AcctName = ''
$script:AcctSteps = New-Object System.Collections.ArrayList
function Start-AccountCheck {
    param([string]$Name)
    $script:AcctName = $Name
    $script:LogFile = Join-Path $LogDir "$Name.jsonl"
    Set-SbdEnv
    Write-Host ''
    Write-Host "=== $Name ==="
}
function Add-Step {
    param([string]$Step, [string]$Status, [string]$Evidence, [bool]$Interactive = $false, [int]$Ms = 0)
    [void]$script:AcctSteps.Add([pscustomobject]@{ step = $Step; status = $Status; interactive = $Interactive; ms = $Ms; evidence = $Evidence })
    Write-Host ("{0,-4} {1,-28} {2}{3}" -f $Status, $Step, $Evidence, $(if ($Interactive) { '  [needed the person]' } else { '' }))
    Write-Log $script:AcctName $Step @{ status = $Status; interactive = $Interactive; ms = $Ms; evidence = $Evidence }
}
function Save-AccountResult {
    $file = Join-Path $ResultDir ("$($script:AcctName)-" + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.json')
    Write-JsonFile $file ([ordered]@{ check = $script:AcctName; at = (Get-Date).ToUniversalTime().ToString('o'); os = (Get-OsInfo); steps = $script:AcctSteps }) 8
    Write-JsonFile (Join-Path $ResultDir "$($script:AcctName)-latest.json") ([ordered]@{ check = $script:AcctName; steps = $script:AcctSteps }) 8
    Write-Host "results -> $file"
    if (@($script:AcctSteps | Where-Object { $_.status -eq 'FAIL' }).Count -gt 0) { exit 1 }
}
function Confirm-Prompt {
    param([string]$Text)
    $a = Read-Host -Prompt "$Text [y/N]"
    return ($a -match '^(y|yes)$')
}
