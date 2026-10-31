<#
.SYNOPSIS
  What the code-host CLI stages need proved on Windows (team profile spec, section 8, "CLI install"): SHA256 verification of a download, the pinned archives'
  hashes, and the launcher / credential helper tests of test\forge-cli.test.mjs run with Windows' cmd.exe and Git's own sh.exe.
.DESCRIPTION
  Needs no network and no login: the download test uses a file:// URL with curl.exe. Run it after bootstrap.ps1 -Forges ... (the node tests need the kit's Node).
  PASS/FAIL lines; exit 1 if any FAIL.
#>
. (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'lib.ps1')
Start-AccountCheck 'forge-cli-check'
$t = Get-ToolPaths
$pins = Get-Pins

# ---- SHA256 verification (Save-Download) ----
$work = Join-Path $Tools ('forge-check-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work -Force | Out-Null
try {
    $src = Join-Path $work 'source.bin'
    [IO.File]::WriteAllBytes($src, [Text.Encoding]::ASCII.GetBytes('pretend this is gh_x_windows_amd64.zip'))
    $good = Get-Sha256 $src
    $url = 'file:///' + ($src -replace '\\', '/')
    $dest = Join-Path $work 'archive.zip'

    $threw = $null
    try { [void](Save-Download -Url $url -Dest $dest -Sha256 ('0' * 64)) } catch { $threw = $_.Exception.Message }
    $ok = ($threw -and $threw -match 'SHA256 mismatch' -and -not (Test-Path -LiteralPath $dest) -and -not (Test-Path -LiteralPath ($dest + '.part')))
    Add-Step 'sha256:wrong-pin-refused' $(if ($ok) { 'PASS' } else { 'FAIL' }) "a download whose hash is not the pin throws and leaves no file (message starts: $(Get-FirstLine $threw))"

    $how = Save-Download -Url $url -Dest $dest -Sha256 $good
    Add-Step 'sha256:right-pin-accepted' $(if ($how -eq 'downloaded' -and (Get-Sha256 $dest) -eq $good) { 'PASS' } else { 'FAIL' }) "Save-Download -> $how"

    Add-Content -LiteralPath $dest -Value 'tampered' -Encoding ASCII
    $how2 = Save-Download -Url $url -Dest $dest -Sha256 $good
    Add-Step 'sha256:cached-file-tampered' $(if ($how2 -eq 'downloaded' -and (Get-Sha256 $dest) -eq $good) { 'PASS' } else { 'FAIL' }) "a cached archive that no longer matches the pin is fetched again (-> $how2), not trusted"

    $threw2 = $null
    [IO.File]::WriteAllBytes($src, [Text.Encoding]::ASCII.GetBytes('the server now serves something else'))
    Remove-Item -LiteralPath $dest -Force
    try { [void](Save-Download -Url $url -Dest $dest -Sha256 $good) } catch { $threw2 = $_.Exception.Message }
    Add-Step 'sha256:server-changed' $(if ($threw2 -and $threw2 -match 'SHA256 mismatch' -and -not (Test-Path -LiteralPath $dest)) { 'PASS' } else { 'FAIL' }) 'a changed upstream file is refused before anything is extracted'
} finally {
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}

# ---- the pinned archives, if they are in the download cache ----
foreach ($cli in @('gh', 'glab')) {
    foreach ($arch in @('x64', 'arm64')) {
        $pin = $pins.binaries.$cli.$arch
        $f = Join-Path $DlDir $pin.file
        if (Test-Path -LiteralPath $f) {
            $got = Get-Sha256 $f
            Add-Step "pinned-archive:$cli-$arch" $(if ($got -eq $pin.sha256) { 'PASS' } else { 'FAIL' }) "$($pin.file) sha256 $got $(if ($got -eq $pin.sha256) { '= pin' } else { '!= pin ' + $pin.sha256 })"
        }
    }
}

# ---- the launcher and credential helper tests, on Windows ----
$test = Join-Path $KitDir 'test\forge-cli.test.mjs'
$sh = Join-Path $t.Git 'usr\bin\sh.exe'
if ((Test-Path -LiteralPath $test) -and (Test-Path -LiteralPath $t.NodeExe) -and (Test-Path -LiteralPath $sh)) {
    $r = Invoke-Native -File $t.NodeExe -ArgList @('--test', $test) -Env @{ SBD_SH = $sh } -TimeoutSec 600
    $all = $r.StdOut + "`n" + $r.StdErr
    $pass = if ($all -match '(?m)^# pass (\d+)') { $Matches[1] } elseif ($all -match 'pass (\d+)') { $Matches[1] } else { '?' }
    $fail = if ($all -match '(?m)^# fail (\d+)') { $Matches[1] } elseif ($all -match 'fail (\d+)') { $Matches[1] } else { '?' }
    $skip = if ($all -match '(?m)^# skipped (\d+)') { $Matches[1] } elseif ($all -match 'skipped (\d+)') { $Matches[1] } else { '?' }
    Add-Step 'node-tests' $(if ($r.ExitCode -eq 0 -and $fail -eq '0') { 'PASS' } else { 'FAIL' }) "node --test forge-cli.test.mjs with cmd.exe and $sh: pass $pass, fail $fail, skipped $skip (exit $($r.ExitCode))"
    if ($r.ExitCode -ne 0) { Set-Content -LiteralPath (Join-Path $LogDir 'forge-cli-test.txt') -Value $all -Encoding UTF8; Write-Host "node test output -> $(Join-Path $LogDir 'forge-cli-test.txt')" }
} else {
    Add-Step 'node-tests' 'SKIP' "needs $test, the kit's Node, and Git's sh.exe"
}
Save-AccountResult
