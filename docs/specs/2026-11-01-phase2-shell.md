# Phase 2: the shell

Status: written 2026-11-01. The boss approved starting phase 2 that day (「我都同意」) and left technical choices to our recommendation (「技術上都按照你們的建議」).
Technical choices below are made, each with its reason; only the items in **Open for the boss** wait for a decision.

Sources: `docs/specs/2026-10-25-design.md` (phases, work order item 4, the tools table, architecture); `docs/specs/2026-10-27-team-profile.md` (sections 4, 5, 7, 8, **What phase 2 must also settle**, Tasks 4 to 7); `docs/specs/2026-10-28-desk-b7.md` (start and stop order, exit codes, the follower); the kit in `spike/win/` and `spike/mac/` at `da9ea73`; `~/.local/share/sbd-review/profile-stage/followups.md`, `~/.local/share/sbd-review/account-check/followups.md` and `report.md`; `~/.local/share/sbd-review/desk-pin-051/report.md`; pi-straw-boss 0.51.0 sources (`src/trust/files.ts`, `gui/picker.ts`, `gui/desk.ts`, `gui/style.css`).

## Intent

Phase 2 turns the spike kit into the product: one Electron app that a PM installs, that builds the stack on a bare macOS or Windows machine through a wizard, signs the PM in, and opens the pi-straw-boss GUI as its main window.
Its anchor, from the design record, is **CI on macOS and Windows runners runs the wizard from zero**.
It also closes the checks phase 0 skipped: SmartScreen, the updater, DPAPI, and the account checks.

## Scope

- In: the bootstrap engine; the runtime supervisor; the wizard and settings; secrets; the app data layout; SmartScreen, signing, and notarization as far as an unsigned v1 needs them; the shell and `stack.json` updaters (client side, proved against a local feed); CI on both platforms; the upstream seams the shell needs; acceptance in the Windows VM and on macOS.
- Out: the release workflow and GitHub Releases publishing (phase 4, which reuses this updater); the profile's content (phase 3, done); the switchboard; Straw Link steps 6 to 8; the scripted PM runs of team-profile section 8 (they need this shell first and run after it, as team-profile Tasks item 7).

## Where phase 2 starts

The kit proved most of the mechanics; the shell ports them rather than inventing them.

| Concern | Proved by the kit | Phase 2 work |
| --- | --- | --- |
| Install | `bootstrap.ps1`: detect, install, verify per stage; SHA256 downloads; npm integrity checked against the registry; failure wording for registry trouble; resumable by re-running | the same stage contract in TypeScript on both platforms, plus rollback, versioned installs, and a UI |
| Team profile | `lib/team-profile.mjs` (installer with manifest, kept PM edits, skills-only recipe packages), `recipe/validate.mjs` | moved into the app as modules, with the open followups fixed |
| Code-host CLIs | `lib/forge-cli.mjs` (launchers, Git helpers); `account-check.ps1` (keyring verdict, logout on evidence, token search); VM run 2026-10-31: gh `tokenSource` is exactly `keyring`, an `api` token pushes | wizard screens, the store probe, the refusal, macOS |
| Start and stop | `start.ps1` and `stop.ps1` on pi-straw-boss 0.51.0: `cli.mjs up --dir --label --exact`, the primary slot through an app-owned `XDG_CONFIG_HOME`, workspaces kept, the stop order | the same in TypeScript, owned by the app's lifecycle |
| Following the GUI | `proto/src/follow.ts`, shared by both kits, headless check `spike/mac/07-follow-check.sh` | reused as is, plus restart detection, sleep, and crash budgets |
| Packaging | `proto/`: unsigned per-user NSIS, electron-updater against a generic feed, `safeStorage` roundtrip | never run in the VM (phase 0 **Not done**); phase 2 runs them |

## Decisions

| Topic | Decision | Reason |
| --- | --- | --- |
| Engine language | TypeScript in the app, one engine for both platforms; the PowerShell and bash kits are not shipped | two script stacks would drift, and Electron's own Node can run the engine before the private Node exists |
| Where the engine runs | an Electron `utilityProcess`, talking to main by messages | a long install never blocks the window, and an engine crash is a resumable event, not an app crash |
| Archive extraction | the system `tar` (bsdtar, on Windows 10 1803+ and macOS), PortableGit's own self-extractor | no npm dependency, and the kit already proved both on Windows |
| Git on macOS | dugite-native (`desktop/dugite-native`, the relocatable Git that GitHub Desktop ships; v2.56.0-2 has `macOS-arm64` and `macOS-x64` tarballs with `.sha256` files) | `/usr/bin/git` on a bare Mac is a stub that asks to install the Xcode tools; dugite needs no install and no admin |
| Git on Windows | PortableGit, as in the kit | pi needs its `bash.exe` |
| Windows architecture | x64 app and x64 tools everywhere, also on Windows ARM | herdr has no arm64 build, and the VM proved the all-x64 stack under emulation |
| macOS architecture | separate arm64 and x64 builds, tools per architecture | every pinned tool ships both |
| playwriter | dropped from the default stack | no role or skill in the profile uses it now that visual-tester is out of v1, and it needs a Chrome extension installed by hand |
| ttt | installed when the PM saves a Linear key, not before | it is only the Linear client |
| `fd` and `rg` | provisioned by a pinned stage into pi's own `bin` folder before pi's first start | pi otherwise downloads them on first start without our pin (mac spike finding 5), which breaks the repository's SHA256 rule |
| Renderer | plain TypeScript and DOM modules compiled by `tsc`, no framework, no bundler | the pi-straw-boss page is written the same way, and it keeps the dependency list short |
| Window | one `BaseWindow` with two `WebContentsView`s: the GUI view and the shell view (wizard, settings, screens, banners) | each page gets only its own preload, and the GUI stays loaded while a shell screen or banner covers it |
| Home base | the work folder itself, `~/StrawBoss` (`%USERPROFILE%\StrawBoss`), label `Straw Boss` | team-profile decision 12 fixed `~/StrawBoss`; one visible folder is easier for a PM than the kit's separate `~/Straw Boss` |
| Window close | macOS: closing the window keeps the app and the stack running, Quit stops them; Windows: closing the window quits and stops | each platform's convention |
| Keep awake | a setting, off by default | a laptop that never sleeps surprises people; the setting becomes "while agents work" once pi-straw-boss exposes that state (seam U3) |
| Telemetry | none | nothing in v1 needs it, and it would be a new external service |
| `stack.json` channel integrity | an Ed25519 signature (`node:crypto`), public key built into the app, a monotonically increasing `generation` | `stack.json` carries every SHA256 pin, so whoever can change it controls every download; HTTPS alone trusts the host |
| E2E driver | Playwright's Electron support (`_electron.launch`), a dev dependency of the tests only | it drives the packaged app without a test hook in the product |
| Test model | the kit's `stub-llm.mjs` (an OpenAI-compatible stand-in on 127.0.0.1), configured by the test harness, never by the app | CI cannot sign in to Claude; a pi turn still has to run in the stack |
| Data root override | `STRAW_BOSS_DESK_ROOT` (and `--root=`) are honored in every build | the author's Mac must run development builds against their own app data folder (repository AGENTS.md), and CI uses the same switch |

## Architecture

