<#
.SYNOPSIS
  Account check, run interactively with the author present: Git Credential Manager browser login to github.com,
  then clone + push to a throwaway repository, then remove the stored credential.
.PARAMETER RepoUrl
  HTTPS URL of a throwaway repository on github.com the signed-in account can push to (a private empty repo is ideal).
.NOTES
  Pushes only a branch named spike-win-<timestamp> and deletes it again; main is never touched. No token is read or printed:
  Git Credential Manager does the OAuth round trip in the browser and keeps the result in Windows Credential Manager.
#>
param(
    [Parameter(Mandatory = $true)][string]$RepoUrl,
    [switch]$Cleanup,
    [switch]$CleanupOnly
)

. (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'lib.ps1')
Start-AccountCheck 'check-github'
$t = Get-ToolPaths
$dest = Join-Path $WorkDir 'github-check'
$branch = 'spike-win-' + (Get-Date -Format 'yyyyMMddHHmmss')
$u = [Uri]$RepoUrl
if ($u.Scheme -ne 'https' -or $u.Host -notlike '*github.com') { throw 'RepoUrl must be an https://github.com/... URL' }

function Remove-GitHubCredentials {
    $r = Invoke-Native -File $t.GitExe -ArgList @('credential', 'reject') -StdIn "protocol=https`nhost=github.com`n`n" -TimeoutSec 60
    Add-Step 'cleanup:credential-reject' $(if ($r.ExitCode -eq 0) { 'PASS' } else { 'FAIL' }) "git credential reject exit $($r.ExitCode)"
    $targets = @(& cmdkey.exe /list 2>$null | Where-Object { $_ -match 'Target:.*(git:https://github\.com|github\.com)' } | ForEach-Object { ($_ -replace '^\s*Target:\s*', '').Trim() })
    foreach ($tg in $targets) { & cmdkey.exe /delete:$tg 2>&1 | Out-Null }
    $left = @(& cmdkey.exe /list 2>$null | Where-Object { $_ -match 'github\.com' }).Count
    Add-Step 'cleanup:windows-credential-manager' $(if ($left -eq 0) { 'PASS' } else { 'FAIL' }) "github.com entries removed: $($targets.Count); left: $left"
    if (Test-Path -LiteralPath $dest) { Remove-Item -LiteralPath $dest -Recurse -Force -ErrorAction SilentlyContinue; Add-Step 'cleanup:clone-dir' $(if (Test-Path -LiteralPath $dest) { 'FAIL' } else { 'PASS' }) $dest }
}

if ($CleanupOnly) { Remove-GitHubCredentials; Save-AccountResult }

$helper = Get-FirstLine (Invoke-Native -File $t.GitExe -ArgList @('config', '--get-all', 'credential.helper')).StdOut
$gcmV = Invoke-Native -File $t.Gcm -ArgList @('--version') -TimeoutSec 60
Add-Step 'gcm-present' $(if ($gcmV.ExitCode -eq 0) { 'PASS' } else { 'FAIL' }) "credential.helper='$helper'; GCM $(Get-FirstLine $gcmV.StdOut) ($($t.Gcm))"

if (Test-Path -LiteralPath $dest) { Remove-Item -LiteralPath $dest -Recurse -Force }
Write-Host 'Next: git clone. Git Credential Manager opens a browser (or a device-code dialog); sign in to github.com and authorize.'
$sw = [Diagnostics.Stopwatch]::StartNew()
$p = Start-Process -FilePath $t.GitExe -ArgumentList @('clone', $RepoUrl, $dest) -NoNewWindow -PassThru -Wait
$cloned = ($p.ExitCode -eq 0 -and (Test-Path -LiteralPath (Join-Path $dest '.git')))
Add-Step 'login-and-clone' $(if ($cloned) { 'PASS' } else { 'FAIL' }) "git clone exit $($p.ExitCode) in $([int]($sw.ElapsedMilliseconds/1000)) s (includes the browser login)" $true ([int]$sw.ElapsedMilliseconds)

if ($cloned) {
    $stored = @(& cmdkey.exe /list 2>$null | Where-Object { $_ -match 'github\.com' } | ForEach-Object { ($_ -replace '^\s*Target:\s*', '').Trim() })
    Add-Step 'credential-stored' $(if ($stored.Count -gt 0) { 'PASS' } else { 'FAIL' }) "Windows Credential Manager targets (names only): $($stored -join '; ')"
    Set-Content -LiteralPath (Join-Path $dest 'spike-win.txt') -Value ("spike $branch " + (Get-Date).ToString('o')) -Encoding UTF8
    [void](Invoke-Native -File $t.GitExe -ArgList @('-C', $dest, 'checkout', '-q', '-b', $branch))
    [void](Invoke-Native -File $t.GitExe -ArgList @('-C', $dest, 'add', 'spike-win.txt'))
    $c = Invoke-Native -File $t.GitExe -ArgList @('-C', $dest, 'commit', '-q', '-m', 'chore: windows spike push test')
    Add-Step 'commit' $(if ($c.ExitCode -eq 0) { 'PASS' } else { 'FAIL' }) "exit $($c.ExitCode) $(Get-FirstLine $c.StdErr)"
    # A second operation must not prompt: the stored credential has to be served silently.
    $env:GIT_TERMINAL_PROMPT = '0'
    $env:GCM_INTERACTIVE = 'never'
    $push = Invoke-Native -File $t.GitExe -ArgList @('-C', $dest, 'push', 'origin', "HEAD:refs/heads/$branch") -TimeoutSec 180
    Add-Step 'push-silent' $(if ($push.ExitCode -eq 0) { 'PASS' } else { 'FAIL' }) ("exit $($push.ExitCode) (no prompt allowed) " + (Get-FirstLine $push.StdErr))
    $del = Invoke-Native -File $t.GitExe -ArgList @('-C', $dest, 'push', 'origin', '--delete', $branch) -TimeoutSec 180
    Add-Step 'delete-remote-branch' $(if ($del.ExitCode -eq 0) { 'PASS' } else { 'FAIL' }) "exit $($del.ExitCode) $(Get-FirstLine $del.StdErr)"
    $env:GCM_INTERACTIVE = 'true'
    Remove-Item Env:GIT_TERMINAL_PROMPT -ErrorAction SilentlyContinue
}

if ($Cleanup -or (Confirm-Prompt 'Remove the stored github.com credential and the clone now?')) { Remove-GitHubCredentials } else { Add-Step 'cleanup' 'SKIP' 'credential left in place on request; rerun with -CleanupOnly' }
Save-AccountResult
