<#
.SYNOPSIS
  Account check for the code-host CLIs (docs/specs/2026-10-27-team-profile.md, sections 4 and 8): login through the launcher, then where the token went,
  then a push through the Git credential helper, then a search for the token in the kit's files.
.DESCRIPTION
  Run it in the VM user's interactive session (a scheduled task as that user, Interactive + Limited): Windows Credential Manager does not work from a
  key-auth ssh session. It never prints a token and never passes --insecure-storage. If the token landed in plain text it logs the CLI out and fails.
  Pushes only to a new branch chore/account-check-<timestamp> of the test repository; never to main.
.PARAMETER Cli
  gh or glab.
.PARAMETER RepoUrl
  The https URL of the test repository (default per CLI).
.PARAMETER Login
  gh: device login (`gh auth login --hostname github.com --git-protocol https --web`); the one-time code goes to -CodeFile as soon as gh prints it, then the
  script waits for the person to approve. glab: token login from -TokenFile (`glab auth login ... --stdin`); the file is deleted right after it is read.
.PARAMETER TokenFile
  glab: a file that holds the api-scope token. Deleted at once, even when the login fails.
.PARAMETER CodeFile
  gh: where the one-time code is written (the code is not a secret).
.PARAMETER Logout
  Only log the CLI out and check that nothing is left in its configuration folder.
.PARAMETER Search
  Only run the token search (the token is read from the CLI).
.PARAMETER SkipPush
  Do the login and the storage checks, but not the push.
.PARAMETER SkipSearch
  Leave out the final token search (it reads every file under the app data folder and takes minutes); run it alone later with -Search.
#>
param(
    [Parameter(Mandatory = $true)][ValidateSet('gh', 'glab')][string]$Cli,
    [string]$RepoUrl,
    [switch]$Login,
    [string]$TokenFile,
    [string]$CodeFile,
    [int]$LoginWaitMin = 14,
    [switch]$Logout,
    [switch]$Search,
    [switch]$SkipPush,
    [switch]$SkipSearch
)

. (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'lib.ps1')
Start-AccountCheck "account-check-$Cli"
$t = Get-ToolPaths
$pins = Get-Pins

if ($Cli -eq 'gh') {
    $forgeHost = 'github.com'
    $launcher = $t.GhCmd
    $version = $pins.binaries.gh.version
    $cfgDir = Join-Path $ConfigHome 'gh'
    if (-not $RepoUrl) { $RepoUrl = 'https://github.com/wayne930242/sbd-account-check' }
} else {
    $forgeHost = 'gitlab.moldplan.app'
    $launcher = $t.GlabCmd
    $version = $pins.binaries.glab.version
    $cfgDir = Join-Path $ConfigHome 'glab-cli'
    if (-not $RepoUrl) { $RepoUrl = 'https://gitlab.moldplan.app/weihung/sbd-account-check' }
}
$u = [Uri]$RepoUrl
if ($u.Scheme -ne 'https' -or $u.Host -ne $forgeHost) { throw "RepoUrl must be an https://$forgeHost/... URL" }

# Nothing a CLI prints about the login goes into a step unfiltered: a known secret is replaced, and anything shaped like a token is cut out.
$script:Secrets = New-Object System.Collections.ArrayList
function Hide-Secret {
    param([string]$Text)
    if (-not $Text) { return '' }
    foreach ($s in $script:Secrets) { if ($s -and $s.Length -ge 6) { $Text = $Text.Replace($s, '<token>') } }
    $Text = [regex]::Replace($Text, '(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_\-]{10,}|gl[a-z]{2,4}-[A-Za-z0-9_\-]{20,})', '<token>')
    return $Text
}
# A file gh is still writing (Start-Process -RedirectStandardOutput keeps it open) can only be read with a shared mode.
function Read-SharedText {
    param([string]$Path)
    $fs = New-Object IO.FileStream($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete))
    try { $sr = New-Object IO.StreamReader($fs, [Text.Encoding]::UTF8); try { return $sr.ReadToEnd() } finally { $sr.Dispose() } } finally { $fs.Dispose() }
}
function Get-Line {
    param([string]$Text)
    return (Hide-Secret (Get-FirstLine $Text))
}
function Test-Status {
    param([bool]$Ok)
    if ($Ok) { return 'PASS' } else { return 'FAIL' }
}

