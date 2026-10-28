<#
.SYNOPSIS
  Account check, run interactively with the author present, in a window on the interactive desktop (the login opens a browser).
  claude auth login (SDK-bundled binary) -> one real model turn through pi + pi-claude-bridge -> one pi-herdr-agents subagent dispatch.
.DESCRIPTION
  Credentials live only in CLAUDE_CONFIG_DIR (%LOCALAPPDATA%\straw-boss-desk\claude); nothing is echoed or logged beyond status fields.
  Cleanup section: -Cleanup (or answer y at the end) runs `claude auth logout` and deletes that folder's contents.
.PARAMETER ClaudeExe
  Use this executable (for example a standalone install) instead of the one bundled by the Agent SDK.
#>
param(
    [string]$ClaudeExe,
    [int]$LoginTimeoutSec = 600,
    [int]$TurnTimeoutSec = 300,
    [int]$SubagentTimeoutSec = 360,
    [switch]$SkipLogin,
    [switch]$Cleanup,
    [switch]$CleanupOnly
)

. (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'lib.ps1')
Start-AccountCheck 'check-claude'
$t = Get-ToolPaths
$libDir = Join-Path $KitDir 'lib'
$guiJson = Join-Path $AgentDir 'straw-boss\gui.json'

function Remove-ClaudeCredentials {
    if ($ClaudeExe -and (Test-Path -LiteralPath $ClaudeExe)) {
        $r = Invoke-Native -File $ClaudeExe -ArgList @('auth', 'logout') -TimeoutSec 60
        Add-Step 'cleanup:auth-logout' $(if ($r.ExitCode -eq 0) { 'PASS' } else { 'FAIL' }) "exit $($r.ExitCode)"
    }
    if (Test-Path -LiteralPath $ClaudeDir) {
        Get-ChildItem -LiteralPath $ClaudeDir -Force -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
        $left = @(Get-ChildItem -LiteralPath $ClaudeDir -Force -ErrorAction SilentlyContinue).Count
        Add-Step 'cleanup:config-dir' $(if ($left -eq 0) { 'PASS' } else { 'FAIL' }) "$ClaudeDir entries left: $left"
    }
}

# 1. the executable
if (-not $ClaudeExe) {
    $bridge = Join-Path $t.AgentNm 'pi-claude-bridge'
    $r = Invoke-Native -File $t.NodeExe -ArgList @((Join-Path $libDir 'sdk-exe.mjs'), $bridge) -TimeoutSec 180
    $j = $null
    try { $j = ($r.StdOut -split "`r?`n" | Where-Object { $_.StartsWith('{') } | Select-Object -Last 1) | ConvertFrom-Json } catch { }
    $ran = @()
    if ($j) { $ran = @($j.executables | Where-Object { $_.status -eq 0 }) }
    if ($ran.Count -gt 0) {
        $ClaudeExe = $ran[0].exe
        Add-Step 'locate-claude' 'PASS' "SDK-bundled $($ran[0].name): $($ran[0].out) at $ClaudeExe"
    } else {
        Add-Step 'locate-claude' 'FAIL' 'no runnable claude.exe in the Agent SDK platform packages; pass -ClaudeExe with a standalone install'
        Save-AccountResult
    }
}

if ($CleanupOnly) { Remove-ClaudeCredentials; Save-AccountResult }

# 2. login
if (-not $SkipLogin) {
    $before = Invoke-Native -File $ClaudeExe -ArgList @('auth', 'status', '--json') -TimeoutSec 60
    Add-Step 'auth-status-before' 'PASS' ("exit $($before.ExitCode): " + (Get-FirstLine $before.StdOut))
    Write-Host ''
    Write-Host 'Next: claude auth login. A browser opens; sign in with the Claude subscription account and approve.'
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $p = Start-Process -FilePath $ClaudeExe -ArgumentList @('auth', 'login') -NoNewWindow -PassThru
    if (-not $p.WaitForExit($LoginTimeoutSec * 1000)) { [void](Stop-ProcessTree -ProcessId $p.Id); Add-Step 'auth-login' 'FAIL' "timed out after $LoginTimeoutSec s" $true ([int]$sw.ElapsedMilliseconds) }
    else { Add-Step 'auth-login' $(if ($p.ExitCode -eq 0) { 'PASS' } else { 'FAIL' }) "exit $($p.ExitCode), browser OAuth round trip $([int]($sw.ElapsedMilliseconds/1000)) s" $true ([int]$sw.ElapsedMilliseconds) }
}
$after = Invoke-Native -File $ClaudeExe -ArgList @('auth', 'status', '--json') -TimeoutSec 60
$loggedIn = $false
$fields = ''
try {
    $o = $after.StdOut | ConvertFrom-Json
    $loggedIn = [bool]$o.loggedIn
    $fields = (@('loggedIn', 'authMethod', 'apiProvider', 'subscriptionType') | ForEach-Object { if ($o.PSObject.Properties.Name -contains $_) { "$_=$($o.$_)" } }) -join ' '
} catch { $fields = 'status not JSON: ' + (Get-FirstLine $after.StdOut) }
Add-Step 'auth-status-after' $(if ($loggedIn) { 'PASS' } else { 'FAIL' }) $fields
$tokenFiles = @(Get-ChildItem -LiteralPath $ClaudeDir -Recurse -File -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name)
Add-Step 'credential-storage' 'PASS' "CLAUDE_CONFIG_DIR=$ClaudeDir files: $($tokenFiles -join ', ')  (Windows Credential Manager is not used by this binary if a .credentials.json is listed)"