```text
app/                         the Electron app (package.json, electron-builder.json)
├─ src/main/
│  ├─ index.ts               single instance, lifecycle, menus, the window
│  ├─ paths.ts               the app data layout and its checks
│  ├─ env.ts                 the constructed environment for every child
│  ├─ platform/              one interface per concern: Processes, UserPath, CredentialStore, Locate; win.ts and mac.ts behind each
│  ├─ bootstrap/             engine.ts (utilityProcess entry), graph.ts, stage.ts, state.ts, download.ts, extract.ts, log.ts, stages/*.ts
│  ├─ runtime/               herdr.ts, sbup.ts (up and its failure table), stop.ts, follow.ts (from the kit), supervisor.ts, power.ts
│  ├─ accounts/              claude.ts, forge.ts (from forge-cli.mjs and account-verdict.ps1), linear.ts, probe.ts, token-search.ts (tests and diagnostics)
│  ├─ profile/               team-profile.ts (from lib/team-profile.mjs)
│  ├─ secrets/               safe.ts (safeStorage)
│  └─ update/                shell.ts, stack.ts
├─ src/preload/              shell.ts (shell view), gui.ts (GUI view: strawBossDesk.pickFolder)
├─ src/renderer/             wizard/, settings/, screens/, banner/, i18n/en.ts, i18n/zh-TW.ts, style.css
└─ test/                     node tests; e2e/ (Playwright); fixtures/ (CI recipe, local feed)
stack.json, stack.schema.json  tool and package pins, generation, minShell
recipe/, profile/              as today
scripts/                     check-stack.mjs, sign-stack.mjs
.github/workflows/           ci.yml, wizard-from-zero.yml, stack-check.yml
```

The design record's tree (`main/bootstrap`, `main/runtime`, `main/secrets`, `main/update`, `renderer/wizard`) maps onto this one to one, plus `accounts/` and `profile/`, which the team profile added after the design.

## App data layout

| | Windows | macOS |
| --- | --- | --- |
| Root | `%LOCALAPPDATA%\straw-boss-desk` | `~/Library/Application Support/straw-boss-desk` |

The folder name is the stable internal id, not the display name, so a later rename of the product (**Open for the boss**) moves nothing.
The kit uses the same Windows folder; a VM that ran the kit is reset before the app runs there (task 14).

```text
<root>/
├─ stack/            active.json, previous.json, candidate.json + .sig
├─ tools/
│  ├─ node/<version>/  git/<version>/  herdr/<version>/  gh/<version>/  glab/<version>/
│  ├─ npm/           private npm prefix (pi; ttt when Linear is on)
│  ├─ npm-cache/
│  ├─ downloads/     verified archives, the cache for repair and rollback
│  ├─ bin/           launchers: gh, glab (POSIX and .cmd), env.sh
│  └─ shims/         Windows only: pi.cmd, the one user PATH entry (see Environment)
├─ agent/            PI_CODING_AGENT_DIR (pi's bin/ holds the provisioned fd and rg)
├─ config/           XDG_CONFIG_HOME: herdr/ (config, session, socket), gh/, glab-cli/
├─ claude/           CLAUDE_CONFIG_DIR
├─ gitconfig         GIT_CONFIG_GLOBAL
├─ secrets/          safeStorage blobs (linear.bin)
├─ recipe/<id>.json
├─ state/            bootstrap.json, current.json (active tool versions), start.json, wizard.json, layout.json
├─ logs/             shell.jsonl, bootstrap.jsonl, start.jsonl, per-stage logs
└─ electron/         app.setPath("userData"): Chromium's profile and caches
```

Constraints, each checked by the preflight stage and recorded once in `state/layout.json`, so a later start never computes another place:

- **The agent folder lies inside the user's home on Windows.** pi-straw-boss's trust relay accepts its folder only when `realpath.native(dir)` is inside `realpath.native(home)` (`src/trust/files.ts`, `ensureDir`); elsewhere a pi asks its trust question in the terminal, where the PM never looks. `%LOCALAPPDATA%` normally passes. When folder redirection or a junction puts it outside, the agent folder goes to `%USERPROFILE%\.straw-boss-desk\agent` instead, and the rest stays.
- **The Herdr socket stays at most 100 bytes on macOS.** `sun_path` holds 104. Herdr's default socket for the app's `XDG_CONFIG_HOME` is what makes the sb server the primary one (desk B7 plan, Q1), so the socket cannot move alone: the whole `XDG_CONFIG_HOME` moves. `<root>/config/herdr/herdr.sock` is 75 bytes plus the user name; above 100, `XDG_CONFIG_HOME` becomes `~/.straw-boss-desk/config`.
- **The root's path has a space on macOS** ("Application Support"). Every launcher and helper quotes its paths already; the CI anchor runs under this path, so a quoting bug fails CI.
- **Chromium's profile is moved into `<root>/electron`**, so nothing lands in the roaming `%APPDATA%`.
- **Free space**: 3 GB, checked before the first download (the Windows install measured about 1.5 GB).

## Bootstrap engine

### Stage contract

A stage is `{ name, needs, detect, install, verify, activate }`.

- `detect` runs first and only reads. It returns evidence when the stage's pinned version is active and its recorded file hashes still match (followup R-F009: a binary is checked by the SHA256 of its executables as recorded at install, not by `--version` alone). Evidence means the stage is `skipped-verified`.
- `install` writes only into a staging folder (`tools/<tool>/<version>.staging/`, or a staging copy of the files it edits).
- `verify` runs the staged result (`--version` through its launcher, the installer's dry run, `npm view` integrity) and must return evidence.
- `activate` makes the result the active one in one step: a rename of the staging folder, then a write of `state/current.json` by rename.

The graph runs stages whose `needs` are done; independent downloads run three at a time, npm and pi steps one at a time (they share the npm cache and prefix).

### Stages

| Stage | Needs | Notes |
| --- | --- | --- |
| `preflight` | | OS version, architecture, free space, the layout constraints above, Windows Smart App Control state (see SmartScreen), reachability of each download host with the host named in the failure |
| `node` | preflight | official zip or tarball |
| `git` | preflight | PortableGit (Windows), dugite-native (macOS); writes the private `gitconfig` (identity placeholder, `core.longpaths`, `init.defaultBranch`) |
| `herdr` | preflight | release binary; writes Herdr's config: no version or manifest check, no sounds, no onboarding, `shell_mode = "non_login"` on macOS (mac spike finding 6) |
| `fd-rg` | preflight | pinned `fd` and `ripgrep` into `<agent>/bin` |
| `gh`, `glab` | preflight | only for the forges the recipe names (team-profile section 4) |
| `launchers` | gh or glab | `tools/bin` launchers from `forge-cli.ts`; the unset list gains `GLAB_SKIP_TLS_VERIFY` and `SKIP_TLS_VERIFY` and keeps the proxy and CA variables (followup R3-F002: a company proxy or CA may need them) |
| `git-helpers` | git, launchers | the credential helpers in `gitconfig`; verify runs each helper command through Git's own `sh` (the kit's proof of CJK path quoting) |
| `pi` | node | `npm install -g` into the private prefix, registry integrity first |
| `pi-shim` | pi | Windows only: `tools/shims/pi.cmd` and its user PATH entry (see Environment) |
| `profile` | pi | the team-profile installer (section 7), from the npm profile package pinned in `stack.json`; it merges the profile's owned keys into `settings.json` |
| `pi-settings` | profile, git | Windows only: `shellPath` to PortableGit's `bash.exe`, merged into `settings.json`, never replacing the file |
| `pkg:<name>` | pi-settings | each pi package, registry integrity first, the kit's failure wording for registry trouble |
| `team-pkg:<name>` | pkg:* | each recipe package, skills only; a package that cannot be listed skills-only is removed again |
| `claude` | pkg:pi-claude-bridge | locates the Agent SDK's bundled `claude` executable and runs `--version` |
| `ttt` | pi | runs from the Linear step, not in the first install |