# The first line of git's own message, without the GIT_TRACE lines (they start with a time of day).
function Get-GitMessage {
    param([string]$Text)
    $lines = @($Text -split "`r?`n" | Where-Object { $_.Trim() -and $_ -notmatch '^\d\d:\d\d:\d\d' })
    if ($lines.Count -eq 0) { return '' }
    return (Hide-Secret $lines[0])
}
function Get-HelperValues {
    $g = Invoke-Native -File $t.GitExe -ArgList @('config', '--get-all', "credential.https://$forgeHost.helper")
    $vals = @($g.StdOut -split "`r?`n")
    if ($vals.Count -gt 0 -and $vals[-1] -eq '') { $vals = @($vals[0..($vals.Count - 2)]) }
    return ,$vals
}

function Invoke-Forge {
    param([string[]]$ArgList, [string]$StdIn, [int]$TimeoutSec = 120)
    return (Invoke-Native -File $launcher -ArgList $ArgList -StdIn $StdIn -TimeoutSec $TimeoutSec)
}

# Credential Manager entries by name only (cmdkey /list prints target names, never secrets). The line label is translated ("Target:", "目標:"), but the
# target itself is always written `target=<name>` after the type, so that is what is matched.
function Get-CredentialTargets {
    param([string]$Pattern)
    $names = @()
    foreach ($line in @(& cmdkey.exe /list 2>$null)) {
        if ($line -match 'target=(.+)$') {
            $name = $Matches[1].Trim()   # the next -match replaces $Matches
            if ($name -match $Pattern) { $names += $name }
        }
    }
    return $names
}

# gh and glab keep a token in plain text when the credential store fails. What counts as a non-empty token value in a YAML line:
function Get-PlainTokenLines {
    param([string]$Path, [string]$Key)
    $hits = @()
    if (-not (Test-Path -LiteralPath $Path)) { return $hits }
    foreach ($line in (Get-Content -LiteralPath $Path -Encoding UTF8)) {
        if ($line -match "^\s*$Key\s*:\s*(.*?)\s*(#.*)?$") {
            $v = $Matches[1].Trim().Trim('"').Trim("'")
            if ($v -and $v -notin @('!!null', 'null', '~')) { $hits += $line.Trim().Split(':')[0] }
        }
    }
    return $hits
}
function Get-YamlKeys {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return @() }
    return @(Get-Content -LiteralPath $Path -Encoding UTF8 | ForEach-Object { if ($_ -match '^\s*([A-Za-z0-9_\-\.]+)\s*:') { $Matches[1] } } | Select-Object -Unique)
}

function Remove-Login {
    param([string]$Why)
    $args2 = @('auth', 'logout', '--hostname', $forgeHost)
    $r = Invoke-Forge $args2
    $left = @()
    if ($Cli -eq 'gh') { $left = @(Get-PlainTokenLines (Join-Path $cfgDir 'hosts.yml') 'oauth_token') } else { $left = @(Get-PlainTokenLines (Join-Path $cfgDir 'config.yml') 'token') }
    Add-Step "logout:$Why" (Test-Status ($r.ExitCode -eq 0 -and $left.Count -eq 0)) "$Cli auth logout exit $($r.ExitCode); plain-text token lines left in the configuration folder: $($left.Count); $(Get-Line ($r.StdOut + ' ' + $r.StdErr))"
}

