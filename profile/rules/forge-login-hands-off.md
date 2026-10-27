---
description: "Agents never touch the code-host login"
condition: '(?:^|[\n;(\x60{]|&&|\s\|\|?|\|\|?\s|\b(?:then|do|else)\s)[ \t\r]*(?=((?:(?:[A-Za-z_][A-Za-z0-9_]*=(?:[^\s;&|(){}<>\x60"\x27$]|\$(?![{(])|\$\{[^\s{}]{0,100}\}|\$\([^()\n]{0,100}\)|"[^"\n]{0,200}"|\x27[^\x27\n]{0,200}\x27){0,200}|(?:env|command|sudo|time|exec|nohup|nice)(?:[ \t]+-[A-Za-z-]{1,40}(?:[ \t]+(?!(?:env|command|sudo|time|exec|nohup|nice|gh|glab|git|security)\b)[^\s=;&|(){}<>\x60-][^\s=;&|(){}<>\x60]{0,200})?){0,6})[ \t]+|(?:eval|(?:ba|z|da)?sh[ \t]+-[A-Za-z]*c)[ \t]+["\x27]?){0,8}))\1(?:["\x27\\]?(?:[^\s"\x27;&|(){}<>\x60]{0,200}/)?(?:[Gg][Hh]|[Gg][Ll][Aa][Bb])(?:\.[eE][xX][eE])?["\x27]?\s+auth\s+(?:token|login|logout|refresh|switch|git-credential)\b|["\x27\\]?(?:[^\s"\x27;&|(){}<>\x60]{0,200}/)?(?:[Gg][Hh]|[Gg][Ll][Aa][Bb])(?:\.[eE][xX][eE])?["\x27]?\s+auth\s+status\b[^\n;&|({\x60]{0,200}\s(?:-[A-Za-su-z]*t[A-Za-z]*|--show-token)(?=[\s=;&|<>)]|$)|["\x27\\]?(?:[^\s"\x27;&|(){}<>\x60]{0,200}/)?(?:[Gg][Hh]|[Gg][Ll][Aa][Bb])(?:\.[eE][xX][eE])?["\x27]?\s+config\s+get\b[^\n;&|({\x60]{0,200}\s(?:token|oauth_token)\b|(?:cat|less|more|head|tail|grep)[ \t]+[^\n;&|({\x60]{0,200}(?:hosts\.yml|[Gg][Ll][Aa][Bb][^\s;&|]{0,40}config\.yml)\b|["\x27]?(?:[^\s"\x27;&|(){}<>\x60]{0,200}/)?git["\x27]?(?:[ \t]+(?:(?:-C|-c)[ \t]+[^\s;&|(){}<>\x60]{1,200}|--no-pager|-P|--paginate|--no-optional-locks))*\s+credential(?:-[a-z]+)*(?:\.[eE][xX][eE])?\s+(?:fill|get)\b|["\x27]?(?:[^\s"\x27;&|(){}<>\x60]{0,200}/)?git-credential-[^\s;&|(){}<>\x60]{1,100}\s+get\b|["\x27]?(?:[^\s"\x27;&|(){}<>\x60]{0,200}/)?security["\x27]?\s+find-(?:generic|internet)-password\b[^\n;&|({\x60]{0,200}\s-[A-Za-fh-vx-z]*[wg][A-Za-z]*(?=\s|$))|(?:\|\|?|&)[ \t\r]*(?=[A-Za-z\\/.~$"\x27_])(?=((?:(?:[A-Za-z_][A-Za-z0-9_]*=(?:[^\s;&|(){}<>\x60"\x27$]|\$(?![{(])|\$\{[^\s{}]{0,100}\}|\$\([^()\n]{0,100}\)|"[^"\n]{0,200}"|\x27[^\x27\n]{0,200}\x27){0,200}|(?:env|command|sudo|time|exec|nohup|nice)(?:[ \t]+-[A-Za-z-]{1,40}(?:[ \t]+(?!(?:env|command|sudo|time|exec|nohup|nice|gh|glab|git|security)\b)[^\s=;&|(){}<>\x60-][^\s=;&|(){}<>\x60]{0,200})?){0,6})[ \t]+|(?:eval|(?:ba|z|da)?sh[ \t]+-[A-Za-z]*c)[ \t]+["\x27]?){0,8}))\2(?:["\x27\\]?(?:[^\s"\x27;&|(){}<>\x60]{0,200}/)?(?:[Gg][Hh]|[Gg][Ll][Aa][Bb])(?:\.[eE][xX][eE])?["\x27]?\s+auth\s+(?:token|login|logout|refresh|switch|git-credential)\b|["\x27\\]?(?:[^\s"\x27;&|(){}<>\x60]{0,200}/)?(?:[Gg][Hh]|[Gg][Ll][Aa][Bb])(?:\.[eE][xX][eE])?["\x27]?\s+auth\s+status\b[^\n;&|({\x60]{0,200}\s(?:-[A-Za-su-z]*t[A-Za-z]*|--show-token)(?=[\s=;&|<>)]|$)|["\x27\\]?(?:[^\s"\x27;&|(){}<>\x60]{0,200}/)?(?:[Gg][Hh]|[Gg][Ll][Aa][Bb])(?:\.[eE][xX][eE])?["\x27]?\s+config\s+get\b[^\n;&|({\x60]{0,200}\s(?:token|oauth_token)\b|(?:cat|less|more|head|tail|grep)[ \t]+[^\n;&|({\x60]{0,200}(?:hosts\.yml|[Gg][Ll][Aa][Bb][^\s;&|]{0,40}config\.yml)\b|["\x27]?(?:[^\s"\x27;&|(){}<>\x60]{0,200}/)?git["\x27]?(?:[ \t]+(?:(?:-C|-c)[ \t]+[^\s;&|(){}<>\x60]{1,200}|--no-pager|-P|--paginate|--no-optional-locks))*\s+credential(?:-[a-z]+)*(?:\.[eE][xX][eE])?\s+(?:fill|get)\b|["\x27]?(?:[^\s"\x27;&|(){}<>\x60]{0,200}/)?git-credential-[^\s;&|(){}<>\x60]{1,100}\s+get\b|["\x27]?(?:[^\s"\x27;&|(){}<>\x60]{0,200}/)?security["\x27]?\s+find-(?:generic|internet)-password\b[^\n;&|({\x60]{0,200}\s-[A-Za-fh-vx-z]*[wg][A-Za-z]*(?=\s|$))(?=[\s;&|)]|$)'
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
  - a|gh auth token
  - ls | gh auth token
  - a & gh auth token
  - a&glab auth token
  - \gh auth token
  - env -u X gh auth token
  - sudo -u root gh auth token
  - env -i -u X FOO=1 glab auth token
  - bash -c 'gh auth token'
  - bash -lc "glab auth token"
  - eval 'gh auth token'
  - gh.EXE auth token
  - C:/tools/glab.Exe auth token
  - gh auth status --show-token=true
  - git --no-pager credential fill
  - git -P -c credential.helper= credential fill
  - git credential-manager.exe get
  - git-credential-manager.exe get
  - glab config get token
  - gh config get oauth_token
  - glab config get --host g.example token
  - cat ~/.config/glab-cli/config.yml
  - cat $GLAB_CONFIG_DIR/config.yml
  - less ~/.config/gh/hosts.yml
  - head -n 3 ~/.config/gh/hosts.yml
  - tail -f hosts.yml
  - grep oauth_token ~/.config/gh/hosts.yml
  - X=${HOME} gh auth token
  - GH_CONFIG_DIR=${XDG_CONFIG_HOME}/gh gh auth token
  - X=$(pwd) gh auth token
  - FOO="a b" gh auth token
  - nice -n 5 gh auth token
  - GH auth token
  - Gh.exe auth token
  - gh auth status -t; echo done
  - gh auth status -t | cat
  - gh auth status -t > out.txt
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
  - gh config get git_protocol
  - glab config get host
  - gh pr list | head -n 3
  - grep -c 'x|gh auth token' notes.txt
  - cat README.md
  - grep -n hosts docs/notes.txt
  - ls > out.txt 2>&1
falsePositives:
  - cat docs/hosts.yml
  - grep -rn 'login' docs/hosts.yml
---

The code-host login belongs to the app. Do not print it, read it, or log in or out.

`gh auth status` and `glab auth status` (without `-t`) are enough to see whether a login works. When one is missing or rejected, tell the PM to open the app's settings and sign in to the code host again.