The kit's `user-path` and `forge-path` stages are not ported: they put `tools\npm`, Herdr, Git, and `tools\bin` on the user's PATH, which changes the user's own terminals. The pi shim replaces them (Environment).

### Resume

`state/bootstrap.json` holds, per stage, `status`, `version`, `evidence`, `at`, and the hashes `detect` checks.
Resuming is running the graph again: verified stages are skipped, and a stage that was interrupted finds only a staging folder, which it deletes before it starts over.
The wizard's place (`state/wizard.json`) survives a quit, a crash, or a reboot, and the app opens on the step where it stopped.

### Rollback

The unit is a stage, not the whole run.

- **Binary stages** keep the previous version beside the new one (`tools/<tool>/<old>/`). A failed `install` or `verify` leaves `current.json` untouched; a stack update that fails later points `current.json` back. The previous version is deleted after the next successful start.
- **npm and pi stages** roll back by installing the previous pin again; the archives come from the npm cache, so a rollback works offline when the cache holds them.
- **The profile stage** already never overwrites a PM's file; a failed run leaves the manifest from before (the installer writes it last).
- **First install** has nothing to roll back to: the failed stage's staging folder is removed and the stage can be retried alone.

### Logs and failures

Every stage writes JSON lines to `logs/bootstrap.jsonl` (start, each action, result, milliseconds, evidence, `fsErrors` as the kit collects them) and its raw tool output to `logs/stage-<name>.log`.
Every log line goes through one redactor: the GUI URL token (`127.0.0.1:<port>/<token>` becomes `<token>`), and every pattern in `recipe/secret-patterns.json`.
Logs rotate at 5 MB, ten files per log.

A failure has a category, and the UI shows a plain sentence for it with **Retry** and **Details** (the last 40 log lines, redacted):

| Category | Sentence (en; zh-TW in the catalog) | Retried automatically |
| --- | --- | --- |
| network | "Could not reach `<host>`. Check the network and try again." | once, after 5 s |
| integrity | "The download of `<tool>` did not match its published checksum, so nothing was installed." | never |
| registry | the kit's sentence: "The npm registry could not be reached or is out of date, so `<name>@<version>` was not installed. …" | once |
| disk | "There is not enough free space on the disk." | never |
| locked | "A file was in use (often antivirus scanning it)." | once, after 5 s |
| other | "`<stage>` failed." | never |

**Diagnostics** in settings zips `logs/`, `state/` (without `start.json`), `stack/active.json`, and the profile manifest; never `agent/`, `claude/`, `config/gh`, `config/glab-cli`, `secrets/`, or `gitconfig`; text files pass the redactor.
This is the kit's `collect.ps1` rule.

## Runtime supervisor

### Environment

Every child gets a constructed environment, never the app's inherited one (mac spike: an inherited `SSH_AUTH_SOCK` linked the spike's Herdr to the author's).
It starts from the system essentials (`SystemRoot`, `USERPROFILE`, `TEMP`, `HOME`, `USER`, `LANG`, …), then sets what the kit's `Set-SbdEnv` sets: `PATH` with `tools/bin` first, then Node, the npm prefix, Git, Herdr; `PI_CODING_AGENT_DIR`; the npm prefix, cache, and `NPM_CONFIG_PREFER_ONLINE=true`; `STRAW_BOSS_DESK=1`; `XDG_CONFIG_HOME`, `HERDR_CONFIG_PATH`, `HERDR_SOCKET_PATH`, `HERDR_BIN_PATH`, `HERDR_DISABLE_SOUND`; `CLAUDE_CONFIG_DIR`; `GIT_CONFIG_GLOBAL`; `PI_TELEMETRY=0`, `PI_SKIP_VERSION_CHECK=1`.
It never carries `PI_SUBAGENT_*`, `PI_INTERCOM_SESSION_ID`, `HERDR_*` pane ids, `STRAW_BOSS_ROLE`, `SSH_AUTH_SOCK`, or any variable in the launchers' unset list.
`LINEAR_API_KEY` is added, decrypted from `secrets/linear.bin`, only to the Herdr server's environment, so panes and `ttt` see it and no file holds it.
An agent can read it from its environment, as it could read a key `ttt` kept in a file; the profile forbids printing it.

**Panes on Windows.** Herdr rebuilds a pane's `PATH` from the registry (Windows spike), while the other variables reach the pane (desk B7 plan, task 1; `spike/mac/09-pane-env.sh`).
The stopgap is one user PATH entry, `<root>\tools\shims`, placed first, holding only `pi.cmd`:

- in a desk pane (`STRAW_BOSS_DESK=1` and `PI_CODING_AGENT_DIR` equal to the app's agent folder) it rebuilds `PATH` as the app does, with `tools\bin` first, and runs the pinned pi, so pi, its extensions, and its bash tool find the app's Git, Herdr, `gh`, and `glab` ahead of anything on the machine PATH;
- anywhere else it runs the next `pi` on the PATH, or says that pi is not installed, so a user's own terminal is unchanged.

This replaces the kit's five user PATH entries, and with them the team-profile problem that a `gh` on the machine PATH would win in a pane (section 4, **Isolation**).
The uninstaller removes the entry.
It is listed as seam U1, and its existence is in **Open for the boss** because it bends the repository rule against touching the user's global setup.
macOS needs no shim: panes inherit the server's environment (kit check `09-pane-env.sh`).

### Start

The start order, the `up` failure table, and the retry rules are the desk B7 plan's (**Start order, after the B6 + B7 release**, **Exit codes**), as `start.ps1` implements them on 0.51.0:

1. Herdr: reuse the recorded server only when its pid, start time, and environment fingerprint match; otherwise start `herdr server` detached and hidden with `stdio: "ignore"`, record pid and start time, and wait until `herdr workspace list` answers (45 s).
2. `node <agent>/npm/node_modules/pi-straw-boss/dist/server/cli.mjs up --dir <work folder> --label "Straw Boss" --timeout 120 --exact`, with a process limit of 150 s (`--timeout` counts from when `up` starts its steps). The app creates the work folder first when it is missing, since `up --dir` only checks it.
3. The slot folder must be `<agent>/straw-boss` itself (primary); the URL must have the GUI's shape; then the GUI view loads it.

The kit's exit codes 2 to 27 become typed failures (`StartFailure { kind, step, wait, reason, startError }`), each with a screen sentence in both catalogs.
`loader` and `intercom` run the engine's repair of that package and retry once, as the kit does.

**Start times.** macOS reads them with `ps -o lstart=`.
On Windows each PowerShell start costs 2 to 5 s, so the app does not read start times on the happy path: for processes it started in this run it keeps the `ChildProcess` handle, which also keeps Windows from reusing the pid. It reads them through PowerShell only to adopt a stack from an earlier run and on the kill fallback.

### Stop

The desk B7 plan's stop order, as `stop.ps1` runs it: `cli.mjs stop` (120 s on Windows, 45 s on macOS); wait 10 s for the sb server; `herdr server stop`; kill what is left of the recorded tree only while the start times match; the pi-intercom broker only when `broker.pid` names this agent folder's broker.
Workspaces stay open, and `gui.json` and `server.json` stay.
`before-quit` holds the quit while this runs, then `app.exit`.
On Windows `session-end` (log off, shut down), the app runs `cli.mjs stop` with a 10 s limit and lets Windows end the rest; Herdr restores the workspaces at the next start.

### Following the GUI

`follow.ts` from the kit, unchanged in its rules (desk B7 plan, **The GUI URL and a rotation**): a folder watch plus a read every 2 s; moved, restarting, gui stopped, server stopped, and gone; one `up` at a time; GETs only to `127.0.0.1`.
Two additions from pi-straw-boss 0.51.0:

- **Restarts.** Since 0.48.0 a restart keeps the GUI's port and token (D27), so the URL does not show it. The follower records `server.json`'s `pid` and `started` and logs a change as a restart. The crash budget counts these.
- **The `view`.** `gui.json` carries `view` (`standard` or `geek`, absent when no default is set). The window's background is set from it before the GUI loads and whenever it changes: `geek` is `#000000`, anything else `#16161e` (the page's `--bg`). The shell's own screens use the same dark palette, so nothing flashes when the GUI appears.