# ---- the token search: bytes of the token (UTF-8 and UTF-16LE) in every file of the places the kit writes to ----
function Initialize-Scanner {
    if ('SbdTokenScan' -as [type]) { return }
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
public static class SbdTokenScan {
    public static int Files; public static long Bytes; public static int Skipped;
    public static List<string> Hits = new List<string>();
    public static List<string> SkippedNames = new List<string>();
    static bool Has(byte[] hay, int len, byte[] needle) {
        int n = needle.Length;
        for (int i = 0; i + n <= len; i++) {
            if (hay[i] != needle[0]) continue;
            int j = 1; while (j < n && hay[i + j] == needle[j]) j++;
            if (j == n) return true;
        }
        return false;
    }
    static bool FileHas(string path, byte[][] needles, long maxBytes) {
        using (FileStream fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete)) {
            if (fs.Length > maxBytes) { Skipped++; SkippedNames.Add(path); return false; }
            Files++;
            int max = 0; foreach (byte[] nd in needles) if (nd.Length > max) max = nd.Length;
            int chunk = 4 * 1024 * 1024; byte[] buf = new byte[chunk + max];
            int carry = 0; int read;
            while ((read = fs.Read(buf, carry, chunk)) > 0) {
                int len = carry + read; Bytes += read;
                foreach (byte[] nd in needles) if (Has(buf, len, nd)) return true;
                carry = Math.Min(max - 1, len);
                Buffer.BlockCopy(buf, len - carry, buf, 0, carry);
            }
        }
        return false;
    }
    public static void Reset() { Files = 0; Bytes = 0; Skipped = 0; Hits.Clear(); SkippedNames.Clear(); }
    public static void Scan(string[] roots, string token, string[] skipDirs, long maxBytes) {
        byte[][] needles = new byte[][] { Encoding.UTF8.GetBytes(token), Encoding.Unicode.GetBytes(token) };
        Stack<string> dirs = new Stack<string>();
        foreach (string r in roots) if (Directory.Exists(r)) dirs.Push(r);
        while (dirs.Count > 0) {
            string d = dirs.Pop();
            bool skip = false;
            foreach (string s in skipDirs) if (d.Equals(s, StringComparison.OrdinalIgnoreCase)) skip = true;
            if (skip) continue;
            try {
                foreach (string f in Directory.EnumerateFiles(d)) {
                    try { if (FileHas(f, needles, maxBytes)) Hits.Add(f); } catch (Exception) { Skipped++; SkippedNames.Add(f); }
                }
                foreach (string sub in Directory.EnumerateDirectories(d)) {
                    FileAttributes a = File.GetAttributes(sub);
                    if ((a & FileAttributes.ReparsePoint) != 0) continue;
                    dirs.Push(sub);
                }
            } catch (Exception) { Skipped++; SkippedNames.Add(d); }
        }
    }
}
'@
}

function Get-ScanRoots {
    $roots = @($SbdRoot, $KitDir, 'C:\Users\Public\sbdkf', $env:TEMP, $WorkDir,
        (Join-Path $env:APPDATA 'GitHub CLI'), (Join-Path $env:APPDATA 'glab-cli'), (Join-Path $env:USERPROFILE '.config'))
    return @($roots | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -Unique)
}

