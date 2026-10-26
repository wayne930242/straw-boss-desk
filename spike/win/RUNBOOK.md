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
| `start.ps1` / `stop.ps1` | Headless herdr server and tower pi serving the GUI; stops only what it recorded |
| `checks.ps1` | The unattended checks, results in `results\checks-*.json` |
| `check-claude.ps1`, `check-github.ps1`, `check-gitlab.ps1`, `check-ttt.ps1` | Account checks, run with the author present |
| `ui-run.ps1`, `shot.ps1` | Start a program on the interactive desktop from SSH; desktop screenshot |
| `collect.ps1` | Zip logs, results, and screenshots without credentials |
| `proto/` | Electron prototype (TypeScript); `proto/scripts/build-installers.mjs` builds 0.0.1 and 0.0.2 |
| `serve-feed.sh`, `pack-kit.sh` | Mac side: serve the update feed, zip the kit |

Everything the kit installs lives in `%LOCALAPPDATA%\straw-boss-desk`: `tools\` (Node, Git, herdr, npm prefix), `agent\` (the private `PI_CODING_AGENT_DIR`), `herdr\` (private config and socket), `claude\` (private `CLAUDE_CONFIG_DIR`), `logs\`, `results\`, `state\`.
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

What this step records without any extra work:

- Per-stage timing and the Windows Defender or long-path symptoms (`fsErrors`, slow stages).
- Whether PortableGit contains Git Credential Manager (`GitCredentialManagerIncluded=` in the git stage evidence). From the release file listing it does: `ucrt64\bin\git-credential-manager.exe`.
- Which herdr, Node, and Git versions ran, and `node.arch` (expected `x64`).

## Step 3: start the stack (1 to 3 minutes)

```bash
ssh VM "powershell -NoProfile -ExecutionPolicy Bypass -File %USERPROFILE%\sbd-kit\start.ps1"
```

Expected last line: `GUI_URL=http://127.0.0.1:<port>/<token>/`.
`start.ps1` starts `herdr server` with a private socket and config, creates a `tower` workspace whose shell has `STRAW_BOSS_ROLE=tower`, starts pi in it with `herdr agent start`, types `/boss gui`, and waits for `gui.json`.
A browser window may open on the interactive desktop because `/boss gui` calls the default browser; that is a known gap (see upstream seams).
Failure output: `logs\start.jsonl`, `logs\start-tower-pane.txt`, `logs\start-tower-pane-after.txt` (what the tower pane showed).

## Step 4: unattended checks (4 to 8 minutes)

```bash
ssh VM "powershell -NoProfile -ExecutionPolicy Bypass -File %USERPROFILE%\sbd-kit\checks.ps1"
```

It starts the stack itself if it is not running, runs every check once, prints `PASS`, `FAIL`, or `SKIP` with evidence, and writes `results\checks-<time>.json` and `checks-latest.json`.

| Check | What it proves |
| --- | --- |
| `environment` | Windows build, architecture, Chinese profile, `LongPathsEnabled`, Defender state, `python3` on PATH, admin or not |
| `tool-versions` | node, npm, git, bash, herdr, pi, ttt, playwriter all run |
| `bash-found-by-pi` | pi's own `getShellConfig()` picks the private PortableGit `bash.exe`, and a command through it works |
| `paths-chinese-profile` | Node, Git, `pi list`, and bash handle the Chinese profile path and a Chinese folder and file name |
| `npm-install-fs-errors` | EPERM, ENAMETOOLONG, locked-file lines from all install logs; a 330-character path test; stages slower than 2 minutes |
| `pi-packages-installed` | All 13 packages at pinned versions, plus the list of npm-versus-fork gaps |
| `anchorloop-write-edit-no-python` | The exact message pi-anchorloop appends to a write or edit result when `python3` is missing |
| `claude-sdk-executable` | Which `@anthropic-ai/claude-agent-sdk-win32-*` package is installed, and whether its `claude.exe --version` runs |
| `stack-start` | `start.ps1` succeeded and what it recorded |
| `herdr-pane-runs-pi` | The tower pane's agent is `pi`, and the screen has no extension load errors |
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
Expected output `stopped`; `STILL RUNNING:` means a recorded process survived and the script exits 1.

