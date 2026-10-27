---
description: "The shell is bash, on Windows too"
condition: '(?:^|[\n;(\x60{]|&&|\s\|\|?|\|\|?\s|\b(?:then|do|else)\s)[ \t\r]*(?=((?:(?:[A-Za-z_][A-Za-z0-9_]*=(?:[^\s;&|(){}<>\x60"\x27$]|\$(?![{(])|\$\{[^\s{}]{0,100}\}|\$\([^()\n]{0,100}\)|"[^"\n]{0,200}"|\x27[^\x27\n]{0,200}\x27){0,200}|env|command|sudo|time|exec|nohup)(?:[ \t]+-[A-Za-z-]{1,40}){0,6}[ \t]+){0,8}))\1(?:(?:Add|Approve|Assert|Backup|Block|Checkpoint|Clear|Close|Compare|Complete|Compress|Confirm|Connect|Convert|ConvertFrom|ConvertTo|Copy|Debug|Deny|Disable|Disconnect|Dismount|Edit|Enable|Enter|Exit|Expand|Export|Find|Format|Get|Grant|Group|Hide|Import|Initialize|Install|Invoke|Join|Limit|Lock|Measure|Merge|Mount|Move|New|Open|Optimize|Out|Ping|Pop|Protect|Publish|Push|Read|Receive|Redo|Register|Remove|Rename|Repair|Request|Reset|Resize|Resolve|Restart|Restore|Resume|Revoke|Save|Search|Select|Send|Set|Show|Skip|Sort|Split|Start|Step|Stop|Submit|Suspend|Switch|Sync|Tee|Test|Trace|Unblock|Undo|Uninstall|Unlock|Unprotect|Unpublish|Unregister|Update|Use|Wait|Watch|Write|ForEach|Where)-[A-Z][A-Za-z0-9]+\b)|(?:\|\|?|&)[ \t\r]*(?=[A-Za-z\\/.~$"\x27_])(?=((?:(?:[A-Za-z_][A-Za-z0-9_]*=(?:[^\s;&|(){}<>\x60"\x27$]|\$(?![{(])|\$\{[^\s{}]{0,100}\}|\$\([^()\n]{0,100}\)|"[^"\n]{0,200}"|\x27[^\x27\n]{0,200}\x27){0,200}|env|command|sudo|time|exec|nohup)(?:[ \t]+-[A-Za-z-]{1,40}){0,6}[ \t]+){0,8}))\2(?:(?:Add|Approve|Assert|Backup|Block|Checkpoint|Clear|Close|Compare|Complete|Compress|Confirm|Connect|Convert|ConvertFrom|ConvertTo|Copy|Debug|Deny|Disable|Disconnect|Dismount|Edit|Enable|Enter|Exit|Expand|Export|Find|Format|Get|Grant|Group|Hide|Import|Initialize|Install|Invoke|Join|Limit|Lock|Measure|Merge|Mount|Move|New|Open|Optimize|Out|Ping|Pop|Protect|Publish|Push|Read|Receive|Redo|Register|Remove|Rename|Repair|Request|Reset|Resize|Resolve|Restart|Restore|Resume|Revoke|Save|Search|Select|Send|Set|Show|Skip|Sort|Split|Start|Step|Stop|Submit|Suspend|Switch|Sync|Tee|Test|Trace|Unblock|Undo|Uninstall|Unlock|Unprotect|Unpublish|Unregister|Update|Use|Wait|Watch|Write|ForEach|Where)-[A-Z][A-Za-z0-9]+)\b(?=[\s;&|)]|$)|(?<!\x27)\$env:[A-Za-z_]'
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
  - ls | Select-Object -First 3
  - Get-Process | Sort-Object CPU
  - Expand-Archive a.zip -DestinationPath out
  - Invoke-Expression $cmd
  - x=1 Get-ChildItem
  - sudo Remove-Item a
  - time Measure-Object
  - env FOO=1 Join-Path a b
  - Set-Item -Path env:X -Value 1
  - "git status\nGet-ChildItem"
  - ls|Get-ChildItem
  - ls |Select-Object -First 1
  - ls&Get-Date
  - sleep 1 & Get-Process
  - echo hi| Where-Object x
  - X=${HOME} Get-ChildItem
  - X=$(pwd) Get-ChildItem
  - FOO="a b" Get-ChildItem
  - X='a b' Get-ChildItem
allows:
  - printf 'hi\n' > a.txt
  - grep -rn 'Set-Content' scripts/
  - powershell.exe -NoProfile -Command "Get-ChildItem C:/"
  - echo "$HOME"
  - grep -n 'env:PATH' setup.ps1
  - grep -n '$env:PATH' setup.ps1
  - rg 'Remove-Item|Test-Path' .
  - git commit -m 'docs: explain Set-Content usage'
  - powershell.exe -NoProfile -Command '$env:PATH'
  - grep -c Get-Process setup.ps1
  - ls | sort
  - curl -H 'Set-Cookie: a=b' https://example.com
  - grep -E 'Get-Date|Get-Item' notes.txt
  - grep -c 'a&Get-Date' notes.txt
  - ls > out.txt 2>&1
  - sleep 1 & echo done
falsePositives:
  - echo 'a; Get-ChildItem'
  - grep -n 'path $env:PATH' x.ps1
  - "git commit -m \"docs: notes\nGet-Content is slow\""
  - "cat > a.ps1 <<'EOF'\nWrite-Host hi\nEOF"
  - "cat > notes.md <<'EOF'\nGet-Started with the app\nEOF"
  - grep -E 'a|Get-Date -x' notes.txt
---

This shell is bash (Git Bash on Windows), not PowerShell: PowerShell commands fail here or do something else.

Use POSIX commands instead: `printf '...' > file` or the `write` tool instead of `Set-Content`, `ls` instead of `Get-ChildItem`, `"$HOME"` or `"$USERPROFILE"` instead of `$env:USERPROFILE`, `rm` instead of `Remove-Item`, `test -e` instead of `Test-Path`.

If a step truly needs PowerShell, call it explicitly: `powershell.exe -NoProfile -Command '...'`.

To search PowerShell text in files, use the `grep` tool, or run `grep` with the cmdlet name in quotes and without the leading dollar sign of `$env:`. A command that merely mentions a cmdlet at the start of a line or after `;` is blocked even inside quotes, so keep such text out of `echo`, out of heredoc bodies, and out of the lines of a multi-line commit message.