function Invoke-TokenSearch {
    # The token comes from the CLI itself, inside this script, and lives in one variable.
    $tok = $null
    if ($Cli -eq 'gh') {
        $r = Invoke-Forge @('auth', 'token', '--hostname', $forgeHost)
        if ($r.ExitCode -eq 0) { $tok = (Get-FirstLine $r.StdOut).Trim() }
    } else {
        $r = Invoke-Forge @('auth', 'git-credential', 'get') ("protocol=https`nhost=$forgeHost`n`n")
        if ($r.ExitCode -eq 0) { foreach ($l in ($r.StdOut -split "`r?`n")) { if ($l.StartsWith('password=')) { $tok = $l.Substring(9).Trim() } } }
    }
    if (-not $tok -or $tok.Length -lt 20) {
        Add-Step 'token-search' 'FAIL' "could not read the token from $Cli (exit $($r.ExitCode)); nothing was searched"
        return
    }
    [void]$script:Secrets.Add($tok)
    try {
        Initialize-Scanner
        # Self-test: the scanner must find a planted string of the same shape, in UTF-8 and in UTF-16, or its "nothing found" means nothing.
        $canaryDir = Join-Path $env:TEMP ('sbd-canary-' + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $canaryDir -Force | Out-Null
        $canary = 'canary-' + [guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N')
        [IO.File]::WriteAllText((Join-Path $canaryDir 'utf8.txt'), "x $canary y", (Get-Utf8NoBom))
        [IO.File]::WriteAllText((Join-Path $canaryDir 'utf16.txt'), "x $canary y", [Text.Encoding]::Unicode)
        [IO.File]::WriteAllText((Join-Path $canaryDir 'clean.txt'), 'nothing here', (Get-Utf8NoBom))
        [SbdTokenScan]::Reset()
        [SbdTokenScan]::Scan([string[]]@($canaryDir), $canary, [string[]]@(), 200MB)
        $found = @([SbdTokenScan]::Hits | ForEach-Object { Split-Path -Leaf $_ } | Sort-Object)
        Remove-Item -LiteralPath $canaryDir -Recurse -Force
        Add-Step 'token-search:self-test' (Test-Status ($found.Count -eq 2 -and $found[0] -eq 'utf16.txt' -and $found[1] -eq 'utf8.txt')) "planted string found in: $($found -join ', ')"

        $roots = Get-ScanRoots
        $skipDirs = [string[]]@((Join-Path $Tools 'downloads'))
        [SbdTokenScan]::Reset()
        $sw = [Diagnostics.Stopwatch]::StartNew()
        [SbdTokenScan]::Scan([string[]]$roots, $tok, $skipDirs, 200MB)
        $hits = @([SbdTokenScan]::Hits)
        Add-Step 'token-search' (Test-Status ($hits.Count -eq 0)) ("token ($($tok.Length) chars, UTF-8 and UTF-16LE) searched in $([SbdTokenScan]::Files) files, $([math]::Round([SbdTokenScan]::Bytes / 1MB)) MB, $([int]($sw.ElapsedMilliseconds / 1000)) s; hits: $($hits.Count)$(if ($hits.Count -gt 0) { ' in ' + ($hits -join '; ') }); skipped (unreadable or over 200 MB): $([SbdTokenScan]::Skipped); roots: $($roots -join '; '); tools\downloads skipped (compressed archives)") $false ([int]$sw.ElapsedMilliseconds)
    } finally {
        $tok = $null
    }
}

try {
    # ---- 0: the launcher, and the Git configuration it is wired into ----
    $v = Invoke-Forge @('--version')
    Add-Step 'launcher' (Test-Status ($v.ExitCode -eq 0 -and ($v.StdOut + $v.StdErr) -match [regex]::Escape($version))) "$launcher --version -> $(Get-Line $v.StdOut)"
    if (@($script:AcctSteps | Where-Object { $_.status -eq 'FAIL' }).Count -gt 0) { Save-AccountResult }

    if ($Logout) { Remove-Login 'requested'; Save-AccountResult }
    if ($Search) { Invoke-TokenSearch; Save-AccountResult }

    $vals = Get-HelperValues
    $helperOk = ($vals.Count -eq 2 -and $vals[0] -eq '' -and $vals[1].StartsWith('!') -and $vals[1].EndsWith("/bin/$Cli' auth git-credential"))
    Add-Step 'git-helper-config' (Test-Status $helperOk) "credential.https://$forgeHost.helper in $($env:GIT_CONFIG_GLOBAL): $($vals.Count) values; first empty: $($vals.Count -gt 0 -and $vals[0] -eq ''); second: $(if ($vals.Count -gt 1) { $vals[1] })"

    # ---- 1: the login ----
    if ($Login -and $Cli -eq 'gh') {
        $outF = Join-Path $LogDir 'gh-login.out.txt'
        $errF = Join-Path $LogDir 'gh-login.err.txt'
        Remove-Item -LiteralPath $outF, $errF -ErrorAction SilentlyContinue
        $sw = [Diagnostics.Stopwatch]::StartNew()
        $p = Start-Process -FilePath $launcher -ArgumentList @('auth', 'login', '--hostname', $forgeHost, '--git-protocol', 'https', '--web') -RedirectStandardOutput $outF -RedirectStandardError $errF -NoNewWindow -PassThru
        $null = $p.Handle   # without this, ExitCode is empty after the process ends
        $code = $null
        while (-not $code -and $sw.Elapsed.TotalSeconds -lt 90 -and -not $p.HasExited) {
            Start-Sleep -Milliseconds 500
            foreach ($f in @($outF, $errF)) {
                if ((Test-Path -LiteralPath $f) -and -not $code) {
                    $txt = (Read-SharedText $f)
                    if ($txt -match '\b([A-Z0-9]{4}-[A-Z0-9]{4})\b') { $code = $Matches[1] }
                }
            }
        }
        if ($code) {
            if ($CodeFile) { Write-AllTextUtf8 $CodeFile $code }
            Add-Step 'login:code-printed' 'PASS' "gh printed a one-time code (length $($code.Length)); written to $CodeFile; waiting for the person to approve at https://github.com/login/device" $true ([int]$sw.ElapsedMilliseconds)
            if (-not $p.WaitForExit($LoginWaitMin * 60 * 1000)) {
                try { $p.Kill() } catch { }
                Add-Step 'login' 'FAIL' "not approved within $LoginWaitMin minutes; gh login stopped" $true ([int]$sw.ElapsedMilliseconds)
            } else {
                $p.WaitForExit()
                $outTxt = ''
                foreach ($f in @($outF, $errF)) { if (Test-Path -LiteralPath $f) { $outTxt += (Read-SharedText $f) + "`n" } }
                $line = ($outTxt -split "`r?`n" | Where-Object { $_ -match 'Logged in|Authentication complete|error|failed' } | Select-Object -First 2) -join ' | '
                Add-Step 'login' (Test-Status ($p.ExitCode -eq 0)) "gh auth login --hostname $forgeHost --git-protocol https --web exit $($p.ExitCode); $(Hide-Secret $line)" $true ([int]$sw.ElapsedMilliseconds)
            }
        } else {
            try { if (-not $p.HasExited) { $p.Kill() } } catch { }
            $txt = ''
            foreach ($f in @($outF, $errF)) { if (Test-Path -LiteralPath $f) { $txt += (Read-SharedText $f) + ' ' } }
            Add-Step 'login:code-printed' 'FAIL' "gh printed no one-time code within 90 s: $(Get-Line $txt)"
        }
    } elseif ($Login -and $Cli -eq 'glab') {
        $tok = $null
        try {
            if (-not $TokenFile -or -not (Test-Path -LiteralPath $TokenFile)) { throw "token file not found: $TokenFile" }
            $tok = ([IO.File]::ReadAllText($TokenFile)).Trim()
        } finally {
            # Gone at once, whatever happens next: overwritten, then deleted.
            if ($TokenFile -and (Test-Path -LiteralPath $TokenFile)) {
                try { [IO.File]::WriteAllBytes($TokenFile, (New-Object byte[] 256)) } catch { }
                Remove-Item -LiteralPath $TokenFile -Force -ErrorAction SilentlyContinue
            }
        }
        Add-Step 'token-file-deleted' (Test-Status (-not (Test-Path -LiteralPath $TokenFile))) "token file removed right after it was read: $TokenFile"
        [void]$script:Secrets.Add($tok)
        try {
            $sw = [Diagnostics.Stopwatch]::StartNew()
            $r = Invoke-Forge @('auth', 'login', '--hostname', $forgeHost, '--git-protocol', 'https', '--api-protocol', 'https', '--stdin') ($tok + "`n")
            Add-Step 'login' (Test-Status ($r.ExitCode -eq 0)) "glab auth login --hostname $forgeHost --git-protocol https --api-protocol https --stdin exit $($r.ExitCode); $(Get-Line ($r.StdOut + ' ' + $r.StdErr))" $true ([int]$sw.ElapsedMilliseconds)
        } finally {
            $tok = $null
        }
    }

    # ---- 2: where the token went ----
    $plain = $false
    if ($Cli -eq 'gh') {
        $s = Invoke-Forge @('auth', 'status', '--hostname', $forgeHost, '--json', 'hosts')
        # not $login or $state: PowerShell names are case-insensitive, and $Login is this script's [switch] parameter
        $source = $null; $acct = $null; $acctState = $null
        if ($s.ExitCode -eq 0) {
            try {
                $j = $s.StdOut | ConvertFrom-Json
                $entry = @($j.hosts.$forgeHost) | Select-Object -First 1
                $source = [string]$entry.tokenSource; $acct = [string]$entry.login; $acctState = [string]$entry.state
            } catch { $source = $null }
        }
        if ($null -eq $source) {
            # Unreadable is a FAIL, but it is not proof of a plain-text token (config-file-token below checks the file), so it does not log the CLI out.
            Add-Step 'token-source' 'FAIL' "gh auth status --json hosts exit $($s.ExitCode); no tokenSource read: $(Get-Line ($s.StdErr + ' ' + $s.StdOut))"
        } else {
            Add-Step 'token-source' (Test-Status ($source -eq 'keyring')) "tokenSource='$source' (the exact value gh 2.103.3 reports); login=$acct; state=$acctState"
            if ($source -ne 'keyring') { $plain = $true }
        }
        $hostsYml = Join-Path $cfgDir 'hosts.yml'
        $tokLines = @(Get-PlainTokenLines $hostsYml 'oauth_token')
        Add-Step 'config-file-token' (Test-Status ($tokLines.Count -eq 0 -and (Test-Path -LiteralPath $hostsYml))) "$hostsYml exists: $(Test-Path -LiteralPath $hostsYml); keys: $((Get-YamlKeys $hostsYml) -join ', '); non-empty oauth_token lines: $($tokLines.Count)"
        if ($tokLines.Count -gt 0) { $plain = $true }
        $defaultDir = Join-Path $env:APPDATA 'GitHub CLI'
        Add-Step 'isolation' (Test-Status (-not (Test-Path -LiteralPath (Join-Path $defaultDir 'hosts.yml')))) "gh's default folder $defaultDir holds no hosts.yml (GH_CONFIG_DIR $cfgDir was used)"
        $targets = @(Get-CredentialTargets '(?i)gh:github\.com')
        Add-Step 'credential-store' (Test-Status ($targets.Count -gt 0)) "Windows Credential Manager targets (names only): $($targets -join '; ')"
    } else {
        $cfg = Join-Path $cfgDir 'config.yml'
        $tokLines = @(Get-PlainTokenLines $cfg 'token')
        Add-Step 'config-file-token' (Test-Status ($tokLines.Count -eq 0 -and (Test-Path -LiteralPath $cfg))) "$cfg exists: $(Test-Path -LiteralPath $cfg); keys: $((Get-YamlKeys $cfg) -join ', '); non-empty token lines: $($tokLines.Count)"
        if ($tokLines.Count -gt 0) { $plain = $true }
        $s = Invoke-Forge @('auth', 'status', '--hostname', $forgeHost)
        Add-Step 'auth-status' (Test-Status ($s.ExitCode -eq 0)) "glab auth status --hostname $forgeHost exit $($s.ExitCode)"
        if ($s.ExitCode -ne 0) { $plain = $true }
        $defaults = @((Join-Path $env:APPDATA 'glab-cli\config.yml'), (Join-Path $env:USERPROFILE '.config\glab-cli\config.yml'))
        $present = @($defaults | Where-Object { Test-Path -LiteralPath $_ })
        Add-Step 'isolation' (Test-Status ($present.Count -eq 0)) "glab's default folders hold no config.yml (GLAB_CONFIG_DIR $cfgDir was used); found: $($present.Count)"
        $targets = @(Get-CredentialTargets '(?i)glab|gitlab\.moldplan')
        Add-Step 'credential-store' (Test-Status ($targets.Count -gt 0)) "Windows Credential Manager targets (names only): $($targets -join '; ')"
    }
    if ($plain) {
        Add-Step 'plain-text-token' 'FAIL' 'the token is not in the credential store; logging the CLI out (no --insecure-storage, ever)'
        Remove-Login 'plain-text'
        Save-AccountResult
    }

    # ---- 3: a push through the credential helper, with no prompt allowed ----
    if (-not $SkipPush) {
        $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
        $branch = "chore/account-check-$stamp"
        if ($branch -notmatch '^chore/account-check-\d{8}-\d{6}$') { throw 'branch name is not the account-check form' }
        $dest = Join-Path $WorkDir "account-check-$Cli"
        if (Test-Path -LiteralPath $dest) { Remove-Item -LiteralPath $dest -Recurse -Force }
        # No prompt of any kind: a prompt would make the command fail instead of waiting for a person.
        $noPrompt = @{ GIT_TERMINAL_PROMPT = '0'; GCM_INTERACTIVE = 'never'; GIT_ASKPASS = 'echo'; SSH_ASKPASS = 'echo'; GIT_TRACE = '1' }
        $helperRuns = { param($text) @(($text -split "`r?`n") | Where-Object { $_ -match 'run_command:.*auth git-credential' }).Count }
        $mgrRuns = { param($text) @(($text -split "`r?`n") | Where-Object { $_ -match 'credential-manager|git-credential-manager|credential-helper-selector' }).Count }
        $sw = [Diagnostics.Stopwatch]::StartNew()
        $c = Invoke-Native -File $t.GitExe -ArgList @('clone', '--quiet', $RepoUrl, $dest) -Env $noPrompt -TimeoutSec 180
        Add-Step 'git-clone' (Test-Status ($c.ExitCode -eq 0 -and (Test-Path -LiteralPath (Join-Path $dest '.git')))) "git clone exit $($c.ExitCode) of a private repository; helper runs seen: $(& $helperRuns ($c.StdErr + $c.StdOut)); Git Credential Manager runs seen: $(& $mgrRuns ($c.StdErr + $c.StdOut)); $(Get-GitMessage $c.StdErr)" $false ([int]$sw.ElapsedMilliseconds)
        if ($c.ExitCode -eq 0) {
            $br = Invoke-Native -File $t.GitExe -ArgList @('-C', $dest, 'checkout', '-q', '-b', $branch)
            $file = "check-$stamp.md"
            $body = "# Account check $stamp`n`nWritten by spike/win/account-check.ps1 ($Cli $version) in the Windows VM. It checks that a push through the credential helper needs no prompt.`n"
            [IO.File]::WriteAllText((Join-Path $dest $file), $body, (Get-Utf8NoBom))
            [void](Invoke-Native -File $t.GitExe -ArgList @('-C', $dest, 'add', $file))
            $cm = Invoke-Native -File $t.GitExe -ArgList @('-C', $dest, 'commit', '-q', '-m', "chore: account check $stamp")
            Add-Step 'git-commit' (Test-Status ($br.ExitCode -eq 0 -and $cm.ExitCode -eq 0)) "branch $branch, file $file; checkout exit $($br.ExitCode), commit exit $($cm.ExitCode) $(Get-Line $cm.StdErr)"
            $sw.Restart()
            $current = (Get-FirstLine (Invoke-Native -File $t.GitExe -ArgList @('-C', $dest, 'rev-parse', '--abbrev-ref', 'HEAD')).StdOut)
            if ($current -ne $branch) { throw "HEAD is '$current', not $branch; nothing is pushed" }
            $pu = Invoke-Native -File $t.GitExe -ArgList @('-C', $dest, 'push', 'origin', "HEAD:refs/heads/$branch") -Env $noPrompt -TimeoutSec 180
            Add-Step 'git-push' (Test-Status ($pu.ExitCode -eq 0)) "git push origin HEAD:refs/heads/$branch exit $($pu.ExitCode) with prompts disabled; helper runs seen: $(& $helperRuns ($pu.StdErr + $pu.StdOut)); Git Credential Manager runs seen: $(& $mgrRuns ($pu.StdErr + $pu.StdOut)); $(Get-GitMessage $pu.StdErr)" $false ([int]$sw.ElapsedMilliseconds)
            if ($pu.ExitCode -eq 0) {
                $ls = Invoke-Native -File $t.GitExe -ArgList @('-C', $dest, 'ls-remote', '--heads', 'origin', $branch) -Env $noPrompt -TimeoutSec 120
                $sha = ((Get-FirstLine $ls.StdOut) -split '\s+')[0]
                Add-Step 'remote-branch' (Test-Status ($sha -match '^[0-9a-f]{40}$')) "origin has $branch at $sha"
            }
            # The push must not have changed the helper setup.
            $v2 = Get-HelperValues
            Add-Step 'git-helper-config-after' (Test-Status ($v2.Count -eq 2 -and $v2[0] -eq '' -and $v2[1] -eq $vals[1])) "the helper entries are unchanged after login and push: $($v2.Count) values"
        }
        if (Test-Path -LiteralPath $dest) { Remove-Item -LiteralPath $dest -Recurse -Force -ErrorAction SilentlyContinue }
    }

    # ---- 4: the token must be in no file the kit wrote ----
    if (-not $SkipSearch) { Invoke-TokenSearch }
} catch {
    Add-Step 'unexpected-error' 'FAIL' (Hide-Secret $_.Exception.Message)
}
Save-AccountResult
