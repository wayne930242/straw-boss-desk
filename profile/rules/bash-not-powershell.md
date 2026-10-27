---
description: "The shell is bash, on Windows too"
condition: '(?:^|[\n;(`{]|&&|\|\|?|\b(?:then|do|else)\s)\s*(?:Set-Content|Add-Content|Get-Content|Out-File|Get-ChildItem|Get-Item|New-Item|Remove-Item|Copy-Item|Move-Item|Rename-Item|Test-Path|Select-String|Write-Host|Write-Output|Invoke-WebRequest|Invoke-RestMethod|Start-Process|ForEach-Object|Where-Object|Set-Location)\b|\$env:[A-Za-z_]'
scope: "tool:bash"
repeatMode: after-gap
repeatGap: 1
blocks:
  - Set-Content -Path a.txt -Value hi
  - cd src; Get-ChildItem
  - echo $env:USERPROFILE
  - ls | Where-Object { $_.Name }
  - if true; then Remove-Item a; fi
  - git status && Test-Path a
allows:
  - printf 'hi\n' > a.txt
  - grep -rn 'Set-Content' scripts/
  - powershell.exe -NoProfile -Command "Get-ChildItem C:/"
  - echo "$HOME"
  - grep -n 'env:PATH' setup.ps1
  - git commit -m 'docs: explain Set-Content usage'
---

This shell is bash (Git Bash on Windows), not PowerShell: PowerShell commands fail here or do something else.

Use POSIX commands instead: `printf '...' > file` or the `write` tool instead of `Set-Content`, `ls` instead of `Get-ChildItem`, `"$HOME"` or `"$USERPROFILE"` instead of `$env:USERPROFILE`, `rm` instead of `Remove-Item`, `test -e` instead of `Test-Path`.

If a step truly needs PowerShell, call it explicitly: `powershell.exe -NoProfile -Command '...'`.
