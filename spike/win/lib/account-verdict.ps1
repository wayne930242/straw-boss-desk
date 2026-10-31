# Pure decisions of account-check.ps1 (and bootstrap.ps1's forge-git verify), kept apart from every CLI call so account-check-test.ps1 can run them offline.
# The rule they enforce (team profile spec, section 4): a login is logged out only on positive evidence that its token is in plain text. A failed or
# unreadable status is "could not verify": the check fails, and the credential in the store stays.

# The key/value lines of a YAML file with the keys above each of them: gh's and glab's configuration files are plain block mappings, so the nesting is
# the indentation. Returns one entry per `key: value` line (value may be empty when the line opens a block): Path (the keys above, outermost first), Key,
# Value (quotes and a trailing comment removed). Lists and block scalars are not followed; they hold no token in either CLI's files.
function Get-YamlEntries {
    param([string]$Path)
    $entries = @()
    if (-not (Test-Path -LiteralPath $Path)) { return $entries }
    $stack = New-Object System.Collections.ArrayList   # @{ Indent; Key }
    foreach ($line in (Get-Content -LiteralPath $Path -Encoding UTF8)) {
        if ($line -match '^\s*(#|$)' -or $line -match '^\s*-(\s|$)') { continue }
        if ($line -notmatch '^(\s*)(?:"([^"]*)"|''([^'']*)''|(.+?))\s*:(?:\s+(.*))?$') { continue }
        $indent = $Matches[1].Length
        $key = if ($null -ne $Matches[2] -and $Matches[2] -ne '') { $Matches[2] } elseif ($null -ne $Matches[3] -and $Matches[3] -ne '') { $Matches[3] } else { $Matches[4] }
        $raw = if ($Matches[5]) { [string]$Matches[5] } else { '' }
        $raw = ($raw -replace '(^|\s)#.*$', '').Trim().Trim('"').Trim("'")
        while ($stack.Count -gt 0 -and $stack[$stack.Count - 1].Indent -ge $indent) { $stack.RemoveAt($stack.Count - 1) }
        # not $path: PowerShell names are case-insensitive and $Path is this function's [string] parameter
        $trail = @($stack | ForEach-Object { $_.Key })
        $entries += [pscustomobject]@{ Path = $trail; Key = $key; Value = $raw }
        if ($raw -eq '') { [void]$stack.Add(@{ Indent = $indent; Key = $key }) }
    }
    return $entries
}

# A non-empty value that is a token: not an empty string and not YAML's null spellings.
function Test-TokenValue {
    param([string]$Value)
    return ($Value -and $Value -notin @('!!null', 'null', '~'))
}

# Non-empty token lines of one configuration file, by whose they are. Only the host's own block counts as evidence for that host's login (spec section 4,
# "for the host"); a `token` key anywhere else (an alias named token, another section, another host) is no evidence for it.
#   -Prefix     the keys above the host entries: @() for gh's hosts.yml, @('hosts') for glab's config.yml and gh's legacy config.yml
#   -Key        oauth_token (gh) or token (glab)
#   -DirectOnly the key must be a direct child of the host entry (glab); without it, any depth below (gh nests it under users: <account>:)
# Returns Own (count for the checked host) and Other (names of the other hosts that carry a token; '(no host)' for a token with no host above it).
# Never the values.
function Get-HostTokenFindings {
    param([string]$Path, [string]$HostName, [string]$Key, [string[]]$Prefix = @(), [switch]$DirectOnly)
    $own = 0; $other = @()
    foreach ($e in (Get-YamlEntries $Path)) {
        if ($e.Key -ne $Key -or -not (Test-TokenValue $e.Value)) { continue }
        $p = @($e.Path)
        if ($p.Count -lt $Prefix.Count) { continue }
        $underPrefix = $true
        for ($i = 0; $i -lt $Prefix.Count; $i++) { if ($p[$i] -ne $Prefix[$i]) { $underPrefix = $false } }
        if (-not $underPrefix) { continue }   # aliases:, or any other section of the file
        if ($p.Count -eq $Prefix.Count) { $other += '(no host)'; continue }
        $h = $p[$Prefix.Count]
        if ($h -ieq $HostName) {
            if ($DirectOnly -and $p.Count -ne $Prefix.Count + 1) { continue }
            $own++
        } else {
            $other += $h
        }
    }
    return [pscustomobject]@{ Own = $own; Other = @($other | Select-Object -Unique) }
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

# A root that lies inside another root is covered by it; scanning both would read its files twice.
function Remove-NestedRoots {
    param([string[]]$Roots)
    $seen = @{}; $norm = @()
    foreach ($r in @($Roots | Where-Object { $_ } | ForEach-Object { $_.TrimEnd('\', '/') })) {
        if (-not $seen.ContainsKey($r.ToLowerInvariant())) { $seen[$r.ToLowerInvariant()] = $true; $norm += $r }
    }
    $keep = @()
    foreach ($r in $norm) {
        $inside = $false
        foreach ($o in $norm) {
            if ($o -ine $r -and $r.StartsWith($o + '\', [StringComparison]::OrdinalIgnoreCase)) { $inside = $true }
        }
        if (-not $inside) { $keep += $r }
    }
    return $keep
}

# The token search's unread files, split by whether they lie under a folder the spec names (spec section 8: no file under the app's data folder, and the
# kit's own places): an unread file there fails the search. Under any other folder the search also reads (%TEMP%, ~\.config, the CLIs' default folders) it only
# warns. $Unread is a list of objects with Path and Reason.
function Split-UnreadFiles {
    param($Unread, [string[]]$StrictRoots)
    $roots = @($StrictRoots | Where-Object { $_ } | ForEach-Object { $_.TrimEnd('\', '/') })
    $strict = @(); $extra = @()
    foreach ($u in @($Unread | Where-Object { $_ })) {
        $under = $false
        foreach ($r in $roots) {
            if ($u.Path.Equals($r, [StringComparison]::OrdinalIgnoreCase) -or $u.Path.StartsWith($r + '\', [StringComparison]::OrdinalIgnoreCase)) { $under = $true }
        }
        if ($under) { $strict += $u } else { $extra += $u }
    }
    return [pscustomobject]@{ Strict = $strict; Extra = $extra }
}
