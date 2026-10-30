# Windows spike runbook

One session in a Windows 11 ARM64 VM (UTM), then the VM is deleted.
The user profile has a Chinese name, for example `C:\Users\測試PM`.
PMs use x64 laptops, so everything installs as x64 and runs under Windows-on-ARM x64 emulation.
`-Arch arm64` exists for Node and Git only; herdr has no arm64 Windows build.

Total budget: about 2.5 to 3 hours, of which about 45 minutes need the author at the VM display.

## What is in the kit

All paths are relative to `spike/win/` in the repository.

| File | Purpose |
| --- | --- |
| `pins.json` | Every download pinned by version and SHA256; npm packages by version and registry integrity |
| `lib.ps1` | Shared helpers (paths, JSON-lines log, `Invoke-Native`, env isolation) |
| `bootstrap.ps1` | Node, PortableGit, herdr, pi, ttt, playwriter, team profile, 13 pi packages. No admin. Resumable |
| `start.ps1` / `stop.ps1` | Headless herdr server, then `cli.mjs up --dir` (integration, sb server, home base with its tower, GUI); stops only what it recorded |
| `checks.ps1` | The unattended checks, results in `results\checks-*.json` |
| `desk-b7-check.ps1` | Desk B7 acceptance A0, A1, A3 to A7 and A9 (docs/specs/2026-10-28-desk-b7.md); ran in the VM 2026-10-28, report in `~/.local/share/sbd-review/desk-b7-now/report.md`. `-Only A5d` runs one injection |
| `npm-stale-check.ps1` | What `bootstrap.ps1` says for a pinned npm package when the registry is down and npm's cache holds an old package list (VM 2026-10-30: E404 for `pi-straw-boss@0.48.0`, which exists). Works in a scratch `SBD_ROOT` with a stand-in registry (`lib\npm-stale-fixture.mjs`); needs no network; PASS/FAIL lines |
| `check-claude.ps1`, `check-github.ps1`, `check-gitlab.ps1`, `check-ttt.ps1` | Account checks, run with the author present |
| `ui-run.ps1`, `shot.ps1` | Start a program on the interactive desktop from SSH; desktop screenshot |
| `lib\gui-client.mjs`, `lib\cdp-eval.mjs` | Test clients: the GUI's HTTP surface (takes `SB_DIR`, a `gui.json`, or `auto`); a window read over CDP (token-free output) |
| `collect.ps1` | Zip logs, results, and screenshots without credentials |
| `proto/` | Electron prototype (TypeScript): starts the stack through `start.ps1`, follows the GUI through a rotation (`src/follow.ts`); `proto/scripts/build-installers.mjs` builds 0.0.1 and 0.0.2 |
| `serve-feed.sh`, `pack-kit.sh` | Mac side: serve the update feed, zip the kit |

