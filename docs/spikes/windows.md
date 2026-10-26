# Phase 0 spike: Windows

Run on 2026-10-25 and 26 in a Windows 11 ARM64 VM (UTM, 26H2, zh-TW), local account `測試PM`, so the home folder is `C:\Users\測試PM`. herdr has no ARM build, so herdr and Node ran as x64 under Windows' emulation. The kit is `spike/win/` (see its `RUNBOOK.md`); everything installs under `%LOCALAPPDATA%\straw-boss-desk` without admin rights.

The anchor is met: the straw-boss GUI ran in the VM's Edge against the VM's own herdr server and tower pi. A PM-style flow worked end to end on pi-straw-boss 0.43.0: "+ New base", a new CJK folder `部署測試` made in the picker, the deploy panel stepping through create, start, join, deliver, and a member pi that ran `pwd` and wrote `hello.txt` with bash in that folder. Claude login, a model turn, and a subagent also worked.

## Timings

| Step | Time |
| --- | --- |
| Bootstrap from a bare VM (Node, PortableGit, herdr, pi, ttt, playwriter, profile, 13 pi packages) | about 4 min; Git 70 s, playwriter 52 s, pi 37 s |
| herdr server start | 0.7 to 2 s |
| Tower pi ready | 10 s, 66 s on a cold restart |
| GUI up after `/boss gui` | 2 s on the best run; 85 s and three sends on the worst |
| Claude OAuth round trip | 53 s |
| A model turn | 28 s |

## What worked

- herdr 0.9.5 under emulation, with its named pipe built from a socket path under the CJK home folder.
- Node, git, bash, and pi on CJK folder and file names. No Defender blocks, no long-path errors (long paths were off; a 330-character path still wrote).
- The Claude Code executable bundled by the Agent SDK (`claude.exe`, win32-x64). Its credentials are a `.credentials.json` file in the app's config folder, not the Windows Credential Manager.
- Live chat, the terminal tile, `ask_user` in the GUI, and Traditional Chinese input.
- herdr reports `terminal_id` and `agent_session` (the session file path) for each pane, which the 0.43.0 restore relies on.

## Findings

| Finding | Handled |
| --- | --- |
| Panes herdr opens rebuild `PATH` from the registry, so they could not find pi, herdr, or git; "+ New base" and the intercom broker failed with it (members showed as not live) | the kit adds `tools\npm`, herdr, and git to the user `PATH` (HKCU) and keeps a `node.exe` beside the npm shims. Report to herdr: keep the server's `PATH` on Windows |
| pi looks for bash only in `Program Files\Git` | `shellPath` in pi's `settings.json` points at PortableGit's `bash.exe` |
| Windows ships a `python3` stub that opens the Store; pi-aaaav appended "Validator did not run" to every write and edit | pi-aaaav 1.3.4 validates in TypeScript |
| After a herdr restart every straw-boss session came back as a member, so each start opened another tower | pi-straw-boss 0.43.0 restores tower and main roles |
| The tower card's close button navigated instead of asking | fixed in pi-straw-boss 0.43.0 |
| The folder picker lists the home's hidden and system folders (AppData, Cookies, NetHood, Start Menu) | pi-straw-boss, in progress |
| `gui.json` has no `started` on Windows, since there is no `ps` | upstream seam |
| `/boss gui` typed into the tower was sometimes swallowed; it took up to three sends | desk mode (open the GUI at start) |
| Members do not join the net without `herdr integration install pi` | the kit runs it; pi-straw-boss should say so or run it |
| pi-intercom reads both `HERDR_BIN` and `HERDR_BIN_PATH` | report upstream |
| pi downloads fd and ripgrep on its first start | the wizard should install them |
| PowerShell 5.1 reads BOM-less UTF-8 as Big5 | the shell writes files with Node or with a BOM |
| WARP on the host blocked the VM's outbound TCP | test-setup only |
| The VM's network was "Public"; OpenSSH's firewall rule is Private only | test-setup only |
| scp refuses to fetch files whose path has the CJK user name | test-setup only |

## Agent behavior to cover in the team profile

- An agent typed PowerShell (`Set-Content`) into bash: the profile must say the shell is bash on Windows.
- An agent once changed to the parent folder and committed there: the profile must keep work inside the base's folder.

## Not done

SmartScreen and electron-updater with the 0.0.1 and 0.0.2 installers, DPAPI `safeStorage`, and the GitHub, GitLab, and ttt account checks. The kit has them; they move to phase 2, where the real shell is built.
