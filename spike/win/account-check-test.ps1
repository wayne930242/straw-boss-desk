<#
.SYNOPSIS
  Offline tests of the decisions account-check.ps1 makes (lib\account-verdict.ps1): when a login counts as a plain-text token and is logged out, when it is only
  "could not verify", how the token search treats unread files, and how git config output is split. No CLI, no network, no login, no Credential Manager.
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

    # ---- Get-PlainTokenLines ----
    $ghKeyring = New-Fixture 'gh-keyring.yml' "github.com:`n    git_protocol: https`n    users:`n        someone:`n    user: someone`n"
    $ghPlain = New-Fixture 'gh-plain.yml' "github.com:`n    oauth_token: fake_token_value_1`n    user: someone`n"
    $ghNested = New-Fixture 'gh-nested.yml' "github.com:`n    users:`n        someone:`n            oauth_token: `"fake_token_value_2`"`n"
    $ghEmpty = New-Fixture 'gh-empty.yml' "github.com:`n    oauth_token:`n"
    $glabPlain = New-Fixture 'glab-plain.yml' "hosts:`n  gitlab.example.org:`n    token: fake_token_value_3 # note`n    api_host: gitlab.example.org`n"
    $glabNull = New-Fixture 'glab-null.yml' "hosts:`n  gitlab.example.org:`n    token: !!null`n"
    $glabNone = New-Fixture 'glab-none.yml' "hosts:`n  gitlab.example.org:`n    api_host: gitlab.example.org`n"
    Assert-That 'tokens: gh keyring file has none' (@(Get-PlainTokenLines $ghKeyring 'oauth_token').Count -eq 0)
    Assert-That 'tokens: gh plain text is found' (@(Get-PlainTokenLines $ghPlain 'oauth_token').Count -eq 1)
    Assert-That 'tokens: gh nested and quoted is found' (@(Get-PlainTokenLines $ghNested 'oauth_token').Count -eq 1)
    Assert-That 'tokens: gh empty value is not a token' (@(Get-PlainTokenLines $ghEmpty 'oauth_token').Count -eq 0)
    Assert-That 'tokens: glab plain text with a comment is found' (@(Get-PlainTokenLines $glabPlain 'token').Count -eq 1)
    Assert-That 'tokens: glab !!null is not a token' (@(Get-PlainTokenLines $glabNull 'token').Count -eq 0)
    Assert-That 'tokens: glab without a token line has none' (@(Get-PlainTokenLines $glabNone 'token').Count -eq 0)
    Assert-That 'tokens: a missing file has none' (@(Get-PlainTokenLines (Join-Path $dir 'nope.yml') 'token').Count -eq 0)
    $leak = (Get-PlainTokenLines $ghPlain 'oauth_token') -join ' '
    Assert-That 'tokens: only the key is reported, never the value' ($leak -notmatch 'fake_token_value')

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
    $v = Get-GhTokenVerdict -Source 'keyring' -HostsTokens @(Get-PlainTokenLines $ghPlain 'oauth_token').Count -ConfigTokens 0
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
    $v = Get-GlabTokenVerdict -ConfigTokens @(Get-PlainTokenLines $glabPlain 'token').Count -StatusExit 0
    Assert-That 'glab: a token in a real fixture file decides it' ($v.Plain)

    # ---- the token search's unread files: R-F005 ----
    $dl = 'C:\Users\x\AppData\Local\straw-boss-desk\tools\downloads'
    $sp = Split-SkippedPaths @("$dl\node.zip", 'C:\Users\x\AppData\Local\straw-boss-desk\logs\locked.log', "$dl", 'C:\Users\x\AppData\Local\straw-boss-desk\tools\downloads-old\a.bin', "$($dl.ToUpper())\B.ZIP") $dl
    Assert-That 'unread: files under downloads only warn (case-insensitive)' ($sp.InDownloads.Count -eq 3) "got $($sp.InDownloads.Count)"
    Assert-That 'unread: a file elsewhere, and a folder that only starts with the same text, are failures' ($sp.Elsewhere.Count -eq 2) "got $($sp.Elsewhere.Count)"
    $sp = Split-SkippedPaths @() $dl
    Assert-That 'unread: nothing unread is nothing to report' ($sp.InDownloads.Count -eq 0 -and $sp.Elsewhere.Count -eq 0)

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
