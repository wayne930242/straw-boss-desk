---
description: "Agents never touch the code-host login"
condition: '(?:^|[\n;(\x60{]|&&|\s\|\|?|\|\|?\s|\b(?:then|do|else)\s)[ \t\r]*(?:(?:[A-Za-z_][A-Za-z0-9_]*=\S*|env|command|sudo|time|exec|nohup)(?:\s+-[A-Za-z-]+)*\s+)*(?:["\x27]?(?:[^\s"\x27;&|()<>\x60]*/)?(?:gh|glab)(?:\.exe)?["\x27]?\s+auth\s+(?:token|login|logout|refresh|switch|git-credential)\b|["\x27]?(?:[^\s"\x27;&|()<>\x60]*/)?(?:gh|glab)(?:\.exe)?["\x27]?\s+auth\s+status\b[^\n;&|]*\s(?:-[A-Za-z]*t[A-Za-z]*|--show-token)(?=\s|$)|["\x27]?(?:[^\s"\x27;&|()<>\x60]*/)?git["\x27]?(?:\s+(?:-C|-c)\s+\S+)*\s+credential(?:-[a-z]+)*\s+(?:fill|get)\b|["\x27]?(?:[^\s"\x27;&|()<>\x60]*/)?git-credential-\S+\s+get\b|["\x27]?(?:[^\s"\x27;&|()<>\x60]*/)?security["\x27]?\s+find-(?:generic|internet)-password\b[^\n;&|]*\s-[A-Za-z]*[wg][A-Za-z]*(?=\s|$))'
scope: "tool:bash"
repeatMode: after-gap
repeatGap: 1
blocks:
  - gh auth token
  - GH_HOST=x gh auth token | cat
  - gh auth status -t
  - glab auth status --show-token
  - glab auth login --hostname g.example
  - gh auth logout
  - printf 'protocol=https\nhost=github.com\n\n' | git credential fill
  - git credential-manager get
  - glab auth git-credential get
  - tools/bin/gh auth token
  - "$X/gh" auth token
  - /Users/a/tools/bin/glab auth token
  - env GH_HOST=x gh auth token
  - command gh auth token
  - gh auth status -th github.com
  - gh auth status --hostname github.com -t
  - git credential-manager-core get
  - git credential-osxkeychain get
  - git-credential-manager get
  - git-credential-osxkeychain get
  - git -c credential.helper= credential fill
  - security find-generic-password -s gh:github.com -w
  - security find-internet-password -s github.com -g
allows:
  - gh auth status
  - glab auth status --hostname g.example
  - gh pr create --title 'auth token refresh fix' --body-file b.md
  - grep -rn 'gh auth token' docs/
  - git commit -m 'fix: token refresh'
  - gh auth status --hostname github.com
  - security find-identity -v
  - git credential approve
  - gh pr view 1 --json state
  - echo gh auth token
---

The code-host login belongs to the app. Do not print it, read it, or log in or out.

`gh auth status` and `glab auth status` (without `-t`) are enough to see whether a login works. When one is missing or rejected, tell the PM to open the app's settings and sign in to the code host again.
