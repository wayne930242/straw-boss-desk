<#
.SYNOPSIS
  Account check, run interactively with the author present: self-hosted GitLab host + personal access token typed into a hidden
  prompt, stored through the credential helper, then a clone of a repository URL, then removal of the stored credential.
.PARAMETER GitLabHost
  Host name only, for example gitlab.example.com.
.PARAMETER RepoUrl
  HTTPS clone URL of a repository on that host the token can read.
.PARAMETER UserName
  Username to store with the token (GitLab accepts any non-empty name with a PAT; default oauth2).
#>
param(
    [Parameter(Mandatory = $true)][string]$GitLabHost,
    [Parameter(Mandatory = $true)][string]$RepoUrl,
    [string]$UserName = 'oauth2',
    [switch]$Cleanup,
    [switch]$CleanupOnly
)

. (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'lib.ps1')
Start-AccountCheck 'check-gitlab'
$t = Get-ToolPaths
$dest = Join-Path $WorkDir 'gitlab-check'
$u = [Uri]$RepoUrl
if ($u.Scheme -ne 'https' -or $u.Host -ne $GitLabHost) { throw "RepoUrl must be an https URL on $GitLabHost" }

function Remove-GitLabCredentials {
    $r = Invoke-Native -File $t.GitExe -ArgList @('credential', 'reject') -StdIn "protocol=https`nhost=$GitLabHost`nusername=$UserName`n`n" -TimeoutSec 60
    Add-Step 'cleanup:credential-reject' $(if ($r.ExitCode -eq 0) { 'PASS' } else { 'FAIL' }) "git credential reject exit $($r.ExitCode)"
    $targets = @(& cmdkey.exe /list 2>$null | Where-Object { $_ -match [regex]::Escape($GitLabHost) } | ForEach-Object { ($_ -replace '^\s*Target:\s*', '').Trim() })
    foreach ($tg in $targets) { & cmdkey.exe /delete:$tg 2>&1 | Out-Null }
    $left = @(& cmdkey.exe /list 2>$null | Where-Object { $_ -match [regex]::Escape($GitLabHost) }).Count
    Add-Step 'cleanup:windows-credential-manager' $(if ($left -eq 0) { 'PASS' } else { 'FAIL' }) "$GitLabHost entries removed: $($targets.Count); left: $left"
    if (Test-Path -LiteralPath $dest) { Remove-Item -LiteralPath $dest -Recurse -Force -ErrorAction SilentlyContinue; Add-Step 'cleanup:clone-dir' $(if (Test-Path -LiteralPath $dest) { 'FAIL' } else { 'PASS' }) $dest }
}

if ($CleanupOnly) { Remove-GitLabCredentials; Save-AccountResult }

$helper = Get-FirstLine (Invoke-Native -File $t.GitExe -ArgList @('config', '--get-all', 'credential.helper')).StdOut
Add-Step 'credential-helper' $(if ($helper) { 'PASS' } else { 'FAIL' }) "credential.helper='$helper'"

$pat = Read-HiddenText "GitLab personal access token for $GitLabHost (hidden, not logged)"
if (-not $pat) { Add-Step 'store-token' 'FAIL' 'no token entered'; Save-AccountResult }
$sw = [Diagnostics.Stopwatch]::StartNew()
$cred = "protocol=https`nhost=$GitLabHost`nusername=$UserName`npassword=$pat`n`n"
$ap = Invoke-Native -File $t.GitExe -ArgList @('credential', 'approve') -StdIn $cred -TimeoutSec 60
$pat = $null
$cred = $null
Add-Step 'store-token' $(if ($ap.ExitCode -eq 0) { 'PASS' } else { 'FAIL' }) "git credential approve exit $($ap.ExitCode) via helper" $true ([int]$sw.ElapsedMilliseconds)

# Read it back the way git does, and report only the shape of the answer.
$env:GIT_TERMINAL_PROMPT = '0'
$env:GCM_INTERACTIVE = 'never'
$fill = Invoke-Native -File $t.GitExe -ArgList @('credential', 'fill') -StdIn "protocol=https`nhost=$GitLabHost`nusername=$UserName`n`n" -TimeoutSec 60
$shape = ($fill.StdOut -split "`r?`n" | Where-Object { $_ -match '=' } | ForEach-Object { $k, $v = $_ -split '=', 2; if ($k -eq 'password') { "password=<$($v.Length) chars>" } else { $k } }) -join ' '
Add-Step 'credential-fill' $(if ($fill.StdOut -match 'password=.+') { 'PASS' } else { 'FAIL' }) "helper answered without prompting: $shape"

if (Test-Path -LiteralPath $dest) { Remove-Item -LiteralPath $dest -Recurse -Force }
$cl = Invoke-Native -File $t.GitExe -ArgList @('clone', $RepoUrl, $dest) -TimeoutSec 600
$cloned = ($cl.ExitCode -eq 0 -and (Test-Path -LiteralPath (Join-Path $dest '.git')))
Add-Step 'clone-no-prompt' $(if ($cloned) { 'PASS' } else { 'FAIL' }) "git clone exit $($cl.ExitCode) $(Get-FirstLine $cl.StdErr)" $false $cl.Ms
$env:GCM_INTERACTIVE = 'true'
Remove-Item Env:GIT_TERMINAL_PROMPT -ErrorAction SilentlyContinue

if ($Cleanup -or (Confirm-Prompt "Remove the stored $GitLabHost credential and the clone now?")) { Remove-GitLabCredentials } else { Add-Step 'cleanup' 'SKIP' 'credential left in place on request; rerun with -CleanupOnly' }
Save-AccountResult
