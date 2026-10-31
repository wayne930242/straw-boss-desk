<#
.SYNOPSIS
  Offline tests of the decisions account-check.ps1 makes (lib\account-verdict.ps1): when a login counts as a plain-text token and is logged out, when it is only
  "could not verify", how the token search treats unread files and nested roots, which token lines count for the checked host, and how git config output is split. No CLI, no network, no login, no Credential Manager.
.DESCRIPTION
  Runs on Windows PowerShell 5.1 and PowerShell 7. PASS/FAIL lines; exit 1 if any FAIL. The fixtures hold fake token text only.
#>
$ErrorActionPreference = 'Stop'
. (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'lib\account-verdict.ps1')

$script:Fails = 0
function Assert-That {
    param([string]$Name, [bool]$Ok, [string]$Detail = '')
    if ($Ok) { Write-Host "PASS $Name" } else { $script:Fails++; Write-Host "FAIL $Name $Detail" }
}

$dir = Join-Path ([IO.Path]::GetTempPath()) ('sbd-verdict-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $dir -Force | Out-Null
try {
    function New-Fixture {
        param([string]$Name, [string]$Text)
        $p = Join-Path $dir $Name
        [IO.File]::WriteAllText($p, $Text, (New-Object Text.UTF8Encoding($false)))
        return $p
    }

    # ---- Get-HostTokenFindings: only the checked host's own block is evidence (R2-F001) ----
    $ghKeyring = New-Fixture 'gh-keyring.yml' "github.com:`n    git_protocol: https`n    users:`n        someone:`n    user: someone`n"
    $ghPlain = New-Fixture 'gh-plain.yml' "github.com:`n    oauth_token: fake_token_value_1`n    user: someone`n"
    $ghNested = New-Fixture 'gh-nested.yml' "github.com:`n    users:`n        someone:`n            oauth_token: `"fake_token_value_2`"`n"
    $ghEmpty = New-Fixture 'gh-empty.yml' "github.com:`n    oauth_token:`n"
    $ghOther = New-Fixture 'gh-other-host.yml' "github.com:`n    git_protocol: https`n    users:`n        someone:`n    user: someone`nghe.example.org:`n    oauth_token: fake_token_value_4`n    user: other`n"
    $ghBoth = New-Fixture 'gh-both-hosts.yml' "ghe.example.org:`n    oauth_token: fake_token_value_5`ngithub.com:`n    users:`n        someone:`n            oauth_token: fake_token_value_6`n"
    $ghAlias = New-Fixture 'gh-alias-token.yml' "git_protocol: https`naliases:`n    token: auth token`n    oauth_token: auth token`nprompt: enabled`n"
    $ghLegacy = New-Fixture 'gh-legacy-config.yml' "git_protocol: https`nhosts:`n    github.com:`n        oauth_token: fake_token_value_7`n    other.example.org:`n        oauth_token: fake_token_value_8`naliases:`n    token: auth token`n"
    $glabPlain = New-Fixture 'glab-plain.yml' "hosts:`n  gitlab.example.org:`n    token: fake_token_value_3 # note`n    api_host: gitlab.example.org`n"
    $glabNull = New-Fixture 'glab-null.yml' "hosts:`n  gitlab.example.org:`n    token: !!null`n"
    $glabNone = New-Fixture 'glab-none.yml' "hosts:`n  gitlab.example.org:`n    api_host: gitlab.example.org`n"
    $glabOther = New-Fixture 'glab-other-host.yml' "git_protocol: https`nhosts:`n  gitlab.example.org:`n    api_host: gitlab.example.org`n    user: me`n  gitlab.other.net:`n    token: fake_token_value_9`n"
    $glabAlias = New-Fixture 'glab-alias-token.yml' "aliases:`n  token: auth status`nhosts:`n  gitlab.example.org:`n    api_host: gitlab.example.org`nlast: x`ntoken: fake_token_value_10`n"
    $glabPort = New-Fixture 'glab-port-host.yml' "hosts:`n  `"gitlab.example.org:8443`":`n    token: fake_token_value_11`n  gitlab.example.org:`n    api_host: x`n"
    $glabNested = New-Fixture 'glab-nested.yml' "hosts:`n  gitlab.example.org:`n    custom_headers:`n      token: fake_token_value_12`n"
    function Find-Gh { param($File, $HostName = 'github.com', [string[]]$Prefix = @()) Get-HostTokenFindings -Path $File -HostName $HostName -Key 'oauth_token' -Prefix $Prefix }
    function Find-Glab { param($File, $HostName = 'gitlab.example.org') Get-HostTokenFindings -Path $File -HostName $HostName -Key 'token' -Prefix @('hosts') -DirectOnly }
    Assert-That 'tokens: gh keyring file has none' ((Find-Gh $ghKeyring).Own -eq 0 -and (Find-Gh $ghKeyring).Other.Count -eq 0)
    Assert-That 'tokens: gh plain text is found for the host' ((Find-Gh $ghPlain).Own -eq 1 -and (Find-Gh $ghPlain).Other.Count -eq 0)
    Assert-That 'tokens: gh nested under users and quoted is found for the host' ((Find-Gh $ghNested).Own -eq 1)
    Assert-That 'tokens: gh empty value is not a token' ((Find-Gh $ghEmpty).Own -eq 0)
    Assert-That 'tokens: gh another host carrying a token is Other, not Own (the checked host has none)' ((Find-Gh $ghOther).Own -eq 0 -and (Find-Gh $ghOther).Other.Count -eq 1 -and (Find-Gh $ghOther).Other[0] -eq 'ghe.example.org')
    $f = Find-Gh $ghBoth
    Assert-That 'tokens: gh both hosts carry one: the host has 1, the other host is named' ($f.Own -eq 1 -and $f.Other.Count -eq 1 -and $f.Other[0] -eq 'ghe.example.org')
    $f = Find-Gh $ghOther -HostName 'ghe.example.org'
    Assert-That 'tokens: gh asking for the other host finds its own token' ($f.Own -eq 1 -and $f.Other.Count -eq 0)
    Assert-That 'tokens: gh host names compare without case' ((Find-Gh $ghPlain -HostName 'GitHub.COM').Own -eq 1)
    $f = Find-Gh $ghAlias -Prefix @('hosts')
    Assert-That 'tokens: gh config.yml with an alias named token (and oauth_token) is no evidence for anyone' ($f.Own -eq 0 -and $f.Other.Count -eq 0)
    $f = Find-Gh $ghLegacy -Prefix @('hosts')
    Assert-That 'tokens: gh legacy config.yml hosts: block counts for its host; the alias does not; the other host is named' ($f.Own -eq 1 -and $f.Other.Count -eq 1 -and $f.Other[0] -eq 'other.example.org')
    Assert-That 'tokens: glab plain text with a comment is found for the host' ((Find-Glab $glabPlain).Own -eq 1)
    Assert-That 'tokens: glab !!null is not a token' ((Find-Glab $glabNull).Own -eq 0)
    Assert-That 'tokens: glab without a token line has none' ((Find-Glab $glabNone).Own -eq 0 -and (Find-Glab $glabNone).Other.Count -eq 0)
    $f = Find-Glab $glabOther
    Assert-That 'tokens: glab another host carrying a token is Other, not Own' ($f.Own -eq 0 -and $f.Other.Count -eq 1 -and $f.Other[0] -eq 'gitlab.other.net')
    $f = Find-Glab $glabAlias
    Assert-That 'tokens: glab an alias named token and a top-level token are no evidence for the host' ($f.Own -eq 0 -and $f.Other.Count -eq 0)
    $f = Find-Glab $glabPort -HostName 'gitlab.example.org'
    Assert-That 'tokens: glab a quoted host:port entry is another host' ($f.Own -eq 0 -and $f.Other.Count -eq 1 -and $f.Other[0] -eq 'gitlab.example.org:8443')
    Assert-That 'tokens: glab a token below a deeper key is not the host token' ((Find-Glab $glabNested).Own -eq 0)
    Assert-That 'tokens: a missing file has none' ((Find-Glab (Join-Path $dir 'nope.yml')).Own -eq 0)
    $leak = ((Find-Gh $ghPlain) | Out-String) + ((Find-Gh $ghOther) | Out-String)
    Assert-That 'tokens: never a value, only counts and host names' ($leak -notmatch 'fake_token_value')

    # ---- gh: R-F002. Logout only on positive evidence. ----
    $v = Get-GhTokenVerdict -Source 'keyring' -HostsTokens 0 -ConfigTokens 0
    Assert-That 'gh: keyring, no file token -> verified, no logout' ($v.Verified -and -not $v.Plain)
    $v = Get-GhTokenVerdict -Source $null -HostsTokens 0 -ConfigTokens 0
    Assert-That 'gh: status failed (no tokenSource) -> could not verify, no logout' (-not $v.Verified -and -not $v.Plain -and $v.Reason -match 'could not verify')
    $v = Get-GhTokenVerdict -Source '' -HostsTokens 0 -ConfigTokens 0
    Assert-That 'gh: empty tokenSource -> could not verify, no logout' (-not $v.Verified -and -not $v.Plain -and $v.Reason -match 'could not verify')
    $v = Get-GhTokenVerdict -Source '   ' -HostsTokens 0 -ConfigTokens 0
    Assert-That 'gh: blank tokenSource -> could not verify, no logout' (-not $v.Verified -and -not $v.Plain)
    $v = Get-GhTokenVerdict -Source 'oauth_token' -HostsTokens 0 -ConfigTokens 0
    Assert-That 'gh: tokenSource oauth_token -> plain text, logout' ($v.Plain -and -not $v.Verified)
    $v = Get-GhTokenVerdict -Source 'C:\x\hosts.yml' -HostsTokens 0 -ConfigTokens 0
    Assert-That 'gh: tokenSource is a file path -> plain text, logout' ($v.Plain)
    $v = Get-GhTokenVerdict -Source 'keyring' -HostsTokens 1 -ConfigTokens 0
    Assert-That 'gh: token in hosts.yml -> plain text, logout (even when gh says keyring)' ($v.Plain)
    $v = Get-GhTokenVerdict -Source 'keyring' -HostsTokens 0 -ConfigTokens 1
    Assert-That 'gh: token in config.yml -> plain text, logout' ($v.Plain)
    $v = Get-GhTokenVerdict -Source $null -HostsTokens 1 -ConfigTokens 0
    Assert-That 'gh: status failed but a token is in a file -> plain text, logout' ($v.Plain)
    foreach ($envSource in @('GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN')) {
        $v = Get-GhTokenVerdict -Source $envSource -HostsTokens 0 -ConfigTokens 0
        Assert-That "gh: tokenSource $envSource -> fails, no logout (gh would refuse it anyway)" (-not $v.Verified -and -not $v.Plain)
    }
    # The same through the real files: the file fixtures feed the counts the script feeds.
    $v = Get-GhTokenVerdict -Source 'keyring' -HostsTokens (Find-Gh $ghPlain).Own -ConfigTokens 0
    Assert-That 'gh: a token in a real fixture file decides it' ($v.Plain)

    # ---- glab: R-F001. Only config.yml decides plain text. ----
    $v = Get-GlabTokenVerdict -ConfigTokens 0 -StatusExit 0
    Assert-That 'glab: no file token, status ok -> verified, no logout' ($v.Verified -and -not $v.Plain)
    foreach ($code in @(1, 2, -1)) {
        $v = Get-GlabTokenVerdict -ConfigTokens 0 -StatusExit $code
        Assert-That "glab: status failed (exit $code) -> could not verify, no logout" (-not $v.Verified -and -not $v.Plain -and $v.Reason -match 'could not verify')
    }
    $v = Get-GlabTokenVerdict -ConfigTokens 1 -StatusExit 0
    Assert-That 'glab: token in config.yml -> plain text, logout' ($v.Plain)
    $v = Get-GlabTokenVerdict -ConfigTokens 1 -StatusExit 1
    Assert-That 'glab: token in config.yml and status failed -> plain text, logout' ($v.Plain)
    $v = Get-GlabTokenVerdict -ConfigTokens (Find-Glab $glabPlain).Own -StatusExit 0
    Assert-That 'glab: a token in a real fixture file decides it' ($v.Plain)

    # ---- the token search's unread files: R-F005, R2-F003 ----
    $app = 'C:\Users\x\AppData\Local\straw-boss-desk'
    $strictRoots = @($app, 'C:\Users\x\sbd-kit', 'C:\Users\Public\sbdkf')
    function New-Unread { param($Path, $Reason = 'open or read: IOException 0x80070020 in use') [pscustomobject]@{ Path = $Path; Reason = $Reason } }
    $un = @((New-Unread "$app\logs\locked.log"), (New-Unread "$app\tools\downloads\node.zip"), (New-Unread "$app"), (New-Unread 'C:\Users\x\sbd-kit-old\a.bin'),
        (New-Unread 'C:\Users\x\AppData\Local\Temp\nsj788A.tmp\System.dll'), (New-Unread "$($app.ToUpper())\TOOLS\B.ZIP"), (New-Unread 'C:\Users\x\.config\z' 'list folder: UnauthorizedAccessException'))
    $sp = Split-UnreadFiles $un $strictRoots
    Assert-That 'unread: files under the spec folders (downloads included, any case, the root itself) fail the search' ($sp.Strict.Count -eq 4) "got $($sp.Strict.Count)"
    Assert-That 'unread: files in the extra places, and a folder that only starts with the same text, only warn' ($sp.Extra.Count -eq 3) "got $($sp.Extra.Count)"
    Assert-That 'unread: the reason travels with the path' ($sp.Extra[2].Reason -match 'UnauthorizedAccess' -and $sp.Strict[0].Reason -match 'in use')
    $sp = Split-UnreadFiles @() $strictRoots
    Assert-That 'unread: nothing unread is nothing to report' ($sp.Strict.Count -eq 0 -and $sp.Extra.Count -eq 0)
    $nr = @(Remove-NestedRoots @('C:\a\b', 'C:\a', 'C:\a\b\c\', 'D:\x', 'c:\A\', 'C:\ab'))
    Assert-That 'roots: a root inside another is dropped, a sibling that only shares the prefix is kept' ($nr.Count -eq 3 -and $nr -contains 'C:\a' -and $nr -contains 'D:\x' -and $nr -contains 'C:\ab') "got $($nr -join ' | ')"

    # ---- git config --get-all output: R-F006 ----
    Assert-That 'values: empty output is no value' ((ConvertTo-GitValueList '').Count -eq 0)
    Assert-That 'values: null output is no value' ((ConvertTo-GitValueList $null).Count -eq 0)
    $one = ConvertTo-GitValueList "`n"
    Assert-That 'values: a single empty line is one empty value' ($one.Count -eq 1 -and $one[0] -eq '')
    $two = ConvertTo-GitValueList "`n!'C:/x/bin/gh' auth git-credential`n"
    Assert-That 'values: the empty entry then the command' ($two.Count -eq 2 -and $two[0] -eq '' -and $two[1].StartsWith('!'))
    $crlf = ConvertTo-GitValueList "`r`n!'C:/x/bin/gh' auth git-credential`r`n"
    Assert-That 'values: CRLF lines' ($crlf.Count -eq 2 -and $crlf[0] -eq '' -and -not $crlf[1].EndsWith("`r"))
} finally {
    Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue
}

if ($script:Fails -gt 0) { Write-Host "$($script:Fails) FAIL"; exit 1 }
Write-Host 'all PASS'
