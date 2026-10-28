<#
.SYNOPSIS
  Account check, run interactively with the author present: Linear API key from a hidden prompt into this process's environment only,
  `ttt init` without prompts if possible, then sync and show. Records which steps needed the person.
.PARAMETER LinearUser
  Email of the Linear user (ttt init --user).
.PARAMETER Team
  Linear team name (ttt init --team); optional.
.PARAMETER IssueId
  An issue id to show (for example MP-123); optional. Without it `ttt show` lists the synced issues.
#>
param(
    [string]$LinearUser,
    [string]$Team,
    [string]$IssueId,
    [switch]$Cleanup,
    [switch]$CleanupOnly
)

. (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'lib.ps1')
Start-AccountCheck 'check-ttt'
$t = Get-ToolPaths
$dir = Join-Path $WorkDir 'ttt-check'

function Remove-TttState {
    Remove-Item Env:LINEAR_API_KEY -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $dir) { Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue }
    Add-Step 'cleanup:scratch-and-env' $(if (Test-Path -LiteralPath $dir) { 'FAIL' } else { 'PASS' }) "removed $dir; LINEAR_API_KEY unset in this process (it was never written to a profile or the registry)"
}
if ($CleanupOnly) { Remove-TttState; Save-AccountResult }

$key = Read-HiddenText 'Linear API key (hidden, kept in this process environment only)'
if (-not $key) { Add-Step 'api-key' 'FAIL' 'no key entered'; Save-AccountResult }
$env:LINEAR_API_KEY = $key
if (Test-Path -LiteralPath $dir) { Remove-Item -LiteralPath $dir -Recurse -Force }
New-Item -ItemType Directory -Path $dir -Force | Out-Null

# 1. non-interactive init: stdin is closed and a prompt would hang, so the timeout is the signal.
$initArgs = @('init', '-y')
if ($LinearUser) { $initArgs += @('-u', $LinearUser) }
if ($Team) { $initArgs += @('-t', $Team) }
$i = Invoke-Native -File $t.TttCmd -ArgList $initArgs -Cwd $dir -TimeoutSec 120
$files = @(Get-ChildItem -LiteralPath $dir -Recurse -File -Force -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName.Substring($dir.Length + 1) })
$initOk = ($i.ExitCode -eq 0 -and $files.Count -gt 0 -and -not $i.TimedOut)
Add-Step 'init-non-interactive' $(if ($initOk) { 'PASS' } else { 'FAIL' }) ("exit $($i.ExitCode) timedOut=$($i.TimedOut); files: $($files -join ', '); out=" + (Get-FirstLine ($i.StdOut + $i.StdErr))) $false $i.Ms

if (-not $initOk) {
    Write-Host 'Non-interactive init did not complete. Falling back to the interactive wizard; answer its questions.'
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $p = Start-Process -FilePath $t.TttCmd -ArgumentList @('init', '-f') -WorkingDirectory $dir -NoNewWindow -PassThru
    if (-not $p.WaitForExit(600000)) { [void](Stop-ProcessTree -ProcessId $p.Id -StartTime $p.StartTime) }
    $files = @(Get-ChildItem -LiteralPath $dir -Recurse -File -Force -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName.Substring($dir.Length + 1) })
    Add-Step 'init-interactive' $(if ($p.HasExited -and $p.ExitCode -eq 0 -and $files.Count -gt 0) { 'PASS' } else { 'FAIL' }) "files: $($files -join ', ')" $true ([int]$sw.ElapsedMilliseconds)
}

# Does the key end up on disk?
$persisted = @()
foreach ($f in (Get-ChildItem -LiteralPath $dir -Recurse -File -Force -ErrorAction SilentlyContinue)) {
    $text = Get-Content -LiteralPath $f.FullName -Raw -ErrorAction SilentlyContinue
    if ($text -and $text.Contains($key)) { $persisted += $f.Name }
}
Add-Step 'key-persisted-on-disk' 'PASS' $(if ($persisted.Count) { "yes, in: $($persisted -join ', ') (file stays in the scratch folder, deleted by cleanup)" } else { 'no, the key is only in the environment' })
$key = $null

# 2. sync + show
$s = Invoke-Native -File $t.TttCmd -ArgList @('sync') -Cwd $dir -TimeoutSec 180
Add-Step 'sync' $(if ($s.ExitCode -eq 0) { 'PASS' } else { 'FAIL' }) ("exit $($s.ExitCode): " + (Get-FirstLine ($s.StdOut + $s.StdErr))) $false $s.Ms
$showArgs = @('show')
if ($IssueId) { $showArgs += @($IssueId, '--remote') }
$sh = Invoke-Native -File $t.TttCmd -ArgList $showArgs -Cwd $dir -TimeoutSec 120
Add-Step 'show' $(if ($sh.ExitCode -eq 0) { 'PASS' } else { 'FAIL' }) ("exit $($sh.ExitCode): " + (Get-FirstLine ($sh.StdOut + $sh.StdErr))) $false $sh.Ms

if ($Cleanup -or (Confirm-Prompt 'Delete the scratch ttt folder and unset the key now?')) { Remove-TttState } else { Add-Step 'cleanup' 'SKIP' 'left in place on request; rerun with -CleanupOnly' }
Save-AccountResult