### Crash and sleep

| Event | Action |
| --- | --- |
| sb server gone | the follower's gone rule: one `up` (pi sessions often restart it within about 6 s first) |
| Herdr server gone (its pid ended) | start Herdr again, then `up`; restored workspaces come back |
| More than 3 restarts of either in 10 minutes | stop retrying; show the failure screen with **Retry** and **Diagnostics** |
| GUI view's renderer gone (`render-process-gone`) | load the current URL again; twice in a minute shows the failure screen |
| Engine `utilityProcess` exits unexpectedly | resume the run; a second crash of the same stage fails that stage |
| The app crashes | the stack keeps running; the next launch adopts it (Herdr fingerprint, then `up` answers `server: "found"`) |
| `powerMonitor` `suspend` | pause the follower |
| `powerMonitor` `resume` | read the slot folder again and allow 20 s before the gone rule applies, so the sleep's gap is not counted as an unanswered GUI |
| A second launch | `requestSingleInstanceLock`: the running app comes to the front; two shells never race for the stack |

### Window and page security

- The GUI view: `sandbox`, `contextIsolation`, no Node, and the GUI preload, which exposes only `strawBossDesk.pickFolder({ defaultPath, title }) => Promise<string | null>` (the hook `gui/picker.ts` reads, desk-mode S10), and only when the page's origin is the loaded GUI's `http://127.0.0.1:<port>`. The dialog opens in the work folder. A folder outside home is still refused by the page (desk-mode decision D7: home only).
- Navigation stays on the GUI's origin (`will-navigate`); new windows open only `https:` links, in the default browser.
- Permissions: camera for the GUI origin only (Straw Link's QR join), with `NSCameraUsageDescription` on macOS; everything else is denied.
- The shell view loads only packaged `file://` pages under a strict CSP, with its own preload (wizard and settings calls).
- A desk-settings entry inside the GUI would need a page hook like S10 (seam U4); until then settings open from the app menu and from the banner of any pending item.

## The wizard

### First run

| # | Step | What happens |
| --- | --- | --- |
| 1 | Welcome | language from the OS (`zh-Hant`, `zh-TW`, `zh-HK` give zh-TW, else en), a switch for the other; one paragraph on what will be installed and where; the preflight's findings |
| 2 | Team recipe | drop or choose `<id>.strawboss.json`, or **I have no recipe**, which asks for the code hosts (GitHub, GitLab with its host name); a recipe is validated by `recipe/validate.mjs` with the reserved names from `stack.json`, and refused with the field and rule named, never the value |
| 3 | Trust | team-profile section 5, **Trust: show before applying**, line by line; **Apply** or **Cancel**; nothing is written before Apply |
| 4 | Work folder | `~/StrawBoss` by default; **Change** opens the native dialog, inside home; changeable here once |
| 5 | Install | the engine's stages as a list, each with a badge (waiting, working, done, skipped, failed); one plain line for the current action; **Details** opens the log tail; **Retry** on a failed stage |
| 6 | Start | the supervisor's start; its failure screen on a failure |
| 7 | Claude | **Sign in**: `claude auth login` with the app's `CLAUDE_CONFIG_DIR`; the screen says a browser window opened, shows the URL to copy if it did not, and a field for a code if the CLI asks for one; done when the CLI's status says signed in |
| 8 | Code hosts | one screen per forge (below) |
| 9 | Linear | when the recipe has `linear.enabled` true, or there is no recipe: a link to Linear's API key page, a masked field, then the `ttt` stage and a non-interactive `ttt init` |
| 10 | Projects | each recipe repository: clone into `<work folder>/<folder>` (reuse only when `origin` is the same URL), `git remote set-head origin <defaultBranch>`, then open it as a base through the `open-base` endpoint, labeled; a progress row per repository, each retryable alone |
| 11 | Done | the GUI view takes the window |

Every sign-in step has **Later**.
A later item shows as a badge in settings and a thin shell banner over the GUI ("GitLab is not signed in yet") with a **Settings** button, so a PM without a token today still reaches the GUI, and CI walks the same path without a test hook.

### The code-host screens

**GitHub (device code).**
The app runs `gh auth login --hostname github.com --git-protocol https --web` through the launcher, reads the one-time code from its output, and shows it large, with **Copy** and **Open GitHub** (the device page), and a line that the browser asks to approve "GitHub CLI".
It waits for gh to finish (15 minutes, then **Try again**).

**GitLab (token).**
The screen links to `https://<host>/-/user_settings/personal_access_tokens?name=Straw%20Boss&scopes=api`, says in two lines what to click, and takes the token in a masked field with no reveal toggle and no autofill.
**Sign in** sends it over IPC to main, which writes it to `glab auth login --hostname <host> --git-protocol https --api-protocol https --stdin` and drops its reference; the field is cleared at once.
The token never touches the renderer's storage, a log, a file, or a command line.

**Before either**, a store probe: Windows writes, reads, and deletes a throwaway generic credential (`cmdkey /generic:straw-boss-desk-probe`); macOS does the same with `security add-generic-password` in the login keychain.
A failed probe stops the step before the PM makes a token: "This computer's credential store is not available, so Straw Boss will not sign in (it would have to keep your token as plain text)."

**After either**, the verdict of team-profile section 4, **Where the token goes**, as `account-verdict.ps1` implements it, ported: gh's `tokenSource` must be `keyring`, and neither `hosts.yml` nor `config.yml` may hold a token for the host; glab's `config.yml` may hold no `token` for the host.
The YAML reading takes followup R3-F001: keys and sections compare case-insensitively, and multi-line value bodies are skipped.
On evidence of a plain-text token the app logs the CLI out and shows the refusal; a status it cannot read is "could not verify", which fails the step and keeps the login.
The refusal is the same sentence as the probe's.

### Settings

Reached from the app menu (macOS app menu, the Windows window menu) and from banners.

| Section | Contents |
| --- | --- |
| Accounts | Claude, each forge, Linear: state, **Sign in again**, **Sign out** (`gh auth logout`, `glab auth logout`, deleting `linear.bin`) |
| Team recipe | name, version, source; an update from `updateUrl` shown as a change list with **Apply** or **Keep**; **Replace** with another file |
| Team guidance | the installer's notices: a kept file, a kept key, with **Keep mine** or **Use the team version** (backup under `.straw-boss-profile/backup/`) |
| Updates | app version and the stack's generation; **Check now**; **Restart to update** when ready |
| Computer | keep awake (off by default); language |
| Diagnostics | stack state (one `cli.mjs status`), **Open logs folder**, **Collect diagnostics**, **Repair** (verify every stage; reinstall what fails) |

### UI rules

- Strings go through `i18n/en.ts` and `i18n/zh-TW.ts`; a test fails when the two key sets differ. Traditional Chinese with Taiwan usage.
- Animation is CSS only (`@keyframes`, `transition`); a test fails on `requestAnimationFrame` or `.animate(` in `src/renderer`.
- `@media (prefers-reduced-motion: reduce)` turns every animation and transition off; a working spinner becomes a static badge.
- Cards and panels have a uniform border on all four sides or none; state shows through a badge, an icon, a heading, or a tint. A test fails on any one-sided `border-left`, `border-right`, `border-top`, or `border-bottom` declaration in the renderer's CSS.
- Text a PM reads names no tool unless it must (Claude, GitHub, GitLab, Linear are names a PM knows); Herdr, pi, npm appear only under **Details**.

## Secrets

| Secret | Held by | Where |
| --- | --- | --- |
| GitHub login | gh | Windows Credential Manager, macOS Keychain (gh's keyring) |
| GitLab token | glab | the same stores; passes through the app's memory once on its way to glab's standard input |
| Claude login | Claude Code | `CLAUDE_CONFIG_DIR`: on Windows a `.credentials.json` file in the app's private folder (Windows spike); on macOS checked in task 13 |
| Linear API key | the app | `secrets/linear.bin`, encrypted with `safeStorage` |
| GUI page token | pi-straw-boss | `gui.json`, `server.json`; the app keeps it in memory and never logs it |

`safeStorage`:

- **Windows: DPAPI**, bound to the user account; any process of the same user can decrypt, which is DPAPI's model. Unchanged by an app update. Phase 0's untested roundtrip runs in the VM in the packaged app, and again after an update (task 14).
- **macOS: a Keychain item** ("`<product>` Safe Storage") whose access list names the app's code signature. An unsigned v1 is ad-hoc signed, and an ad-hoc signature changes with every build, so after an update macOS may ask the PM to allow access, and denying it loses the key. The app treats a failed decrypt as "Linear key needs to be entered again", never as a crash. A Developer ID signature removes the prompt (**Open for the boss**).
- **Unavailable store**: when `isEncryptionAvailable()` is false, the Linear step refuses to save the key and says so. There is no plain-text fallback.

## Network: the WARP finding

In the Windows VM on the author's Mac, with Cloudflare WARP connected on the host, the VM cannot reach `github.com:443`, and Git's schannel gets `CRYPT_E_REVOCATION_OFFLINE` for `gitlab.moldplan.app`; with WARP off both work (account-check report, finding 1).
Downloads, the glab push, and the gh login and push of 2026-10-31 ran with WARP off.

A separate scout is diagnosing it (`~/.local/share/sbd-review/vm-warp/`).
**Its result goes here:** _pending_.

What phase 2 does either way:

- The preflight names the unreachable host in plain words, so a company network that blocks a download host shows up before an install half-runs.
- Git certificate revocation behind a company proxy is a PM concern, not only a VM one. Whether the private `gitconfig` should set schannel's revocation check to a best-effort mode is decided from the scout's result; until then nothing is set.
- CI runners have no WARP, so the anchor does not depend on the result. VM runs that need github.com or the GitLab host turn WARP off for those steps and reconnect after (the account-check routine), unless the scout gives a route.

## SmartScreen, signing, and notarization

v1 ships unsigned, as the design record decides. What that means, and what phase 2 checks:

**Windows.**

- The installer is per-user NSIS (`perMachine: false`, `allowElevation: false`), so no UAC prompt.
- Downloaded in a browser, it carries Mark-of-the-Web: Edge may say the file "isn't commonly downloaded" (**Keep**), and SmartScreen shows "Windows protected your PC" (**More info**, **Run anyway**). The PM guide shows both with zh-TW screenshots from the VM.
- **Smart App Control**, when it is on (only on a freshly installed Windows 11), blocks unsigned programs with no override. That covers the app and, probably, the unsigned `herdr.exe` whatever the app's own signature. The preflight reads `HKLM\SYSTEM\CurrentControlSet\Control\CI\Policy\VerifiedAndReputablePolicyState` (0 off, 1 on, 2 evaluation; to be confirmed in the VM, task 14) and explains the state instead of failing later.
- Updates downloaded by electron-updater, and tools downloaded by the engine, get no Mark-of-the-Web, so no SmartScreen prompt is expected after the first install; task 14 records whether one appears.
- **Signing later** needs a code-signing certificate. Azure Artifact Signing (formerly Trusted Signing) takes individuals only in the US and Canada, and organizations only in a list of countries that does not include Taiwan, so the realistic path is an OV certificate from a public CA with cloud signing, which electron-builder can use in GitHub Actions. Neither Artifact Signing nor an OV certificate gets SmartScreen reputation at once; it builds with installs.

**macOS.**

- electron-builder ad-hoc signs the app, which Apple Silicon requires to run at all.
- A downloaded, unnotarized app is blocked on first open. Since macOS 15 the right-click **Open** shortcut is gone: the PM opens **System Settings**, **Privacy & Security**, and clicks **Open Anyway**, which may ask for an administrator password. On a company Mac a PM may not have one.
- The app offers to move itself into `/Applications` on first run (`app.moveToApplicationsFolder`), or into `~/Applications` when `/Applications` is not writable, so it never runs from the disk image or a translocated path.
- Squirrel.Mac refuses unsigned updates, so the macOS updater offers the new dmg (Updater).
- **Signing and notarizing later** need an Apple Developer Program membership: a Developer ID certificate and an app-specific password or API key for `notarytool`, stored as Actions secrets.

What needs the boss's accounts or money is in **Open for the boss**.

## Updater

Two channels, as the design record says; phase 2 builds both clients and proves them against a local feed; phase 4 points them at GitHub Releases and publishes.

**The shell, Windows.** electron-updater with NSIS.
It checks at start and every 6 hours, downloads in the background, and shows **Restart to update** in settings and as a banner.
On the PM's click it runs the stop sequence, then `quitAndInstall(true, true)` (silent, start after).
Unsigned builds name no publisher, so electron-updater checks only the SHA512 in `latest.yml`; once a certificate exists, `publisherName` is set and the signature is checked too.
The provider is generic for tests (`test/fixtures/feed/`) and GitHub for releases, chosen at build time.

**The shell, macOS.** electron-updater's check against the same feed; a newer version shows **Download the new version**, which opens the dmg's URL in the browser.
Once the app is signed and notarized, the zip target and Squirrel.Mac take over with no change to the check.

**`stack.json`.** The app carries its own `stack.json`.
The channel offers `stack.json` and `stack.json.sig` (Ed25519 over the exact bytes) as assets of a rolling release in this repository; phase 4's workflow publishes them, signed with a key held in an Actions secret, by `scripts/sign-stack.mjs`.
The app applies a candidate only when the signature verifies against its built-in public key, its `generation` is higher than the active one, and its `minShell` is at most the app's version (otherwise the shell must update first).
Applying is: show the change list (tool and package versions); on **Apply**, stop the stack, run the engine against the candidate, start; when a stage fails, roll back to `previous.json`, start, and report.
A recipe's `profile` pin still wins over `stack.json`'s profile entry (team-profile section 7).

## CI anchor

### Runners

| Runner | Role |
| --- | --- |
| `windows-2025` (x64) | required on every push and pull request |
| `macos-15` (arm64) | required on every push and pull request |
| `windows-11-arm` | nightly: the x64 stack under emulation, as PM ARM laptops run it |
| `macos-15-intel` | nightly: the x64 macOS build |

### Workflows

- **`ci.yml`**: `node --test` for `recipe/`, `profile/`, and `app/` (unit tests, the i18n parity, CSS-only, and border tests); TypeScript build; `electron-builder --dir` on both required runners.
- **`wizard-from-zero.yml`**, the anchor, on both required runners from an empty data root (`STRAW_BOSS_DESK_ROOT=$RUNNER_TEMP/sbd`):
  1. Launch the packaged app with Playwright, locale zh-TW.
  2. Walk the wizard: welcome; the CI recipe `app/test/fixtures/ci.strawboss.json` (forges `github.com` and a GitLab host, one public GitHub repository, Linear on); trust; default work folder; install; start; Claude **Later**; GitHub **Later**; GitLab with the test token when the secret is present, else **Later**; Linear **Later**; projects; done.
  3. Assert: every stage is verified in `state/bootstrap.json`; the GUI view shows the page (`meta[name="sb-desk"]` is `1`); `cli.mjs status` says `live`, `primary: true`, `desk: true`; one home base with one tower; the cloned repository is a base; the banner names the later items.
  4. With the GitLab secret: glab's verdict passes, and a token search over the whole data root finds nothing (followup R3-F003: linked folders and missing roots are listed as unread, with the reason). On macOS, with the login keychain locked, **Sign in again** stops at the store probe with the refusal, and no token lands on disk.
  5. A pi turn through the harness-configured stub model in the cloned repository's base.
  6. Follow checks: `cli.mjs restart` is logged by pid change while the window stays live; a killed sb server comes back within 15 s; `/boss gui stop` shows the shell screen, and **Start** brings the GUI back.
  7. Quit: no recorded process remains (by pid and start time); the workspaces are kept.
  8. Relaunch: no wizard, GUI within 30 s, base still there; quit again.
  9. A second, short run in en up to the trust screen, and a reduced-motion pass (`emulateMedia({ reducedMotion: "reduce" })`) that finds no running infinite animation (`document.getAnimations()`); screenshots of every screen in both languages as artifacts.
  10. Windows only: the user PATH has exactly one app entry (`tools\shims`), and a pi started through the shim in a Herdr pane of the cloned repository's base runs `command -v gh git` with its bash tool (pi's RPC `bash` command): both resolve to the app's folders although the runner has its own on the machine PATH.
- **`stack-check.yml`**: weekly and on any change to `stack.json`: `scripts/check-stack.mjs` downloads every asset for every platform key and compares its SHA256, and runs `npm view <name>@<version> dist.integrity` for every package.

### What runs headless, and what does not

| Runs in CI | Does not run in CI, and where it is checked instead |
| --- | --- |
| The wizard from zero to the GUI, both languages, reduced motion | Claude sign-in and a real model turn (needs a subscription and a browser): VM and macOS, author present |
| Every install stage, resume after a kill, rollback (unit and e2e) | GitHub device approval (needs a person): VM and macOS, author present |
| GitLab token login and the keyring verdict (with the test secret) | SmartScreen and Mark-of-the-Web dialogs, Smart App Control: VM |
| The macOS refusal with a locked login keychain (at the store probe); the post-login logout on plain-text evidence, on the kit's nine fixtures | The Windows refusal with Credential Manager unavailable: VM, in a network-logon session (where the account check found Credential Manager failing), with a test-account token. The post-login logout itself already ran for real on both CLIs in the account check (`Remove-Login`) |
| The follower: restart, kill, stop, Start | Gatekeeper's first-open dialog and the move to Applications: macOS |
| Sleep and resume as `powerMonitor` events emitted by the test | A real sleep of 5 minutes and more: VM and macOS |
| The native folder dialog, with `dialog.showOpenDialog` replaced from the test through `electronApp.evaluate` | The real dialog: VM and macOS |
| Silent update 0.0.1 to 0.0.2 against a local feed (Windows) | The camera and Straw Link's QR join: macOS |
| `stack.json` signature checks and a rolled-back failed update | WARP and company networks: VM, per the scout |

## Upstream seams

Each is a stopgap here, as thin as possible, and an upstream change; none is built in this repository beyond the stopgap named.

| # | Package | Gap | Stopgap here | Proposed upstream change |
| --- | --- | --- | --- | --- |
| U1 | herdr | a Windows pane rebuilds `PATH` from the registry, so the app's tools are invisible there (reported after the spike) | `tools\shims\pi.cmd`, one user PATH entry, pass-through outside a desk pane | keep the server's `PATH` for panes on Windows, or a config key for a pane's extra `PATH` |
| U2 | pi-straw-boss | a restart keeps port and token (D27), so only `server.json` `pid` and `started` show that it happened | the follower compares them | `server.json` `restarts: { count, last: { at, reason } }` |
| U3 | pi-straw-boss | the shell cannot tell whether agents are working, for keep-awake and for warning before a quit | keep-awake means "while the app is open"; no quit warning | a documented field, e.g. `server.json` `busy: { sessions, since }`, or one in `cli.mjs status` |
| U4 | pi-straw-boss | no way into the desk's settings from the GUI | the app menu and banners | a page item shown when `globalThis.strawBossDesk.openSettings` exists, like S10's `pickFolder` |
| U5 | pi-straw-boss | `up` omits `started` until the server knows it (Windows) | the app keeps the child handle, or reads it through PowerShell on adoption | desk B7 P3: `up` waits for it or says `startedPending` |
| U6 | pi | first start downloads `fd` and `rg` without a pin | the `fd-rg` stage provisions them | a documented switch that forbids the download and uses what `bin/` holds (check whether `PI_OFFLINE` already covers it) |
| U7 | pi | `pi install` resolves a package's dependencies afresh, so only the top package is pinned | none; recorded as a supply-chain limit | install a package's published lockfile, or accept one |
| U8 | team-toon-tack | `ttt init` prompts (design seam) | `ttt init -y` with `LINEAR_API_KEY` in the environment, falling back to a failure that names the step | non-interactive flags that need no TTY |

Claude Code keeping its Windows login in a file is Anthropic's choice, not a seam we can propose; it is recorded under Secrets.

## Followups absorbed

| Followup | Where |
| --- | --- |
| RC-F002, P3R-F001: `safeRel` refuses trailing dot or space and device names, matched on the part before the first dot, plus `conin$`, `conout$`, `com0`, `lpt0` | task 6 |
| RC-F003: `writeAtomic` opens its temp with `wx` and re-checks parent folders right before each write | task 6 |
| RC-F004: `use-team --file` takes only manifest-managed files, without duplicates | task 6 (settings' **Use the team version**) |
| RC-F005, P3R-F002: `neutralize` closes an open fence, handles short `=` and `-` underlines, escapes `<pre>`, `<script>`, `<?`, `<![CDATA[` openers | task 6 |
| A hard kill between `pi install` and the skills-only listing | task 6: the stage's `detect` requires the skills-only listing, so a resume repeats both (engine contract) |
| P3R-F003: reads and deletes after planning are not re-checked for links | accepted: a same-user race only; recorded in the module |
| R3-F001: YAML keys case-insensitive, multi-line values skipped | task 9 |
| R3-F002: unset `GLAB_SKIP_TLS_VERIFY` and `SKIP_TLS_VERIFY`; keep proxy and CA variables | task 5 |
| R3-F003: the token search lists linked folders and missing roots as unread | task 9 |
| R-F009: hash check of installed binaries in every binary stage | tasks 4 and 5 |
| Wizard: refusal when the store is unavailable, masked token field, device-code screen | task 9 |
| macOS account checks with a separate keychain or throwaway account | task 15 |
| WARP | **Network** above; task 14 |
| desk-pin-051: `view`; the agent folder inside home; restarts seen only through `pid` and `started` | tasks 7 and 3; seam U2 |

## Acceptance

The phase is done when:

1. `wizard-from-zero.yml` passes on `windows-2025` and `macos-15`, five runs in a row on each (the stack downloads from the internet, so one green run is not enough).
2. The Windows VM pass (task 14) and the macOS pass (task 15) have every item PASS or a finding with a severity, with P0 and P1 findings fixed and re-run.
3. The account checks of team-profile section 8 pass through the wizard on both platforms: gh device login with `tokenSource` `keyring`, glab token login with no token in `config.yml`, a push through each helper without a prompt, and the refusal when the store is unavailable.
4. The design record's **Status** says phase 2 is done, and its seams table carries U1 to U8.

## Tasks

Each task is sized for one worker and has its own Reality anchor.
They run in order, each on its own branch from `main` after the one before merges, unless **Parallel** says otherwise.
A task that touches a shared contract, authorization or credentials, or security (tasks 4, 9, 11) gets one fresh-context `reviewer` before merge, per the author's rule.

### 1. App skeleton and CI

- **Files/area:** `app/` (package.json with Electron 45.0.0, TypeScript 7.0.2, electron-builder 26.18.0, Playwright as a test dependency), `app/src/main/index.ts` (single instance, `BaseWindow` with the two views, menus, `userData` moved), `app/src/renderer/` (one welcome screen, `style.css`, `i18n/en.ts`, `i18n/zh-TW.ts`), `.github/workflows/ci.yml`.
- **Behavior:** the packaged app opens on the welcome screen in the OS language with a switch; the UI-rule tests exist (i18n parity, CSS-only animation, uniform borders).
- **Constraints:** no runtime dependency besides electron-updater (added in task 11); `STRAW_BOSS_DESK_ROOT` honored.
- **Reality anchor:** `ci.yml` green on `windows-2025` and `macos-15`; a Playwright test launches the packaged app on both and uploads screenshots in en and zh-TW; the reduced-motion test finds no running infinite animation.
- **Depends on:** none.

### 2. `stack.json`

- **Files/area:** `stack.json`, `stack.schema.json`, `scripts/check-stack.mjs`, `.github/workflows/stack-check.yml`.
- **Behavior:** the kit's `pins.json` content with platform keys `win32-x64`, `darwin-arm64`, `darwin-x64` (Windows is x64 only, by the Decisions table), plus macOS Node and herdr (from `spike/mac/env.sh`), dugite-native Git for macOS, `fd` and `ripgrep`, the profile package entry, `schema`, `generation`, `minShell`; playwriter dropped; ttt kept as an optional entry.
- **Reality anchor:** `check-stack.mjs` passes on both runners (every asset's SHA256 and every package's registry integrity); a schema test refuses a missing SHA256, an unknown platform key, and a non-exact version.
- **Depends on:** none. **Parallel:** with task 1.

### 3. Layout and environment

- **Files/area:** `app/src/main/paths.ts`, `env.ts`, `platform/` (interfaces and both implementations for Processes, UserPath, CredentialStore, Locate).
- **Behavior:** the layout and its constraints (agent folder inside home by `realpath.native`, macOS socket length and its fallback, recorded once in `state/layout.json`); the constructed environment and its unset list.
- **Reality anchor:** unit tests on both runners: a CJK and a space-containing root; on Windows a junction that points `LOCALAPPDATA`-like folders outside home moves the agent folder; on macOS a long user-name path takes the `~/.straw-boss-desk/config` fallback; the built environment carries none of the forbidden variables even when the test sets them all.
- **Depends on:** task 1.

### 4. Engine core

- **Files/area:** `app/src/main/bootstrap/` (`engine.ts` as a `utilityProcess`, `graph.ts`, `stage.ts`, `state.ts`, `download.ts`, `extract.ts`, `log.ts` with the redactor and rotation).
- **Behavior:** the stage contract, staging and activation, resume, rollback, failure categories, logs; installed-file hashes recorded and checked by `detect` (R-F009).
- **Reality anchor:** unit tests against a local HTTP fixture server (test code only): a wrong SHA256 activates nothing and is never retried; killing the engine mid-stage and resuming re-runs only that stage and leaves no staging folder; a failing verify of version B leaves version A active; a corrupted installed binary fails `detect`; no log line holds a planted token or GUI URL. Reviewer before merge.
- **Depends on:** task 3.

### 5. Tool stages

- **Files/area:** `bootstrap/stages/` for `preflight`, `node`, `git`, `herdr`, `fd-rg`, `gh`, `glab`, `launchers` (port of `forge-cli.mjs`, R3-F002), `git-helpers`.
- **Behavior:** as the **Stages** table says, both platforms.
- **Reality anchor:** an e2e-light test on both runners runs these stages from an empty root: all verified, each `--version` through its launcher, each Git helper run through Git's `sh`; a second run is all `skipped-verified` in under 30 s; the Windows run sees the runner's machine-PATH `gh` and still resolves the launcher.
- **Depends on:** task 4.

### 6. pi, packages, and the profile installer

- **Files/area:** stages `pi`, `pi-shim`, `pi-settings`, `profile`, `pkg:*`, `team-pkg:*`, `claude`; `app/src/main/profile/team-profile.ts` (port of `lib/team-profile.mjs` with RC-F002, RC-F003, RC-F004, RC-F005, P3R-F001, P3R-F002); the kit's npm failure wording.
- **Behavior:** as the **Stages** table says; the profile installs from the npm profile package.
- **Reality anchor:** the kit's node tests for the installer and the forge module, moved with them, pass on both runners, plus new cases for each followup; from an empty root, `pi --mode rpc --no-session --offline` with `get_commands` lists `skill:pm-workflow` and stderr is empty, and `<agent>/bin` holds the pinned `fd` and `rg`, unchanged, after that first start; on Windows, `pi.cmd` run from a plain `cmd` with another `pi` on the PATH runs that other `pi`.
- **Depends on:** task 5.

### 7. Runtime supervisor

- **Files/area:** `app/src/main/runtime/`, the GUI view's preload (`pickFolder`), window and page security, power events.
- **Behavior:** start, stop, follow with restart detection and `view`, crash budgets, sleep grace, single instance, `before-quit`, Windows `session-end`.
- **Reality anchor:** an e2e test on both runners from a root that task 6's stages filled: start, GUI 200 in the view; `cli.mjs restart` logged as a restart with the window live; `kill` of the sb server followed within 15 s; `/boss gui stop`, then **Start**; an emitted `suspend` and `resume` with the URL briefly down runs no `up`; `pickFolder` with the dialog stubbed opens a base under the work folder; quit leaves no recorded process; after the app's main process is killed, the stack keeps running and the next launch reaches the GUI in under 30 s without a second Herdr.
- **Depends on:** task 6.

### 8. Wizard and settings

- **Files/area:** `app/src/renderer/wizard/`, `settings/`, `screens/`, `banner/`, the shell preload; the recipe and trust steps on `recipe/validate.mjs`; the work folder step; the install and start steps on tasks 4 to 7.
- **Behavior:** steps 1 to 6 and 11 of **First run**, every sign-in step as a **Later** placeholder; settings' sections with real Updates and Diagnostics placeholders filled by tasks 11 and 12.
- **Reality anchor:** `wizard-from-zero.yml` in its first form passes on both runners: from zero to the GUI with all sign-ins **Later**; an invalid recipe is refused with field and rule and no value; quitting during install and relaunching opens on the install step and finishes.
- **Depends on:** task 7.

### 9. Accounts

- **Files/area:** `app/src/main/accounts/` (store probe, Claude, forges with the ported verdict and R3-F001, Linear with `safeStorage` and the `ttt` stage), `token-search.ts` (R3-F003), the sign-in screens.
- **Behavior:** steps 7 to 9 of **First run**, the code-host screens, settings' Accounts.
- **Reality anchor:** with the GitLab test secret on both runners, token login, verdict PASS, token search 0 hits over the whole root; on `macos-15` a sign-in with the keychain locked stops at the probe with the refusal and no token on disk; the masked field's value is absent from the renderer's storage and every log after sign-in (searched); verdict unit tests cover each R3-F001 case and every fixture of the kit's nine. Reviewer before merge.
- **Depends on:** task 8.

### 10. Projects and recipe updates

- **Files/area:** the projects step (clone, `set-head`, `open-base` through the GUI's HTTP endpoint as `gui-client.mjs` calls it), relay and AGENTS.md block through the installer, recipe updates from `updateUrl`.
- **Behavior:** step 10 of **First run**; settings' Team recipe; the fetch rules of team-profile section 5 (https, no credentials, at most 3 redirects, 256 KB, public host re-checked on the resolved address and every redirect).
- **Reality anchor:** in `wizard-from-zero.yml` the public repository is cloned and opened as a base (it appears in `herdr workspace list` and in the page); an existing folder with another `origin` is reported and untouched; unit tests for each fetch rule against a local server; an update served from this repository's raw URL shows its change list and applies.
- **Depends on:** task 9.

### 11. Updaters

- **Files/area:** `app/src/main/update/shell.ts`, `stack.ts`, `scripts/sign-stack.mjs`, `test/fixtures/feed/`.
- **Behavior:** **Updater** as written, both channels.
- **Reality anchor:** on `windows-2025`: build 0.0.1 and 0.0.2, install 0.0.1 silently, update through the local feed, 0.0.2 runs and the stack is back; on both runners: a signed candidate applies; a wrong signature, a lower `generation`, and a `minShell` above the app are refused; a candidate whose pi stage fails rolls back, the stack starts on the old generation, and the report names the stage. Reviewer before merge.
- **Depends on:** task 8. **Parallel:** with tasks 9 and 10 (no shared files).

### 12. Diagnostics and the PM guide

- **Files/area:** settings' Diagnostics (collect, repair, status), `README.md` and a zh-TW PM guide with the install path per platform.
- **Reality anchor:** the collected zip holds no file from the excluded folders and no planted token (test); **Repair** after deleting a pi package reinstalls it and the stack starts.
- **Depends on:** task 10.

### 13. Full anchor run

- **Files/area:** `wizard-from-zero.yml` in its final form (steps 1 to 10 of **Workflows**), nightly runners.
- **Reality anchor:** five consecutive green runs on `windows-2025` and `macos-15`; one green nightly on `windows-11-arm` and `macos-15-intel`, or a finding per failure.
- **Depends on:** tasks 10, 11, 12.

### 14. Windows VM acceptance

- **Files/area:** a report at `~/.local/share/sbd-review/phase2-vm/report.md`; the kit's state in the VM reset first.
- **Reality anchor:** every item PASS or a finding: the installer downloaded in Edge with Mark-of-the-Web (Edge warning, SmartScreen dialog, screenshots for the guide); Smart App Control state read and its registry value confirmed; the wizard from zero on the CJK profile; Claude sign-in and a real model turn; gh device login and glab token login with the verdicts, a push through each helper, token search; the refusal in a network-logon session with a test-account token; `safeStorage` roundtrip in the packaged app before and after an update 0.0.1 to 0.0.2, and whether any SmartScreen prompt appears on the update; a real sleep of 5 minutes; WARP steps as the scout's result says.
- **Depends on:** task 13. Run by whoever drives the VM, with the author for the sign-ins.

### 15. macOS acceptance

- **Files/area:** a report at `~/.local/share/sbd-review/phase2-mac/report.md`, run as a separate macOS user or with a dedicated keychain, never the author's own logins, Herdr, or `~/.pi`.
- **Reality anchor:** every item PASS or a finding: Gatekeeper's first open and **Open Anyway** (does it ask for an administrator password), the move to Applications; the wizard from zero; Claude sign-in, where its credentials land, a model turn; gh and glab logins with the verdicts and gh's `tokenSource` value on macOS; the Linear key's Keychain prompt after an ad-hoc-signed update; a real sleep of 5 minutes; the camera permission prompt from the GUI's QR join.
- **Depends on:** task 13. **Parallel:** with task 14.

### 16. Retire the spike and update the records

- **Files/area:** `spike/` removed (the docs under `docs/spikes/` stay); `docs/specs/2026-10-25-design.md` Status and seams (U1 to U8), Tools table (dugite-native, `fd`, `rg`, playwriter dropped).
- **Reality anchor:** `ci.yml` and `wizard-from-zero.yml` green after the removal; no file outside `docs/` refers to `spike/`.
- **Depends on:** tasks 14 and 15 with no open P0 or P1.

## Risks

- **The pi shim (U1)** is the only thing between a Windows pane and the machine PATH. If a pane starts pi by another path (a full path to `node`), the shim is skipped and the agent finds the machine's `gh`. Task 6's anchor reads the PATH from inside a real pane; Herdr's fix (U1) removes the risk.
- **Smart App Control** can block unsigned `herdr.exe` on a fresh Windows 11 whatever the app's own signature. Only a signed herdr release fixes that; the preflight at least says so.
- **Nested bases.** The home base is the work folder, and each clone is a base in a folder under it. Task 10's anchor opens one; if pi-straw-boss refuses a base inside another base's folder, the home base moves to a sibling folder and the finding goes upstream.
- **The macOS path with a space** may break a tool that writes an unquoted path into a script or a shebang. CI runs under it, so it fails early.
- **Floating transitive dependencies (U7)**: a package's dependency can change between two installs of the same pin. Registry integrity covers only the top package.
- **CI network**: the anchor downloads about 1 GB per run from nodejs.org, GitHub, gitlab.com, and npm. A provider outage fails the anchor without a bug; the five-run rule and the failure categories make that visible.
- **Account checks need people and test accounts**: the device flow and the Claude sign-in cannot run unattended, and the store-unavailable refusal needs a token that is not the author's main one.

## Open for the boss

1. **Windows code signing.** Recommendation: stay unsigned through the pilot, as the design record decides, and buy an OV code-signing certificate with cloud signing before more than the pilot PMs install it. Azure Artifact Signing is not available to Taiwanese individuals or organizations. A certificate costs on the order of a few hundred US dollars a year, and SmartScreen still warns until reputation builds.
2. **Apple Developer Program** (US$99 a year; an organization membership needs a D-U-N-S number). Recommendation: join before any PM pilots on a Mac. Without it the PM must click **Open Anyway** in System Settings, which may need an administrator password; updates mean downloading a dmg by hand; and the Linear key may ask for Keychain access after each update.
3. **The app's name, icon, and application id.** Recommendation: the name "Straw Boss Desk" in both languages, an icon drawn from the straw-boss mark, and an id under a domain the boss controls, e.g. `tw.wayneh.straw-boss-desk`. The internal folder name `straw-boss-desk` stays whatever is chosen.
4. **One user PATH entry on Windows (seam U1).** The repository says the app never writes to the user's global setup. The shim adds one entry, first on the user PATH, that passes every call through to the user's own `pi` outside the app's panes, and the uninstaller removes it. Recommendation: allow it until Herdr keeps the server's PATH for panes. The alternative is agents not finding the app's Git and code-host CLIs on Windows.
5. **Test accounts and CI secrets.** Recommendation: a dedicated gitlab.com account with one empty project and an `api` token (one year expiry) as an Actions secret, for the CI login and the VM's refusal check; a dedicated GitHub account for the device-flow checks, so neither touches the boss's own logins; an Ed25519 signing key for `stack.json`, generated by us and stored as an Actions secret. Adding repository secrets needs the boss's approval.