if ($loggedIn) {
    # 3. one real model turn through pi + pi-claude-bridge
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $r = Invoke-Native -File $t.PiCmd -ArgList @('-p', '--no-session', '--model', 'claude-bridge/claude-sonnet-5-5', 'Reply with the two words ALPHA and 7731 joined by a hyphen, and nothing else.') -Cwd $WorkDir -TimeoutSec $TurnTimeoutSec
    $answer = (Get-FirstLine $r.StdOut)
    $okTurn = ($r.ExitCode -eq 0 -and $r.StdOut -match 'ALPHA-7731')
    Add-Step 'pi-model-turn' $(if ($okTurn) { 'PASS' } else { 'FAIL' }) ("exit $($r.ExitCode) in $($r.Ms) ms; answer='$answer'; stderr=" + (Get-FirstLine $r.StdErr)) $false ([int]$sw.ElapsedMilliseconds)

    # 4. one pi-herdr-agents subagent dispatch, from a member (a tower may not dispatch)
    $ps = (Get-Command powershell.exe).Source
    $startState = Read-JsonFile (Join-Path $StateDir 'start.json')
    if (-not $startState -or -not $startState.sbDir) {
        $sr = Invoke-Native -File $ps -ArgList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $KitDir 'start.ps1')) -TimeoutSec 400
        Add-Step 'start-stack' $(if ($sr.ExitCode -eq 0) { 'PASS' } else { 'FAIL' }) (Get-FirstLine ($sr.StdOut + $sr.StdErr))
    }
    if (Test-Path -LiteralPath $guiJson) {
        $dir = Join-Path $WorkDir 'claude-check'
        if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
        $prompt = 'Dispatch exactly one subagent with the scout agent and the task: "Reply with the two words BRAVO and 4242 joined by a hyphen, nothing else." Then tell me what it answered.'
        $arg = (@{ dir = $dir; label = 'claude-check'; prompt = $prompt } | ConvertTo-Json -Compress)
        $o = Invoke-Native -File $t.NodeExe -ArgList @((Join-Path $libDir 'gui-client.mjs'), $guiJson, 'open-base', $arg) -TimeoutSec 180
        $ob = $null
        try { $ob = ($o.StdOut -split "`r?`n" | Where-Object { $_.StartsWith('{') } | Select-Object -Last 1) | ConvertFrom-Json } catch { }
        if (-not $ob -or $ob.status -ne 200) {
            Add-Step 'subagent-dispatch' 'FAIL' ("open/base: " + (Get-FirstLine $o.StdOut)) $false
        } else {
            $pane = $ob.body.pane
            $sw = [Diagnostics.Stopwatch]::StartNew()
            $maxPi = 0
            $seen = $false
            $screen = ''
            while ($sw.Elapsed.TotalSeconds -lt $SubagentTimeoutSec -and -not $seen) {
                Start-Sleep -Seconds 4
                $l = Invoke-Native -File $t.HerdrExe -ArgList @('pane', 'list') -TimeoutSec 30
                try { $n = @((($l.StdOut | ConvertFrom-Json).result.panes) | Where-Object { $_.agent -eq 'pi' }).Count; if ($n -gt $maxPi) { $maxPi = $n } } catch { }
                $rd = Invoke-Native -File $t.HerdrExe -ArgList @('pane', 'read', $pane, '--source', 'recent', '--lines', '120') -TimeoutSec 30
                $screen = $rd.StdOut
                if ($screen -match 'BRAVO-4242') { $seen = $true }
            }
            $ok = $seen -and $maxPi -ge 3
            Add-Step 'subagent-dispatch' $(if ($ok) { 'PASS' } else { 'FAIL' }) "member pane $pane; answer seen=$seen; max pi panes seen=$maxPi (tower + member + subagent = 3) after $([int]$sw.Elapsed.TotalSeconds) s" $false ([int]$sw.ElapsedMilliseconds)
        }
    } else {
        Add-Step 'subagent-dispatch' 'SKIP' 'gui.json missing: the stack is not running'
    }
} else {
    Add-Step 'pi-model-turn' 'SKIP' 'not logged in'
    Add-Step 'subagent-dispatch' 'SKIP' 'not logged in'
}

# 5. cleanup
if ($Cleanup -or (Confirm-Prompt 'Log out of Claude and delete the credentials folder now?')) { Remove-ClaudeCredentials } else { Add-Step 'cleanup' 'SKIP' 'left logged in on request; rerun with -CleanupOnly' }
Save-AccountResult
