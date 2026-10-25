<#
.SYNOPSIS
  Builds the straw-boss-desk tool stack for the current user, without admin rights.
.DESCRIPTION
  Everything lands under %LOCALAPPDATA%\straw-boss-desk (tools\, agent\, herdr\, claude\, logs\). Each stage is detect / install / verify,
  timed, and logged as JSON lines to logs\bootstrap.jsonl. Re-running skips stages whose detect step still verifies.
  Binary downloads are pinned by version and SHA256 (pins.json); npm packages by version and registry integrity.
.PARAMETER Arch
  x64 (default; PMs use x64 laptops, so this exercises Windows-on-ARM x64 emulation in the VM) or arm64 (Node and Git only; herdr has no arm64 build).
.PARAMETER Only
  Run only these stages: node, git, herdr, pi, ttt, playwriter, profile, packages.
.PARAMETER Force
  Ignore detect and reinstall.
#>
param(
    [ValidateSet('x64', 'arm64')][string]$Arch = 'x64',
    [string[]]$Only,
    [switch]$Force
)

. (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'lib.ps1')
$script:LogFile = Join-Path $LogDir 'bootstrap.jsonl'
$pins = Get-Pins
$t = Get-ToolPaths
$script:Summary = New-Object System.Collections.ArrayList
$script:StateFile = Join-Path $StateDir 'bootstrap-state.json'

Write-Log 'bootstrap' 'begin' @{ arch = $Arch; os = (Get-OsInfo); force = [bool]$Force; only = $Only }

function Invoke-Stage {
    param([string]$Name, [scriptblock]$Detect, [scriptblock]$Install, [scriptblock]$Verify)
    if ($Only -and ($Only -notcontains $Name)) { return }
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $row = [ordered]@{ stage = $Name; status = 'ok'; action = ''; ms = 0; evidence = ''; fsErrors = @() }
    try {
        $evidence = $null
        if (-not $Force) { try { $evidence = & $Detect } catch { $evidence = $null } }
        if ($evidence) {
            $row.action = 'skipped-verified'
            $row.evidence = [string]$evidence
            Write-Log $Name 'skipped' @{ detail = "already verified: $evidence" }
        } else {
            Write-Log $Name 'install-begin' @{}
            $install = & $Install
            if ($install -and $install.FsErrors) { $row.fsErrors = @($install.FsErrors) }
            $evidence = & $Verify
            if (-not $evidence) { throw 'verify returned nothing' }
            $row.action = 'installed'
            $row.evidence = [string]$evidence
        }
    } catch {
        $row.status = 'fail'
        $row.evidence = $_.Exception.Message
        Write-Log $Name 'fail' @{ detail = $_.Exception.Message }
    }
    $sw.Stop()
    $row.ms = [int]$sw.ElapsedMilliseconds
    Write-Log $Name $row.status @{ ms = $row.ms; action = $row.action; evidence = $row.evidence; fsErrors = $row.fsErrors }
    [void]$script:Summary.Add([pscustomobject]$row)
    $state = Read-JsonFile $script:StateFile
    $map = [ordered]@{}
    if ($state) { foreach ($p in $state.PSObject.Properties) { $map[$p.Name] = $p.Value } }
    $map[$Name] = $row
    Write-JsonFile $script:StateFile $map
}

function Get-VersionLine {
    param([string]$Exe, [string[]]$ArgList = @('--version'))
    if (-not (Test-Path -LiteralPath $Exe)) { return $null }
    $r = Invoke-Native -File $Exe -ArgList $ArgList -TimeoutSec 60
    if ($r.ExitCode -ne 0) { return $null }
    return (Get-FirstLine ($r.StdOut + "`n" + $r.StdErr))
}

function Install-Archive {
    param($Pin)
    $dest = Join-Path $DlDir $Pin.file
    $how = Save-Download -Url $Pin.url -Dest $dest -Sha256 $Pin.sha256
    Write-Log 'download' $how @{ file = $Pin.file; sha256 = $Pin.sha256 }
    return $dest
}

function Assert-NpmIntegrity {
    param([string]$Name, [string]$Version, [string]$Integrity)
    $r = Invoke-Native -File $t.NpmCmd -ArgList @('view', "$Name@$Version", 'dist.integrity') -TimeoutSec 120
    $got = (Get-FirstLine $r.StdOut).Trim()
    if ($r.ExitCode -ne 0 -or $got -ne $Integrity) { throw "registry integrity mismatch for $Name@$Version`n  pinned $Integrity`n  registry $got $($r.StdErr)" }
}