Everything the kit installs lives in `%LOCALAPPDATA%\straw-boss-desk`: `tools\` (Node, Git, herdr, npm prefix), `agent\` (the private `PI_CODING_AGENT_DIR`), `config\` (the private `XDG_CONFIG_HOME`; herdr's config, session and socket are in `config\herdr\`), `claude\` (private `CLAUDE_CONFIG_DIR`), `logs\`, `results\`, `state\`.
Git configuration is a private file (`GIT_CONFIG_GLOBAL`), so the user's own Git setup is untouched.
The folder panes start in is `%USERPROFILE%\sbd-playground`, which keeps the Chinese profile name in every path.

## Variables used below

- `VM`: the SSH target, for example `測試PM@192.168.64.x`.
- `KIT`: `%USERPROFILE%\sbd-kit` in the VM.
- `MAC`: `192.168.64.1`, the Mac as seen from the VM; the feed port is `8099`.
- `PS`: `powershell -NoProfile -ExecutionPolicy Bypass -File`.

Run every `.ps1` over SSH as `ssh VM "powershell -NoProfile -ExecutionPolicy Bypass -File <path>"`.
If the SSH default shell is `cmd`, `%USERPROFILE%` expands; if it is PowerShell, use `$env:USERPROFILE`.
Run `ssh VM "echo %USERPROFILE%"` once and write the literal path down.

## Step 0: Mac preparation (10 minutes, before the author sits down)

1. Build the installers if `spike/win/out/feed/` is missing: `cd spike/win/proto && npm ci && node scripts/build-installers.mjs` (a few minutes; downloads Electron and the NSIS toolset once).
2. Zip the kit: `spike/win/pack-kit.sh` writes `spike/win/out/sbd-kit.zip`.
3. Start the feed with `MonitorCreate`: `spike/win/serve-feed.sh 8099`. Record the monitor id; stop it in step 11.
   The Python server has no HTTP range support, so electron-updater falls back to a full download of about 120 MB. That is expected.
4. Take a UTM snapshot of the clean VM if it is cheap. A failed bootstrap can then be retried from clean.
5. Confirm from the VM that the feed answers: `ssh VM "curl.exe -sI http://192.168.64.1:8099/latest.yml"` returns `200`.

## Step 1: copy the kit in (2 minutes)

```bash
scp spike/win/out/sbd-kit.zip VM:sbd-kit.zip
ssh VM "mkdir sbd-kit && tar -xf sbd-kit.zip -C sbd-kit"
ssh VM "dir sbd-kit"
```

Expected: `bootstrap.ps1`, `lib.ps1`, `pins.json`, `lib\`.
If `scp` fails on the Chinese user name, record that as a finding and fall back to the UTM shared folder or `curl.exe` from the feed server.

## Step 2: bootstrap (10 to 25 minutes)

```bash
ssh VM "powershell -NoProfile -ExecutionPolicy Bypass -File %USERPROFILE%\sbd-kit\bootstrap.ps1"
```

Stages and rough time under emulation: Node 1 minute, Git 2, herdr 0.5, pi 2, ttt 1, playwriter 2, profile 0, then 13 pi packages at about 40 to 90 seconds each.
`pi-lens` is the slowest (native ast-grep binaries).
The script prints a table and exits 1 if any stage failed; the per-stage JSON is in `%LOCALAPPDATA%\straw-boss-desk\logs\bootstrap.jsonl`.

If a stage fails, read its line in `bootstrap.jsonl` (the `fsErrors` field lists EPERM, ENAMETOOLONG, and locked-file lines), then run the script again: verified stages are skipped.
Use `-Only pkg:pi-lens -Force` to retry one stage.

Every npm step asks the registry for fresh package metadata (`NPM_CONFIG_PREFER_ONLINE=true`, set by `Set-SbdEnv`), because npm trusts a cached copy for 5 minutes and, when the registry does not answer, uses it: a pin published after that copy fails as "not found" (VM 2026-10-30: three ETIMEDOUT, then E404 for `pi-straw-boss@0.48.0`, which exists).
When a pinned npm step still fails on the network or with "no such version", its message starts with the plain sentence "The npm registry could not be reached or is out of date, so <name>@<version> was not installed. Check the network and run this again; nothing was installed in its place.", followed by the technical detail. Nothing falls back to another version. `npm-stale-check.ps1` reproduces it without a network.

What this step records without any extra work:

- Per-stage timing and the Windows Defender or long-path symptoms (`fsErrors`, slow stages).
- Whether PortableGit contains Git Credential Manager (`GitCredentialManagerIncluded=` in the git stage evidence). From the release file listing it does: `ucrt64\bin\git-credential-manager.exe`.
- Which herdr, Node, and Git versions ran, and `node.arch` (expected `x64`).

## Step 3: start the stack (under 20 s to the URL)

```bash
ssh VM "powershell -NoProfile -ExecutionPolicy Bypass -File %USERPROFILE%\sbd-kit\start.ps1"
```

Expected lines: `GUI_URL=http://127.0.0.1:<port>/<token>/` and `SB_DIR=<slot folder>`, printed as soon as the sb server's GUI answers (the 0.46.0 pass measured `up` alone at 22 to 37 ms for the GUI step), then possibly `NOTICE=<text>` lines.
The URL holds the page token: it is printed there only, never logged, and `start.json` does not keep it.
Both scripts write their stdout as UTF-8 (`[Console]::OutputEncoding`); a piped Windows console writes the OEM code page, which turned the profile's non-ASCII folder name in `SB_DIR` into U+FFFD, and the app's follower then could not open the slot folder. A reader must decode UTF-8 (`Get-Content -Encoding UTF8` for a redirected file).
`start.ps1` runs in this order (desk B7 plan, **Start order, after the B6 + B7 release**):

