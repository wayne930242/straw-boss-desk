# Pure decisions of account-check.ps1 (and bootstrap.ps1's forge-git verify), kept apart from every CLI call so account-check-test.ps1 can run them offline.
# The rule they enforce (team profile spec, section 4): a login is logged out only on positive evidence that its token is in plain text. A failed or
# unreadable status is "could not verify": the check fails, and the credential in the store stays.

# What counts as a non-empty token value in a YAML line. Returns the key names of the offending lines, never the values.
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

# `git config --get-all` output as a list of values. Empty output is no value (a split of '' would give one empty value, and a range over it two).
function ConvertTo-GitValueList {
    param([string]$Text)
    if (-not $Text) { return ,@() }
    $vals = @(($Text -replace "`r?`n$", '') -split "`r?`n")
    return ,$vals
}

# gh's answer. $Source is the tokenSource gh reported ($null: status failed or the field was missing or blank); $HostsTokens and $ConfigTokens are the counts
# of non-empty token lines in hosts.yml and config.yml.
#   Plain      positive evidence of a plain-text token: log the CLI out
#   Verified   the token is in the keyring
#   Reason     one line for the step
function Get-GhTokenVerdict {
    param([string]$Source, [int]$HostsTokens, [int]$ConfigTokens)
    $fileHit = ($HostsTokens + $ConfigTokens) -gt 0
    if ($Source -eq 'oauth_token' -or $Source -match '[\\/]' -or $Source -match '\.ya?ml$') {
        return [pscustomobject]@{ Plain = $true; Verified = $false; Reason = "gh reports the token source as '$Source' (a file), not the keyring" }
    }
    if ($fileHit) {
        return [pscustomobject]@{ Plain = $true; Verified = $false; Reason = "a non-empty token line is in hosts.yml ($HostsTokens) or config.yml ($ConfigTokens)" }
    }
    if ([string]::IsNullOrWhiteSpace($Source)) {
        return [pscustomobject]@{ Plain = $false; Verified = $false; Reason = 'could not verify: gh reported no tokenSource (status failed or the field is missing); this is not a plain-text verdict, so no logout' }
    }
    if ($Source -eq 'keyring') {
        return [pscustomobject]@{ Plain = $false; Verified = $true; Reason = "tokenSource is 'keyring'" }
    }
    return [pscustomobject]@{ Plain = $false; Verified = $false; Reason = "tokenSource is '$Source', not the keyring, and no token is in a file; not a plain-text verdict, so no logout (an environment token wins over the login)" }
}

# glab's answer. Only config.yml decides plain text; a failed `glab auth status` (network, certificate, expired token, anything) is "could not verify".
function Get-GlabTokenVerdict {
    param([int]$ConfigTokens, [int]$StatusExit)
    if ($ConfigTokens -gt 0) {
        return [pscustomobject]@{ Plain = $true; Verified = $false; Reason = "config.yml holds $ConfigTokens non-empty token line(s)" }
    }
    if ($StatusExit -ne 0) {
        return [pscustomobject]@{ Plain = $false; Verified = $false; Reason = "could not verify: glab auth status exited $StatusExit (network, certificate, or token problem); this is not a plain-text verdict, so no logout" }
    }
    return [pscustomobject]@{ Plain = $false; Verified = $true; Reason = 'config.yml holds no token and glab auth status succeeded' }
}

# Files and folders the token search could not read, split by whether they lie under tools\downloads (compressed archives made before any login).
function Split-SkippedPaths {
    param([string[]]$Paths, [string]$DownloadsDir)
    $root = $DownloadsDir.TrimEnd('\', '/') + '\'
    $in = @(); $out = @()
    foreach ($p in @($Paths | Where-Object { $_ })) {
        if ($p.Equals($DownloadsDir.TrimEnd('\', '/'), [StringComparison]::OrdinalIgnoreCase) -or $p.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) { $in += $p } else { $out += $p }
    }
    return [pscustomobject]@{ InDownloads = $in; Elsewhere = $out }
}
