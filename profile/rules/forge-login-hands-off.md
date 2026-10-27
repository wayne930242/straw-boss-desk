---
description: "Agents never touch the code-host login"
condition: '(?:^|[\n;(`{]|&&|\|\|?|\b(?:then|do|else)\s)\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*(?:(?:gh|glab)(?:\.exe)?\s+auth\s+(?:token|login|logout|refresh|switch|git-credential)\b|(?:gh|glab)(?:\.exe)?\s+auth\s+status\b[^\n;&|]*\s(?:-t|--show-token)\b|git(?:\s+-C\s+\S+)*\s+credential(?:-[a-z]+)?\s+(?:fill|get)\b)'
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
allows:
  - gh auth status
  - glab auth status --hostname g.example
  - gh pr create --title 'auth token refresh fix' --body-file b.md
  - grep -rn 'gh auth token' docs/
  - git commit -m 'fix: token refresh'
---

The code-host login belongs to the app. Do not print it, read it, or log in or out.

`gh auth status` and `glab auth status` (without `-t`) are enough to see whether a login works. When one is missing or rejected, tell the PM to open the app's settings and sign in to the code host again.