function Install-NpmGlobal {
    param($Pkg)
    Assert-NpmIntegrity $Pkg.name $Pkg.version $Pkg.integrity
    $r = Invoke-Native -File $t.NpmCmd -ArgList @('install', '-g', '--prefix', $NpmPrefix, "$($Pkg.name)@$($Pkg.version)") -TimeoutSec 1800
    $fs = Get-FsErrors ($r.StdOut + "`n" + $r.StdErr)
    Set-Content -LiteralPath (Join-Path $LogDir ("npm-" + ($Pkg.name -replace '[^A-Za-z0-9]', '_') + '.log')) -Value ($r.StdOut + "`n--- stderr ---`n" + $r.StdErr) -Encoding UTF8
    if ($r.ExitCode -ne 0) { throw "npm install -g $($Pkg.name)@$($Pkg.version) exit $($r.ExitCode): $(Get-FirstLine $r.StdErr) $($fs -join ' | ')" }
    [pscustomobject]@{ FsErrors = $fs }
}

function Get-InstalledVersion {
    param([string]$ModulesDir, [string]$Name)
    $pj = Join-Path $ModulesDir (Join-Path ($Name -replace '/', '\') 'package.json')
    $o = Read-JsonFile $pj
    if ($o) { return $o.version }
    return $null
}

# ---- node ----
$nodePin = $pins.binaries.node.$Arch
Invoke-Stage 'node' {
    $v = Get-VersionLine $t.NodeExe
    if ($v -eq "v$($pins.binaries.node.version)") { return "$v $(Get-VersionLine $t.NodeExe @('-p', 'process.arch'))" }
} {
    $zip = Install-Archive $nodePin
    $tmp = Join-Path $Tools 'node-extract'
    if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Recurse -Force }
    if (Test-Path -LiteralPath $t.Node) { Remove-Item -LiteralPath $t.Node -Recurse -Force }
    $how = Expand-Zip $zip $tmp
    $inner = Get-ChildItem -LiteralPath $tmp -Directory | Select-Object -First 1
    if (-not $inner) { throw 'node zip had no top folder' }
    Move-Item -LiteralPath $inner.FullName -Destination $t.Node
    Remove-Item -LiteralPath $tmp -Recurse -Force
    Write-Log 'node' 'extracted' @{ detail = $how }
    Set-SbdEnv
} {
    Set-SbdEnv
    $v = Get-VersionLine $t.NodeExe
    if ($v -ne "v$($pins.binaries.node.version)") { throw "node version $v" }
    $a = Get-VersionLine $t.NodeExe @('-p', 'process.arch')
    $n = Get-VersionLine $t.NpmCmd
    "$v arch=$a npm=$n"
}
Set-SbdEnv

# ---- git (PortableGit) ----
$gitPin = $pins.binaries.git.$Arch
Invoke-Stage 'git' {
    $v = Get-VersionLine $t.GitExe
    if ($v -and ($v -match [regex]::Escape($pins.binaries.git.version.Substring(0, 6))) -and (Test-Path -LiteralPath $t.BashExe)) { return "$v bash=$($t.BashExe) gcm=$(Test-Path -LiteralPath $t.Gcm)" }
} {
    $sfx = Install-Archive $gitPin
    if (Test-Path -LiteralPath $t.Git) { Remove-Item -LiteralPath $t.Git -Recurse -Force }
    $r = Invoke-Native -File $sfx -ArgList @("-o$($t.Git)", '-y') -TimeoutSec 900
    if ($r.ExitCode -ne 0) { throw "PortableGit extraction exit $($r.ExitCode): $($r.StdErr)" }
    Set-SbdEnv
} {
    Set-SbdEnv
    $v = Get-VersionLine $t.GitExe
    if (-not $v) { throw 'git --version failed' }
    if (-not (Test-Path -LiteralPath $t.BashExe)) { throw 'bash.exe missing from PortableGit' }
    # Private git config: never the user's own. Credential Manager is wired here so check-github / check-gitlab can use it.
    [void](Invoke-Native -File $t.GitExe -ArgList @('config', '--global', 'user.name', 'Spike PM'))
    [void](Invoke-Native -File $t.GitExe -ArgList @('config', '--global', 'user.email', 'spike@example.invalid'))
    [void](Invoke-Native -File $t.GitExe -ArgList @('config', '--global', 'core.longpaths', 'true'))
    [void](Invoke-Native -File $t.GitExe -ArgList @('config', '--global', 'init.defaultBranch', 'main'))
    $gcm = Test-Path -LiteralPath $t.Gcm
    if ($gcm) { [void](Invoke-Native -File $t.GitExe -ArgList @('config', '--global', 'credential.helper', 'manager')) }
    $sysHelper = (Get-FirstLine (Invoke-Native -File $t.GitExe -ArgList @('config', '--system', '--get-all', 'credential.helper')).StdOut)
    $bashV = Get-VersionLine $t.BashExe
    "$v; bash=$bashV; GitCredentialManagerIncluded=$gcm; system credential.helper='$sysHelper'; GIT_CONFIG_GLOBAL=$($env:GIT_CONFIG_GLOBAL)"
}

# ---- herdr ----
$herdrPin = $pins.binaries.herdr.$Arch
Invoke-Stage 'herdr' {
    $v = Get-VersionLine $t.HerdrExe
    if ($v -and $v -match [regex]::Escape($pins.binaries.herdr.version)) { return $v }
} {
    $zip = Install-Archive $herdrPin
    if (Test-Path -LiteralPath $t.Herdr) { Remove-Item -LiteralPath $t.Herdr -Recurse -Force }
    [void](Expand-Zip $zip $t.Herdr)
    if ($Arch -eq 'arm64') { Write-Log 'herdr' 'note' @{ detail = 'no arm64 build exists; the x86_64 build runs under emulation' } }
} {
    $v = Get-VersionLine $t.HerdrExe
    if (-not $v -or $v -notmatch [regex]::Escape($pins.binaries.herdr.version)) { throw "herdr version '$v'" }
    if (-not (Test-Path -LiteralPath (Join-Path $t.Herdr 'conpty\conpty.dll'))) { throw 'app-local ConPTY runtime missing next to herdr.exe' }
    $v
}

# ---- npm globals: pi, ttt, playwriter ----
foreach ($pkg in $pins.npmGlobal) {
    $pk = $pkg
    $stage = switch ($pk.bin) { 'pi' { 'pi' } 'ttt' { 'ttt' } default { 'playwriter' } }
    Invoke-Stage $stage {
        $v = Get-InstalledVersion $t.PiModules $pk.name
        if ($v -eq $pk.version -and (Test-Path -LiteralPath (Join-Path $NpmPrefix "$($pk.bin).cmd"))) { return "$($pk.name)@$v" }
    } {
        Install-NpmGlobal $pk
    } {
        $v = Get-InstalledVersion $t.PiModules $pk.name
        if ($v -ne $pk.version) { throw "installed version '$v'" }
        $cmd = Join-Path $NpmPrefix "$($pk.bin).cmd"
        if (-not (Test-Path -LiteralPath $cmd)) { throw "$cmd missing" }
        $out = Get-VersionLine $cmd @('--version')
        "$($pk.name)@$v ; $($pk.bin) --version -> $out"
    }
}

# ---- team profile: AGENTS.md, models, base settings ----
Invoke-Stage 'profile' {
    $a = Join-Path $AgentDir 'AGENTS.md'
    $m = Join-Path $AgentDir 'herdr-agents\config.json'
    $s = Join-Path $AgentDir 'settings.json'
    if ((Test-Path -LiteralPath $a) -and (Test-Path -LiteralPath $m) -and (Test-Path -LiteralPath $s)) { return 'AGENTS.md + herdr-agents/config.json + settings.json present' }
} {
    $agents = @'
# Team profile (spike)

- Answer in the language the user writes in. For Traditional Chinese users, use Traditional Chinese (Taiwan usage).
- The user may never have used a terminal. Explain what you are about to do in one plain sentence before running commands, and show results in plain words.
- Keep changes small and within what was asked. Ask before deleting files, rewriting history, or pushing to a shared branch.
- Never print or store secrets (tokens, passwords, API keys) in files, logs, or commit messages.
- Work in the folder the session was started in. Do not touch other folders on the machine.
- Commit messages follow Conventional Commits and contain no mention of AI tools.
'@
    Write-AllTextUtf8 (Join-Path $AgentDir 'AGENTS.md') ($agents -replace "`r?`n", "`n")
    $models = [ordered]@{
        status = [ordered]@{ enabled = $true }
        models = [ordered]@{
            default = 'claude-bridge/claude-sonnet-5-5'
            agents = [ordered]@{
                scout = 'claude-bridge/claude-sonnet-5-5'
                worker = 'claude-bridge/claude-sonnet-5-5'
                reviewer = 'claude-bridge/claude-opus-5-5'
                'adversarial-reviewer' = 'claude-bridge/claude-opus-5-5'
                'visual-tester' = 'claude-bridge/claude-sonnet-5-5'
                planner = 'claude-bridge/claude-opus-5-5'
            }
            tasks = [ordered]@{
                coding = @('claude-bridge/claude-sonnet-5-5')
                review = @('claude-bridge/claude-opus-5-5')
                recon = @('claude-bridge/claude-sonnet-5-5')
                docs = @('claude-bridge/claude-haiku-5-5')
                qa = @('claude-bridge/claude-sonnet-5-5')
                architecture = @('claude-bridge/claude-opus-5-5')
            }
        }
        persistent = [ordered]@{ maxAgents = 3 }
        supervision = [ordered]@{ forcePolling = $false; hangWarningMinutes = 15 }
        panes = [ordered]@{ mode = 'split'; direction = 'right'; maxPerTab = 4 }
    }
    Write-JsonFile (Join-Path $AgentDir 'herdr-agents\config.json') $models
    $settingsPath = Join-Path $AgentDir 'settings.json'
    if (-not (Test-Path -LiteralPath $settingsPath)) {
        $settings = [ordered]@{
            defaultProvider = 'claude-bridge'
            defaultModel = 'claude-sonnet-5-5'
            defaultThinkingLevel = 'medium'
            enabledModels = @('claude-bridge/claude-sonnet-5-5', 'claude-bridge/claude-opus-5-5', 'claude-bridge/claude-haiku-5-5')
            enableInstallTelemetry = $false
            collapseChangelog = $true
            quietStartup = 'header'
        }
        Write-JsonFile $settingsPath $settings
    }
} {
    $ok = @('AGENTS.md', 'herdr-agents\config.json', 'settings.json') | Where-Object { -not (Test-Path -LiteralPath (Join-Path $AgentDir $_)) }
    if ($ok) { throw "missing: $($ok -join ', ')" }
    "agent dir $AgentDir"
}

# ---- pi packages (team profile) ----
foreach ($pkg in $pins.piPackages) {
    $pk = $pkg
    $stage = 'pkg:' + $pk.name
    Invoke-Stage $stage {
        $v = Get-InstalledVersion $t.AgentNm $pk.name
        if ($v -eq $pk.version) {
            $cfg = Read-JsonFile (Join-Path $AgentDir 'settings.json')
            $listed = @($cfg.packages | Where-Object { ($_ -is [string] -and $_ -eq "npm:$($pk.name)@$($pk.version)") -or ($_.source -eq "npm:$($pk.name)@$($pk.version)") })
            if ($listed.Count -gt 0) { return "$($pk.name)@$v" }
        }
    } {
        Assert-NpmIntegrity $pk.name $pk.version $pk.integrity
        $r = Invoke-Native -File $t.PiCmd -ArgList @('install', "npm:$($pk.name)@$($pk.version)") -TimeoutSec 1800
        $fs = Get-FsErrors ($r.StdOut + "`n" + $r.StdErr)
        Set-Content -LiteralPath (Join-Path $LogDir ("pi-install-" + ($pk.name -replace '[^A-Za-z0-9]', '_') + '.log')) -Value ($r.StdOut + "`n--- stderr ---`n" + $r.StdErr) -Encoding UTF8
        if ($r.ExitCode -ne 0) { throw "pi install exit $($r.ExitCode): $(Get-FirstLine $r.StdErr) $(Get-FirstLine $r.StdOut) $($fs -join ' | ')" }
        [pscustomobject]@{ FsErrors = $fs }
    } {
        $v = Get-InstalledVersion $t.AgentNm $pk.name
        if ($v -ne $pk.version) { throw "installed version '$v' (expected $($pk.version)); looked in $($t.AgentNm)" }
        $gap = ''
        if ($pk.gap) { $gap = ' GAP: ' + $pk.gap }
        "$($pk.name)@$v$gap"
    }
}

# ---- summary ----
$failed = @($Summary | Where-Object { $_.status -ne 'ok' })
$piList = Invoke-Native -File $t.PiCmd -ArgList @('list') -TimeoutSec 120
Set-Content -LiteralPath (Join-Path $LogDir 'pi-list.txt') -Value $piList.StdOut -Encoding UTF8
Write-Log 'bootstrap' 'end' @{ ok = ($failed.Count -eq 0); stages = $Summary.Count; failed = @($failed | ForEach-Object { $_.stage }); totalMs = [int](($Summary | Measure-Object -Property ms -Sum).Sum) }
Write-JsonFile (Join-Path $ResultDir 'bootstrap-summary.json') $Summary
Write-Host ''
$Summary | Format-Table stage, status, action, ms -AutoSize | Out-String | Write-Host
if ($failed.Count -gt 0) { Write-Host "FAILED stages: $(($failed | ForEach-Object { $_.stage }) -join ', ')"; exit 1 }
Write-Host 'bootstrap OK'