On the VM display:

1. Open Edge and download `http://192.168.64.1:8099/straw-boss-desk-proto-Setup-0.0.1.exe`.
   The file gets Mark-of-the-Web. Screenshot the Edge download warning and the SmartScreen dialog ("Windows protected your PC", "More info", "Run anyway"). This is the unsigned-build experience a PM will have.
2. Run it from the Edge download list. The NSIS installer is one-click and per-user (no admin prompt expected). Note whether UAC appears.
3. The app starts after install (`runAfterFinish`). It shows the status page, runs `%USERPROFILE%\sbd-kit\start.ps1`, then loads the GUI in the main window. Screenshot the status page and the GUI.
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
2. `stop.ps1`, then confirm no leftover: `ssh VM "tasklist /fi \"imagename eq herdr.exe\""`.
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
Pinned by npm integrity: pi 1.4.0 and the 13 pi packages at the author's `settings.json` versions, ttt 3.12.0 (latest), playwriter 0.8.0 (the author's pin).

| Package | Author's setup | Kit | Gap |
| --- | --- | --- | --- |
| pi-claude-bridge | git fork `cf8c6e1` | npm 0.9.3 | Four fork commits are missing: no Claude Code setting sources on the provider path, require pi 1.2.0+, parallel tool calls after a non-streaming fallback, fail the turn when a never-received tool call holds an MCP handler |
| pi-herdr-agents | git fork `4f37f3e` | npm 3.3.1 | The fork adds open upstream PR 84 (keep auto-exit children open on an aborted run) and a fork-only exit hold |
| pi-herdr-roles | 0.1.0 | 0.1.0 | The author filters out the `orchestrate` skill; the kit does not |

## Upstream seams used as hacks (nothing is rebuilt in this repository)

The kit runs published CLIs (herdr, pi, ttt) and calls HTTP endpoints pi-straw-boss already serves (`/api/dirs`, `/api/open/base`, `/api/sessions/<key>/mirror`, the SSE `events`).
Where pi-straw-boss exposes nothing, the kit uses the thinnest workaround and lists it here for the upstream change.

| # | Gap | Spike hack | Proposed upstream API | Where |
| --- | --- | --- | --- | --- |
| 1 | The GUI starts only when a session types `/boss gui` | `start.ps1` types `/boss gui` into the tower with `herdr agent prompt` | A desk mode: env `STRAW_BOSS_DESK=1` makes a tower start the GUI on `session_start` through `host.restore`/`share` | `src/host.ts`, `src/session.ts` (the `session_start` handler) |
| 2 | `/boss gui` opens the default browser | Ignored; a browser window may pop up | Env `STRAW_BOSS_NO_BROWSER=1`, or a `Deps.openUrl` override from the environment | `src/index.ts` (`openUrl = openBrowser`), `src/gui.ts` (`openBrowser`) |
| 3 | There is no headless way to start a tower; `ensureTower` runs only inside a pi session | `start.ps1` creates a herdr workspace with `STRAW_BOSS_ROLE=tower` and starts pi in it with `herdr agent start` | A published CLI such as `pi-straw-boss tower --cwd <dir>` that wraps `src/towertab.ts` `ensureTower` and prints the `gui.json` path | `src/towertab.ts`, `src/tower.ts` |
| 4 | The URL is only in `gui.json` | `start.ps1` reads `port` and `token` from `gui.json` | `gui.json` documented as the contract, with a `schemaVersion` | `src/handover.ts` (`GuiRecord`) |
| 5 | Folder picking is limited to the home folder and hidden folders are refused | The kit's playground sits under the profile | Allow a list of extra roots from the desk (native dialog result) | `src/spawn.ts` (`pickable`) |
| 6 | `startOf` uses `ps -o lstart` | Recorded as a finding by `gui-answers-200` | A Windows variant (`Get-CimInstance Win32_Process` or `wmic`) | `src/remote.ts` (`startOf`) |
| 7 | Stopping the GUI from outside | `stop.ps1` runs `herdr server stop` and kills only recorded pids | Use the existing `POST /api/server/stop` first, then `herdr server stop` | `src/control.ts` (`scope === "server"`) |
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