1. `herdr server` with the kit's private socket and config. It is started through ShellExecute (no `-RedirectStandard*`), so it inherits none of the caller's pipes. A recorded herdr server is reused only when its pid and start time match **and** `start.json` records the same environment fingerprint (`desk`, socket, `XDG_CONFIG_HOME`, agent dir); another fingerprint, or a herdr that answers without a record, stops the start with exit 3 (run `stop.ps1`).
2. Herdr's pi integration, the sb server, the home base with its tower, and the GUI: `node <agent dir>\npm\node_modules\pi-straw-boss\dist\server\cli.mjs up --dir "%USERPROFILE%\Straw Boss" --label "Straw Boss" --timeout 120 --exact`. The home base folder is visible and under home; `start.ps1` makes it when it is missing, since `up --dir` only checks it. The environment is the kit's (`STRAW_BOSS_DESK=1`, `XDG_CONFIG_HOME`, `HERDR_SOCKET_PATH`, `PI_CODING_AGENT_DIR`), the same for herdr and every `cli.mjs` call. `up`'s steps are `herdr`, `integration`, `version`, `server`, `base`, `tower`, `gui`. The URL is `up`'s own answer; no file is read. The pid, start time (`started` from the answer, else the process's own), `log`, and the slot folder go into `state\start.json` (`sbServerPid`, `sbServerStart`, `sbServerLog`, `sbDir`, `sbServerRecord`), and so do the desk steps' answers: `workspaceId`, `paneId` (the base's pane), `tower`, `created` (this run made the base or the tower), `integration` (`installed`, `current`, ...) and `baseDir`. The slot folder must be `<agent dir>\straw-boss` itself (the primary slot); anything else is exit 22.
3. `GUI_URL=` and `SB_DIR=` are printed.

There is no tower step in `start.ps1` any more: the server makes the tower, and a restart restores it. Workspaces are not closed at stop, so Herdr restores the base, and the next `up --dir` finds it (`created: false`) and opens no new tab. Bootstrap no longer has a Herdr integration stage: `up --dir` installs it (`integration: installed`, warning `integration_installed`, logged only), and a pi started without it warns once after 20 s.

The kit's `XDG_CONFIG_HOME` is `%LOCALAPPDATA%\straw-boss-desk\config` and herdr's socket is its default under it (`config\herdr\herdr.sock`), so the sb server is the **primary** server of this environment: it holds Straw Link, and its files (`server.json`, `gui.json`, `server.log`, `server.lock`, `start-error.json`) are in `<agent dir>\straw-boss\` itself, with no `servers\<hash>\` folder.
Nothing is written under the user's own `%APPDATA%\herdr`.

`start.ps1` handles `up`'s exits as the plan's table says: `wait: lock`, `hello`, and `exit` get one more `up`, and so does a busy `base` (another `up --dir` held `desk.lock`); step `herdr` gets one more look at herdr (not for a socket mismatch); step `version` (`--exact`: a newer server) runs `cli.mjs restart --downgrade --reason "stack.json pin"` and retries once; exit 3 with `loader` or `intercom` reinstalls `pkg:pi-straw-boss` or `pkg:pi-intercom` through `bootstrap.ps1 -Only ... -Force` and retries once. Nothing else is retried.
Exit codes of `start.ps1`: 0 done; 2 a tool is missing (run bootstrap); 3 a stack from another start is running, or a herdr answers that `start.json` does not record (run stop first); 4 herdr server silent; `up` failed: 10 `wait: lock`, 11 `wait: start`, 12 `wait: hello`, 13 `wait: exit`, 14 step `herdr`, 15 step `version`, 16 step `server`, 17 step `gui`, 18 another failure, 19 `up` exit 3 (the server cannot run: `loader`, `intercom`, `acl`; `startError.text` is printed for `acl`), 20 `up` usage error (a bug here), 21 `up` answered without a usable URL, 22 the sb server is not in the primary slot, 23 step `base` busy through 3 retries (3, 6, 12 s apart), 24 step `base` failed (the folder, or Herdr said no), 25 step `integration` failed, 26 `up` answered without a base (`workspace`), 27 step `tower` failed.
Failure output: `logs\start.jsonl` (one JSON line per event, `up-attempt-failed` for each failed `up`), `logs\start-up-stderr.txt` and `logs\start-sb-log-tail.txt` (the failing `up`'s stderr and `cli.mjs logs --lines 40`, tokens replaced).

Find the slot folder through `SB_DIR` (or `state\start.json` `sbDir`); `node cli.mjs status` prints one JSON line with `state`, `primary`, `desk`, `url`, `log`. `gui-client.mjs` takes `SB_DIR` or `auto`.

## Step 4: unattended checks (4 to 8 minutes)

```bash
ssh VM "powershell -NoProfile -ExecutionPolicy Bypass -File %USERPROFILE%\sbd-kit\checks.ps1"
```

It starts the stack itself if it is not running (through `cmd.exe` with start.ps1's output in `logs\checks-start.out.log`, so the herdr server it leaves behind cannot hold a pipe open), runs every check once, prints `PASS`, `FAIL`, or `SKIP` with evidence, and writes `results\checks-<time>.json` and `checks-latest.json`.

| Check | What it proves |
| --- | --- |
| `environment` | Windows build, architecture, Chinese profile, `LongPathsEnabled`, Defender state, `python3` on PATH, admin or not |
| `tool-versions` | node, npm, git, bash, herdr, pi, ttt, playwriter all run |
| `bash-found-by-pi` | pi's own `getShellConfig()` picks the private PortableGit `bash.exe`, and a command through it works |
| `paths-chinese-profile` | Node, Git, `pi list`, and bash handle the Chinese profile path and a Chinese folder and file name |
| `npm-install-fs-errors` | EPERM, ENAMETOOLONG, locked-file lines from all install logs; a 330-character path test; stages slower than 2 minutes |
| `pi-packages-installed` | All 13 packages at the versions in the kit's `pins.json` (for example pi-intercom 0.18.1), listed in `settings.json` as `npm:<name>@<version>` with no stale entry for an older pin, plus the list of npm-versus-fork gaps. A stale kit copy checks stale pins: the evidence names the `pins.json` it read |
| `anchorloop-write-edit-no-python` | The exact message pi-anchorloop appends to a write or edit result when `python3` is missing |
| `claude-sdk-executable` | Which `@anthropic-ai/claude-agent-sdk-win32-*` package is installed, and whether its `claude.exe --version` runs |
| `stack-start` | `start.ps1` succeeded and what it recorded |
| `home-base-tower` | The base pane `start.json` names carries `sb_role=tower`, the tower id is recorded, and the integration's extension file is in the agent dir |
| `gui-answers-200` | The GUI URL answers 200; also whether `gui.json` carries `started` (it is probably absent on Windows because `ps` does not exist) |
| `new-base-via-gui-api` | `POST /api/dirs` and `POST /api/open/base` create a member pi (the `+ New base` path) |
| `terminal-mirror-rows` | The page's SSE stream plus `POST .../mirror` yields rows read through `pane.read` |
| `ttt-version-only` | `ttt --help` runs |

`FAIL` on `environment` means the profile name was ASCII; the Chinese-path scenario was then not exercised.
`anchorloop-write-edit-no-python` passes by capturing the message; the finding is the message text itself.

## Step 5: GUI screenshots (5 minutes, author optional)

1. Desktop screenshot of the browser tab on the GUI, from the interactive desktop:
   `ssh VM "powershell -NoProfile -ExecutionPolicy Bypass -File %USERPROFILE%\sbd-kit\ui-run.ps1 -Exe powershell.exe -Arguments '-NoProfile -ExecutionPolicy Bypass -File %USERPROFILE%\sbd-kit\shot.ps1 -Name gui-browser' -Wait"`
2. Or take it from the Mac with UTM's display screenshot.
3. Open the printed GUI URL in Edge on the VM display. In the page, press `+ New base`, pick a folder, and confirm a member appears and its terminal tile shows rows. Screenshot both.

## Step 6: stop, then the prototype installer (15 minutes, needs the VM display)

Stop the stack so the prototype starts it itself: `ssh VM "powershell -NoProfile -ExecutionPolicy Bypass -File %USERPROFILE%\sbd-kit\stop.ps1"`.
`stop.ps1` runs `node cli.mjs stop` first (120 s; for the kit's own state folder and socket, so only the kit's sb server stops), waits 10 s until the sb server is gone (a pid that stays is killed only while its recorded start time matches; the pid is the one in `server.json` now, not only the one `start.ps1` recorded), then runs `herdr server stop`, then kills what is left of the recorded process tree and the pi-intercom broker of this agent dir.
`cli.mjs stop`'s exit is handled as: 0 done, 1 (busy lock, `unreachable`, `scope`, `exit-timeout`) goes on, 3 (`acl`) is reported and goes on, 5 (a supervisor's `serve` server) is reported and the server is **not** killed.
The sb server is not in the herdr server's process tree (it is created outside the job on Windows), so `herdr server stop` alone leaves it running; and it goes first so that a pi session's look cannot start a new one while herdr shuts down.
The workspaces are not closed: herdr restores them at the next start, and `up --dir` finds the restored base and its tower. `gui.json`, `gui.lock` and `server.json` stay: the server owns them, and `server.json`'s `gui.port` is how the next start keeps the port.
Expected output `stopped`; `STILL RUNNING:` means a recorded process (the sb server pid included) survived and the script exits 1 (`start.json` is then kept, so a second run can finish).

On the VM display:

1. Open Edge and download `http://192.168.64.1:8099/straw-boss-desk-proto-Setup-0.0.1.exe`.
   The file gets Mark-of-the-Web. Screenshot the Edge download warning and the SmartScreen dialog ("Windows protected your PC", "More info", "Run anyway"). This is the unsigned-build experience a PM will have.
2. Run it from the Edge download list. The NSIS installer is one-click and per-user (no admin prompt expected). Note whether UAC appears.
3. The app starts after install (`runAfterFinish`). It shows the status page, runs `%USERPROFILE%\sbd-kit\start.ps1`, loads the GUI as soon as `GUI_URL=` is printed, then follows the GUI: a restart, upgrade or crash moves the window to the new URL, and a stopped GUI or server shows a screen with a Start button. Screenshot the status page and the GUI.
4. Find the install folder: `ssh VM "dir %LOCALAPPDATA%\Programs"`; the executable is `Straw Boss Desk Proto.exe`.

Prototype log: `%LOCALAPPDATA%\straw-boss-desk\logs\proto.jsonl`.
If `start.ps1` was not found, the app shows `start.ps1 not found at ...`; the kit must be at `%USERPROFILE%\sbd-kit` or the app started with `--kit-dir=<path>`.

## Step 7: prototype debug actions (5 minutes)

Interactively: Debug menu, then in order "Show versions", "safeStorage encrypt/decrypt roundtrip", "Capture page to PNG".
Each shows a dialog and writes a file in `%LOCALAPPDATA%\straw-boss-desk\results\` (`proto-versions-*.json`, `proto-safestorage-*.json`, `proto-capture-*.png`).

Unattended, on the interactive desktop (use the real install path from step 6):

```bash
ssh VM "powershell -NoProfile -ExecutionPolicy Bypass -File %USERPROFILE%\sbd-kit\ui-run.ps1 -Exe \"%LOCALAPPDATA%\Programs\straw-boss-desk-proto\Straw Boss Desk Proto.exe\" -Arguments '--run=versions,safestorage,capture --quit-after'"
```

Pass criteria: `proto-safestorage` has `available: true`, `roundtrip: true`, `afterFileRoundtrip: true`, `plaintextVisibleInFile: false`; the PNG is larger than 10 KB and shows the GUI; `proto-versions` shows `electron 45.0.0`, `arch x64`, and the Windows build.

## Step 8: update 0.0.1 to 0.0.2 (5 minutes)

The installed app is 0.0.1 and the feed at `http://192.168.64.1:8099/` serves `latest.yml` for 0.0.2.

1. Debug menu, "Check for updates": expect `updateAvailable: true`, `latest: 0.0.2`. Result file `proto-update-*.json`.
2. Debug menu, "Download and install update". The app downloads the 120 MB installer, stops the stack, and calls `quitAndInstall(false, true)`. The NSIS installer runs and the new version starts.
3. Open Debug, "Show versions": expect `app: 0.0.2`.
4. Record: whether any SmartScreen or UAC prompt appeared during the update (the downloaded file comes from Node, so it has no Mark-of-the-Web), and how long the update took.

Unattended variant for the same: `--run=update-check,update-install` with `ui-run.ps1`, then re-run `--run=versions --quit-after`.
The Mac side sees each request in the feed server's output (`GET /latest.yml`, then the installer).

## Step 9: account checks with the author present (30 to 45 minutes)

These need a browser sign-in and hidden prompts, so each runs in a visible window on the interactive desktop.
Start each with `ui-run.ps1` (the window stays open with `-NoExit`), then the author types in the VM window.
No secret is echoed or logged: the Claude login stores into the private `claude\` folder; GitHub uses Git Credential Manager and the Windows Credential Manager; the GitLab token and Linear key come from hidden prompts.

```bash
ssh VM "powershell -NoProfile -ExecutionPolicy Bypass -File %USERPROFILE%\sbd-kit\ui-run.ps1 -Exe powershell.exe -Arguments '-NoExit -NoProfile -ExecutionPolicy Bypass -File %USERPROFILE%\sbd-kit\check-claude.ps1'"
```

| Order | Script | Needs | Time |
| --- | --- | --- | --- |
| 1 | `check-claude.ps1` | The author's Claude subscription sign-in in the browser | 10 to 15 minutes |
| 2 | `check-github.ps1 -RepoUrl https://github.com/<owner>/<throwaway>.git` | github.com sign-in in the GCM browser window; a throwaway repo the account can push to | 5 to 8 minutes |
| 3 | `check-gitlab.ps1 -GitLabHost <host> -RepoUrl https://<host>/<group>/<repo>.git` | A personal access token typed into the hidden prompt | 3 to 5 minutes |
| 4 | `check-ttt.ps1 [-LinearUser <email>] [-Team <name>] [-IssueId <ID>]` | A Linear API key typed into the hidden prompt | 3 to 5 minutes |

What each records (in `results\check-<name>-*.json`, one row per step with `interactive: true` where the person was needed):

- `check-claude`: the executable used (the Agent SDK's bundled `claude.exe`), `auth login` duration, where credentials landed, one real model turn through pi and pi-claude-bridge (expects `ALPHA-7731`), then one subagent dispatch from a member (expects `BRAVO-4242` and at least three pi panes: tower, member, subagent).
- `check-github`: GCM present, login and clone, credential stored in Windows Credential Manager (target names only), a silent push of a `spike-win-<time>` branch (no prompt allowed), and its deletion.
- `check-gitlab`: the token stored through `git credential approve`, read back by `git credential fill` (only the length is reported), and a clone with prompts disabled.
- `check-ttt`: whether `ttt init -y` works without prompts (a timeout is the signal that it prompted), whether the key ends up on disk, then `sync` and `show`. If the non-interactive init fails, the script falls back to the interactive wizard and marks that step `interactive: true`.

Each script ends by offering cleanup (log out, `git credential reject`, `cmdkey /delete` for the host, delete the scratch folder).
Answer `y`, or pass `-Cleanup` up front, or run it later with `-CleanupOnly`.

## Step 10: collect everything back (3 minutes)

```bash
ssh VM "powershell -NoProfile -ExecutionPolicy Bypass -File %USERPROFILE%\sbd-kit\collect.ps1"
scp VM:sbd-collected.zip spike/win/out/
```

The zip holds `logs\`, `results\` (checks, account checks, prototype results, PNG captures), the bootstrap state, `agent\settings.json`, the herdr-agents config, `sbd-shots\`, and `os.json`.
It leaves out `claude\`, `agent\` (auth and sessions), `gui.json`, `start.json`, `tools\`, and Git configuration, and it replaces any GUI token in text files with `<token>`.
Also copy the Edge and SmartScreen screenshots taken from UTM.

## Step 11: cleanup (5 minutes)

1. Account scripts: confirm each printed its `cleanup:*` rows as `PASS`. Then revoke on the provider side: the Claude session (claude.ai, Settings, Claude Code sessions), GitHub (Settings, Applications, Authorized OAuth Apps: Git Credential Manager), the GitLab PAT, the Linear API key.
2. `stop.ps1`, then confirm no leftover: `ssh VM "tasklist /fi \"imagename eq herdr.exe\""`, and that the sb server pid in `state\start.json` (read before stop) is gone: `ssh VM "tasklist /fi \"pid eq <pid>\""`.
3. Uninstall the prototype from Settings, or run its `Uninstall Straw Boss Desk Proto.exe` in the install folder.
4. Remove the kit state if the VM is kept: `%LOCALAPPDATA%\straw-boss-desk`, `%USERPROFILE%\sbd-kit`, `%USERPROFILE%\sbd-playground`, `%USERPROFILE%\sbd-shots`, `%APPDATA%\straw-boss-desk-proto`.
5. Mac: `MonitorStop` the feed server; confirm nothing listens on 8099 (`lsof -nP -iTCP:8099 -sTCP:LISTEN`).
6. Delete the VM.

## Expected findings to watch for

These are the places this kit expects Windows to disagree with macOS.
Each is recorded by a check; none is fixed in this repository.

1. herdr's Windows socket is a named pipe built from `HERDR_SOCKET_PATH`. A path with non-ASCII characters or `AppData` in it is untested. `start.ps1` fails at "herdr server did not answer" if it breaks.
2. `herdr agent start --kind pi` needs the new pane's shell at a prompt. The default shell on Windows (PowerShell or cmd) decides whether the `STRAW_BOSS_ROLE` env reaches pi.
3. pi-straw-boss reads the owner's start time with `ps -o lstart`; on Windows `ps` is missing, so `gui.json` has no `started` and a surviving session never adopts the server after its owner ends.
4. pi-aaaav (now pi-anchorloop) ran `python3` after every write and edit; without Python (or with the Microsoft Store `python3.exe` stub) every edit result carries a validator warning.
5. Agent SDK platform packages: `@anthropic-ai/claude-agent-sdk-win32-x64` and `-win32-arm64` both exist at 0.3.310 on npm. Under x64 emulation Node reports `x64`, so npm installs the x64 one.
6. PortableGit 2.56 uses the `ucrt64` layout and ships `git-credential-manager.exe` (a .NET Framework build). Git Credential Manager is therefore available without a separate install.
7. pi finds `bash.exe` through `where bash.exe`. The private `tools\git\bin` is first on PATH; `C:\Windows\System32\bash.exe` (the WSL launcher) must not win.

## Versions pinned, and gaps against the author's setup

Pinned by SHA256: Node 24.22.1 (LTS, the same as the author's), PortableGit 2.56.0.3, herdr 0.9.5.
Pinned by npm integrity: pi 1.4.0 and the 13 pi packages at the versions the author pins in `weihung-basic-agent/scripts/pi_root/pins.py` (checked 2026-10-30; the newest npm release where the author runs a git fork), ttt 3.12.0 (latest), playwriter 0.9.0 (the author's pin). Each pin's `dist.integrity` is the registry's.

| Package | Author's setup | Kit | Gap |
| --- | --- | --- | --- |
| pi-claude-bridge | git fork `9822631` | npm 0.9.3 (still the newest) | The fork is 33 unreleased upstream main commits plus its own fixes; missing from 0.9.3: no Claude Code setting sources on the provider path, require pi 1.2.0+, parallel tool calls after a non-streaming fallback (PR 225 open), fail the turn when a never-received tool call holds an MCP handler (PR 226 open) |
| pi-herdr-agents | git fork `19ba73e` | npm 3.6.1 (PMs get the newest release, the PM's decision) | Upstream still lacks open PR 84 (keep auto-exit children open on an aborted run) and the fork-only exit hold; 3.6.1 now carries PRs 99 and 94 and the reload fix of 95 |
| pi-lens | git fork `1cdd03e` | npm 4.4.7 | npm has no `dispatch.disabledRunners` (apmantza/pi-lens PR 5011, open), so the dotnet-build runner cannot be switched off; the profile does not use the key |
| pi-herdr-roles | 0.1.0 | 0.1.0 | The author filters out the `orchestrate` skill; the kit does not |

## Upstream seams used as hacks (nothing is rebuilt in this repository)

The kit runs published CLIs (herdr, pi, ttt) and calls HTTP endpoints pi-straw-boss already serves (`/api/dirs`, `/api/open/base`, `/api/sessions/<key>/mirror`, the SSE `events`).
Where pi-straw-boss exposes nothing, the kit uses the thinnest workaround and lists it here for the upstream change.

| # | Gap | Spike hack | Proposed upstream API | Where |
| --- | --- | --- | --- | --- |
| 1 | The GUI started only when a session typed `/boss gui` | **Delivered in 0.46.0 (B2):** the sb server serves the GUI from its start; `up` prints its URL and starts a GUI that was stopped on purpose. `start.ps1` no longer types anything | – | – |
| 2 | `/boss gui` opens the default browser | **Mostly delivered:** with `STRAW_BOSS_DESK=1` (the kit sets it) `/boss gui` prints the URL and opens nothing (0.46.0 VM item 8). The pairing overlay's **o** key still calls `openUrl` | Guard the **o** key on the switch (desk-b7 plan, P1, S2) | `src/host.ts` |
| 3 | There is no headless way to start a tower; `ensureTower` runs only inside a pi session | **Delivered in 0.48.0 (B6 + B7):** `cli.mjs up --dir <folder> --label <name>` makes the home base and its tower, and installs Herdr's pi integration. `start.ps1` no longer creates a workspace or starts pi (the pin is 0.48.0) | – | `src/server/cli.ts`, `src/towertab.ts` |
| 4 | The URL was only in `gui.json` | **Delivered in 0.46.0:** `cli.mjs up` prints `url` (and `status` prints it); `server.json` is the documented successor of `gui.json` (`gui: {port, token, stopped}`), and the prototype's follower reads both for a rotation | Later stages move the contract to `server.json` alone | `src/server/record.ts` |
| 5 | Folder picking is limited to the home folder and hidden folders are refused | The kit's playground sits under the profile | Allow a list of extra roots from the desk (native dialog result) | `src/spawn.ts` (`pickable`) |
| 6 | `startOf` used `ps -o lstart` | **Delivered (0.45/0.46, `src/startof.ts`):** `up` carries `started` once the server knows it (on Windows it arrives late; `start.ps1` then reads the process's own start time). `gui-answers-200` still records whether `gui.json` carries `started` | `up` could wait for `started` or say `startedPending` (desk-b7 plan, P3) | `src/startof.ts` |
| 7 | Stopping the GUI from outside | `stop.ps1` runs `cli.mjs stop` (sb server) first with 120 s, then `herdr server stop`, then kills only recorded pids with their start times | – (the CLI is the seam) | `src/server/cli.ts` |
| 8 | `ttt init` prompts | `check-ttt.ps1` tries `ttt init -y` with the key in the environment and falls back to the wizard | Non-interactive flags that do not need a TTY | team-toon-tack `init` |
| 9 | pi-aaaav (now pi-anchorloop) needed `python3` | `anchorloop-write-edit-no-python` records the message | Port the validator to TypeScript, or skip quietly without Python | `pi/validate-tool-use.ts` |

## Prototype build notes (Mac)

- The installers are unsigned NSIS x64, per-user, one-click: `straw-boss-desk-proto-Setup-0.0.1.exe` and `-0.0.2.exe`, about 120 MB each, plus `latest.yml` and blockmaps, in `spike/win/out/feed/`.
- No Wine is needed. `win.signAndEditExecutable: false` skips rcedit and signing, so the `.exe` carries Electron's default icon and version resources.
- electron-builder 26.18.0 bundles an x86_64 `makensis` that cannot run on Apple Silicon without Rosetta. `toolsets.nsis: "1.2.1"` in `electron-builder.json` selects NSIS 3.12 from electron-builder's own toolset download, which runs natively; no Rosetta and no Homebrew package were needed.
- The update feed URL is baked into `app-update.yml` at build time (`build-installers.mjs [feed-url]`, default `http://192.168.64.1:8099/`) and can be overridden at run time with `--feed-url=`, `SBD_FEED_URL`, or `%APPDATA%\straw-boss-desk-proto\config.json`.
- The kit location defaults to `%USERPROFILE%\sbd-kit` and can be overridden with `--kit-dir=`, `SBD_KIT_DIR`, or the same `config.json`.
- The prototype uses `safeStorage.encryptStringAsync` and `decryptStringAsync`; the synchronous calls are deprecated in Electron 45.
- electron-updater verifies the publisher signature only when the build names a publisher; these builds do not, so unsigned updates are accepted.
