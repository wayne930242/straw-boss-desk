# Phase 2: the shell

Status: written 2026-11-01. The boss approved starting phase 2 that day (「我都同意」) and left technical choices to our recommendation (「技術上都按照你們的建議」).
Revised the same day after the review in `~/.local/share/sbd-review/phase2-spec/review.md` (findings P2S-F001 to F026), with two boss decisions of 2026-11-01 written in: the existing sign-in rule (K1, **The code-host screens**) and the macOS account-check design 1b (task 17).
Revised again after the recheck in `~/.local/share/sbd-review/phase2-spec/recheck.md` (R-F001 to R-F015; **Review status** at the end), and a third time after the second recheck in `recheck2.md` (R2-F001 to R2-F012, no P0 or P1; **Recheck 2 status** at the end).
Revised a fourth time for the four FE2 asks (and the private-host prerequisite they bring) the CTO approved on 2026-11-01 (**FE2 asks**; the design is `scratch/pm-workflow/design.md` §4.3 in moldplan-center).
Technical choices below are made, each with its reason; only the items in **Open for the boss** wait for a decision.

Sources: `docs/specs/2026-10-25-design.md` (phases, work order item 4, the tools table, architecture); `docs/specs/2026-10-27-team-profile.md` (sections 4, 5, 7, 8, **What phase 2 must also settle**, Tasks 4 to 7); `docs/specs/2026-10-28-desk-b7.md` (start and stop order, exit codes, the follower); the kit in `spike/win/` and `spike/mac/` at `da9ea73`; `~/.local/share/sbd-review/profile-stage/followups.md`, `~/.local/share/sbd-review/account-check/followups.md` and `report.md`; `~/.local/share/sbd-review/desk-pin-051/report.md`; `~/.local/share/sbd-review/vm-warp/report.md` (the WARP diagnosis); `~/.local/share/sbd-review/mac-account/design.md` (K1, K2, option 1b, and the boss's decisions at its end); pi-straw-boss 0.51.0 sources (`src/trust/files.ts`, `src/spawn.ts`, `src/agent/paths.ts`, `gui/picker.ts`, `gui/desk.ts`, `gui/style.css`, `docs/how-it-works.md`); pi-herdr-agents 3.6.1 (`maestro/surfaces/herdr/terminal.ts`, `maestro/adapters/pi/launch.ts`).

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
| Archive extraction | the system `tar` (bsdtar, on Windows 10 1803+ and macOS) called by absolute path (`%SystemRoot%\System32\tar.exe`, `/usr/bin/tar`), PortableGit's own self-extractor | no npm dependency, and the kit already proved both on Windows; a Git-for-Windows GNU `tar` earlier on the PATH cannot read zip and takes `C:` for a remote host |
| Downloads | Electron's `net` module in the engine's `utilityProcess` | it uses the OS proxy settings and certificate store, so a company proxy or inspecting CA works for the engine's own downloads (**Network**) |
| Git on macOS | dugite-native (`desktop/dugite-native`, the relocatable Git that GitHub Desktop ships; v2.56.0-2 has `macOS-arm64` and `macOS-x64` tarballs with `.sha256` files) | `/usr/bin/git` on a bare Mac is a stub that asks to install the Xcode tools; dugite needs no install and no admin |
| Git on Windows | PortableGit, as in the kit | pi needs its `bash.exe` |
| Windows architecture | x64 app and x64 tools everywhere, also on Windows ARM | herdr has no arm64 build, and the VM proved the all-x64 stack under emulation |
| macOS architecture | separate arm64 and x64 builds, tools per architecture | every pinned tool ships both |
| playwriter | dropped from the default stack | no role or skill in the profile uses it now that visual-tester is out of v1, and it needs a Chrome extension installed by hand |
| ttt | installed when the PM saves a Linear key, not before | it is only the Linear client |
| Optional tools (bun) | `stack.json` lists them apart from the required tools (`optionalTools`); a recipe turns one on with `tools`; a tool the recipe does not name has no stage, no launcher, and no `PATH` entry. bun 1.2.23 is the first, on the x64 platforms in its `-baseline` build | FE2 can be installed and started only with bun (the PM channel's `pm-dev`), and a recipe could add skills but no tool; installing it for everyone would put a runtime on every PM's machine for one team. The baseline zips need no AVX2, so a CPU or an emulator without it (a VM, x64 emulation on Windows ARM) works; Apple Silicon has no baseline build and uses the regular one |
| `fd` and `rg` | provisioned by a pinned stage into pi's own `bin` folder before pi's first start | pi otherwise downloads them on first start without our pin (mac spike finding 5), which breaks the repository's SHA256 rule |
| Renderer | plain TypeScript and DOM modules compiled by `tsc`, no framework, no bundler | the pi-straw-boss page is written the same way, and it keeps the dependency list short |
| Window | one `BaseWindow` with two `WebContentsView`s: the GUI view and the shell view (wizard, settings, screens, banners) | each page gets only its own preload, and the GUI stays loaded while a shell screen or banner covers it |
| Preview links | besides `https:`, the GUI's window rules open in the default browser an `http:` URL on `localhost`, `127.0.0.1` or `[::1]` with a port from 8080 to 8100 (**Window and page security**) | the CTO's ask: a PM must be able to open the preview that `pm-dev` serves. The range is fixed, not a recipe setting, for two reasons: it is the CTO's ask, and a narrow set of loopback ports limits what a link shown in the GUI (from an agent's text or a web page) can make the PM's browser send to other services on the PM's own machine, which is the reach of a cross-site request forgery. 8080 to 8100 is also the range the staging back end's CORS allows from localhost (the PM workflow design, section 4.1). A range set by the recipe is under **Deferred** |
| Work folder | `~/StrawBoss` (`%USERPROFILE%\StrawBoss`), holding the home base and the clones side by side | team-profile decision 12 fixed `~/StrawBoss` |
| Home base | `<work folder>/Straw Boss`, label `Straw Boss`, a sibling of the clones, not their parent; the folder name is reserved in recipe validation. Recommended and built this way unless the boss chooses otherwise (**Open for the boss**, item 7) | a base that contains the clones would share its pi trust and its `AGENTS.md` with every clone (**Risks**, nested home base) |
| Window close | macOS: closing the window keeps the app and the stack running, Quit stops them; Windows: closing the window quits and stops | each platform's convention; on Windows it ends every running agent with no warning until seam U3, a notice for the boss (**Open for the boss**, item 11) |
| Keep awake | a setting, off by default | a laptop that never sleeps surprises people; the setting becomes "while agents work" once pi-straw-boss exposes that state (seam U3) |
| Telemetry | none from the app, and every bundled CLI's own telemetry switched off by environment: `GH_TELEMETRY=disabled` and `DO_NOT_TRACK=1` in the launchers; `PI_TELEMETRY=0`, Claude Code's `DISABLE_TELEMETRY=1` and `DISABLE_ERROR_REPORTING=1`, and `NPM_CONFIG_UPDATE_NOTIFIER=false` in the constructed environment; glab 1.124.0's setting checked in task 5 and set the same way | nothing in v1 needs it, it would be a new external service, and gh 2.103.3 records the storage choice of a login unless told not to (`mac-account/design.md` K2) |
| Existing gh or glab sign-ins (K1, boss decision 2026-11-01) | before a login the app looks for gh and glab credential-store entries for that host; if one exists that the app does not own, it stops and explains; it never logs out or overwrites an entry it does not own. It owns an entry only while the entry's name and its store modification time (macOS `mdat`, Windows `CREDENTIAL.LastWritten`) both equal what it recorded right after its own login; a changed, missing, or unreadable time means foreign. gh logs in with `--expiring=false`, so gh's own token refresh never rewrites the app's entry | gh and glab name their store entries by host only, whatever `GH_CONFIG_DIR` or `GLAB_CONFIG_DIR` says, so a login or logout by the app would replace or delete the PM's own token; a PM's own later login writes the same name, so the name alone proves nothing, while every write changes the modification time (to the second on macOS). The time is read without reading the secret on macOS; on Windows the listing API hands each secret to the listing helper's memory, which copies only the name, the user, and the time (**The code-host screens**, **Ownership**) |
| Electron fuses | `RunAsNode` and `EnableNodeOptionsEnvironmentVariable` off; `EnableNodeCliInspectArguments` on in v1 | the first two let any same-user process run the app binary as plain Node; the inspect fuse stays on because the Playwright driver needs it and the anchor must drive the shipped build; it goes off with signing, when the Keychain access list makes the binary's identity matter, and the tests then drive a separate test build |
| `stack.json` channel integrity | an Ed25519 signature (`node:crypto`), public key built into the app, a monotonically increasing `generation` | `stack.json` carries every SHA256 pin, so whoever can change it controls every download; HTTPS alone trusts the host |
| E2E driver | Playwright's Electron support (`_electron.launch`), a dev dependency of the tests only | it drives the packaged app without a test hook in the product |
| Test model | the kit's `stub-llm.mjs` (an OpenAI-compatible stand-in on 127.0.0.1), configured by the test harness, never by the app | CI cannot sign in to Claude; a pi turn still has to run in the stack |
| Data root override | `STRAW_BOSS_DESK_ROOT` (and `--root=`) are honored in every build | the author's Mac must run development builds against their own app data folder (repository AGENTS.md), and CI uses the same switch |
| Development builds | every build not made with `SBD_BUILD=release` is named `Straw Boss Desk Dev`, with the application id's `.dev` suffix; CI's anchor and the release build use `SBD_BUILD=release` | on macOS `safeStorage`'s Keychain item is named after the product ("`<product>` Safe Storage"), not the data root, so a development or test build with the shipped name would write and delete the item an installed app on the same Mac uses (**Fixtures that change the machine**) |

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
│  ├─ accounts/              claude.ts, forge.ts (from forge-cli.mjs and account-verdict.ps1), linear.ts, probe.ts, existing.ts (K1: the entry check and the record), token-search.ts (tests and diagnostics)
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
The kit uses the same Windows folder; a VM that ran the kit is reset before the app runs there (task 16).

```text
<root>/
├─ stack/            active.json, previous.json, candidate.json + .sig
├─ tools/
│  ├─ node/<version>/  git/<version>/  herdr/<version>/  gh/<version>/  glab/<version>/
│  ├─ bun/<version>/ only when a recipe names bun; bun-home/ is its BUN_INSTALL (cache and global packages), see Tool paths
│  ├─ npm/           private npm prefix (pi; ttt when Linear is on)
│  ├─ npm-cache/
│  ├─ downloads/     verified archives, the cache for repair and rollback
│  ├─ bin/           launchers: gh, glab, and bun when a recipe names it (POSIX and .cmd); paths.sh and paths.cmd (generated: the active tool folders, see Tool paths)
│  └─ shims/         Windows only: pi.cmd, pi (POSIX), bash.cmd; the one user PATH entry (see Environment)
├─ agent/            PI_CODING_AGENT_DIR (pi's bin/ holds the provisioned fd and rg)
├─ config/           XDG_CONFIG_HOME: herdr/ (config, session, socket), gh/, glab-cli/, zsh/ (macOS: ZDOTDIR for panes)
├─ claude/           CLAUDE_CONFIG_DIR
├─ gitconfig         GIT_CONFIG_GLOBAL
├─ secrets/          safeStorage blobs (linear.bin)
├─ recipe/<id>.json
├─ state/            bootstrap.json, current.json (active tool versions), start.json, wizard.json, layout.json, accounts.json (the store entries the app created, each with the modification time it read right after its login, and those it created but did not remove, marked `left`; no secrets)
├─ logs/             shell.jsonl, bootstrap.jsonl, start.jsonl, per-stage logs
└─ electron/         app.setPath("userData"): Chromium's profile and caches
```

Constraints, each checked by the preflight stage and recorded once in `state/layout.json`, so a later start never computes another place:

- **The agent folder lies inside the user's home on Windows.** pi-straw-boss's trust relay accepts its folder only when `realpath.native(dir)` is inside `realpath.native(home)` (`src/trust/files.ts`, `ensureDir`); elsewhere a pi asks its trust question in the terminal, where the PM never looks. `%LOCALAPPDATA%` normally passes. When folder redirection or a junction puts it outside, the agent folder goes to `%USERPROFILE%\.straw-boss-desk\<id>\agent` instead, and the rest stays.
- **The Herdr socket stays at most 100 bytes on macOS.** `sun_path` holds 104. Herdr's default socket for the app's `XDG_CONFIG_HOME` is what makes the sb server the primary one (desk B7 plan, Q1), so the socket cannot move alone: the whole `XDG_CONFIG_HOME` moves. `<root>/config/herdr/herdr.sock` is 75 bytes plus the user name; above 100, `XDG_CONFIG_HOME` becomes `~/.straw-boss-desk/<id>/config` (57 bytes plus the user name for the socket).
- **A fallback folder belongs to one root.** `<id>` is the first 8 hex digits of the SHA-256 of the root's real path, so two roots that both fall back (a development root with a long name beside an installed app) never share a Herdr socket or an agent folder. `state/layout.json` records the fallback folder, and **Remove all data** deletes it with `<root>`.
- **pi-straw-boss's agent sidecar sockets** (`<agent>/straw-boss/agents/<16 hex>.sock`, `src/agent/paths.ts`) have no short-path fallback; under the default macOS root they are 97 bytes plus the user name. Only non-pi agents in the GUI use them, and the v1 profile starts none. The preflight records the length in `state/layout.json`, and the fallback goes upstream (seam U11).
- **The root's path has a space on macOS** ("Application Support"). Every launcher and helper quotes its paths already; the macOS CI anchor runs under the default root, and the Windows one under a root with a space and CJK characters (**Workflows**), so a quoting bug fails CI on both.
- **Chromium's profile is moved into `<root>/electron`**, so nothing lands in the roaming `%APPDATA%`. `app.setPath("userData")` runs before `requestSingleInstanceLock`, which is keyed on it. On Windows `safeStorage`'s key is wrapped by DPAPI and kept in `<root>/electron/Local State`, so **Repair** and **Collect diagnostics** never reset or remove that folder; only **Remove all data** does, last.
- **Free space**: 3 GB, checked before the first download (the Windows install measured about 1.5 GB).

## Bootstrap engine

### Stage contract

A stage is `{ name, needs, detect, install, verify, activate }`.

- `detect` runs first and only reads. It returns evidence when the stage's pinned version is active and its recorded file hashes still match (followup R-F009: a binary is checked by the SHA256 of its executables as recorded at install, not by `--version` alone). Evidence means the stage is `skipped-verified`. A stage whose output names another stage's version (a `tools/<tool>/<version>` folder) keeps those versions in its evidence, and any change of one fails `detect`, so the stage is written again (**Tool paths**).
- `install` writes only into a staging folder (`tools/<tool>/<version>.staging/`, or a staging copy of the files it edits).
- `verify` runs the staged result (`--version` through its launcher, the installer's dry run, `npm view` integrity) and must return evidence.
- `activate` makes the result the active one in one step: a rename of the staging folder, then a write of `state/current.json` by rename.

The graph runs stages whose `needs` are done; independent downloads run three at a time, npm and pi steps one at a time (they share the npm cache and prefix).

### Stages

| Stage | Needs | Notes |
| --- | --- | --- |
| `preflight` | | OS version, architecture, free space, the layout constraints above, Windows Smart App Control state (see SmartScreen), whether `bash` in a PowerShell pane would resolve to WSL's `System32\bash.exe` (Environment; this check also runs at every start), reachability of each download host with the host named in the failure, reachability of each forge host the active recipe names (the welcome screen's pass has no recipe yet, so this part runs when the install step starts; a host that does not resolve or does not answer gets the sentence of **Network**, **A private code host**; this part is a warning, not a failure: `preflight` passes and records the host in `state/bootstrap.json`, so node, Git, pi, and the optional tools still install, and the check runs again at the projects step and the GitLab step, so a PM who connects to the network meanwhile goes on; a GitLab host typed under **I have no recipe** gets the same warning at the GitLab step), and a TLS failure with an unknown issuer named as "a proxy or certificate inspection" (**Network**) |
| `node` | preflight | official zip or tarball |
| `git` | preflight | PortableGit (Windows), dugite-native (macOS); writes the private `gitconfig` (identity placeholder, `core.longpaths`, `init.defaultBranch`) |
| `herdr` | preflight | release binary; writes Herdr's config: no version or manifest check, no sounds, no onboarding, `shell_mode = "non_login"` on macOS (mac spike finding 6); the pane shell is PowerShell on Windows (Herdr's default) and `default_shell = "/bin/zsh"` on macOS, whatever the PM's login shell, so the `ZDOTDIR` isolation (**Panes on macOS**) always applies |
| `fd-rg` | preflight | pinned `fd` and `ripgrep` into `<agent>/bin` |
| `gh`, `glab` | preflight | only for the forges the recipe names (team-profile section 4) |
| `opt:<tool>` (today `opt:bun`) | preflight | one stage for each tool under `stack.json`'s `optionalTools` that the active recipe names in `tools`; no stage exists for a tool it does not name, and a recipe that names none runs none. The official zip into `tools/<tool>/<version>/`, flattened (the bun zips hold one folder `bun-<platform>/bun(.exe)`); verify runs `bun --version` through the staged binary and compares it to the pin. It follows the binary-stage rules of **Rollback**, and its hash check is R-F009's |
| `tool-paths` | node, git, herdr, gh or glab, `opt:*` | writes `tools/bin/paths.sh` and `paths.cmd` from `state/current.json` (**Tool paths**); its evidence is the versions it wrote and the optional tools it listed |
| `launchers` | tool-paths | `tools/bin` launchers from `forge-cli.ts`, and one for each optional tool the recipe names (**Tool paths**), deleted again for one it no longer names; the unset list gains `GLAB_SKIP_TLS_VERIFY` and `SKIP_TLS_VERIFY` and keeps the proxy and CA variables (followup R3-F002: a company proxy or CA may need them); they set `GH_TELEMETRY=disabled` and `DO_NOT_TRACK=1`, and glab's telemetry switch if 1.124.0 has one |
| `git-helpers` | git, launchers | the credential helpers in `gitconfig`; verify runs each helper command through Git's own `sh` (the kit's proof of CJK path quoting) |
| `pi` | node | `npm install -g` into the private prefix, registry integrity first |
| `pi-shim` | pi, tool-paths | Windows only: `tools/shims/pi.cmd`, `pi`, `bash.cmd`, and the user PATH entry (see Environment) |
| `profile` | pi | the team-profile installer (section 7), from the npm profile package pinned in `stack.json`; it merges the profile's owned keys into `settings.json` |
| `pi-settings` | profile, git | Windows only: `shellPath` to PortableGit's `bash.exe`, merged into `settings.json`, never replacing the file; the path names Git's version, so its evidence keeps that version |
| `pkg:<name>` | pi-settings | each pi package, registry integrity first, the kit's failure wording for registry trouble |
| `team-pkg:<name>` | pkg:* | each recipe package, skills only; a package that cannot be listed skills-only is removed again |
| `claude` | pkg:pi-claude-bridge | locates the Agent SDK's bundled `claude` executable and runs `--version` |
| `ttt` | pi | runs from the Linear step, not in the first install |

### Tool paths

Node, Git, Herdr, gh, glab, and each optional tool the active recipe names (bun) live in versioned folders (`tools/<tool>/<version>/`), and a stack update changes the versions.
One pair of generated files says which folders are active: `tools/bin/paths.sh` and `tools/bin/paths.cmd`, written by the `tool-paths` stage from `state/current.json`. Each lists the app's `PATH` folders in order (`tools/bin`, Node, the npm prefix, Git's folders, Herdr) and the executables the launchers and shims run (`SBD_GH`, `SBD_GLAB`, `SBD_GIT_BASH`, and `SBD_BUN` when the recipe names bun), every one relative to the root, so the files hold only ASCII (tool names and version strings) and no byte of the root's path.
The shims, the launchers, and the macOS `ZDOTDIR` files hold no version and no path: each finds the root (the shims and launchers from their own place, the `ZDOTDIR` files from `STRAW_BOSS_DESK_ROOT`), reads the paths file (`call "%~dp0..\bin\paths.cmd"`, `. "<root>/tools/bin/paths.sh"`), and joins each entry to the root. They are written once by their stages and never go stale.
The constructed environment (`PATH`, `HERDR_BIN_PATH`, Git's variables) is built from `state/current.json` at each start and before each engine run.
`tool-paths` and `pi-settings` keep the versions they name in their evidence, so any change of `current.json` that touches one of them (a stack update, a rollback, **Repair**) fails their `detect`, and the engine run that made the change writes them again before anything starts. Task 13's anchor opens a pane after an update that changes the versions.

**Optional tools.** The `opt:<tool>` stage runs only when the active recipe names the tool, so a team that does not name bun has no bun stage, no `bun` launcher, no `SBD_BUN` line, and no `tools/bun` folder. For a named tool, `tool-paths` writes its `SBD_<TOOL>` line and `launchers` writes `tools/bin/bun` and `bun.cmd` the way it writes `gh` and `glab`: no version and no path inside, a read of `paths.sh` or `paths.cmd`, and an exec of the tool; the bun launcher also sets `BUN_INSTALL` to `<root>/tools/bun-home`, so bun's cache and global packages stay under the app's `tools/` and not in the PM's `~/.bun`. The evidence of both stages includes the set of enabled optional tools, so adding or removing a name in the recipe fails their `detect` and the engine run that applies the recipe writes them again.
**Removing a tool from the recipe** leaves it installed and takes it off the `PATH`: `tools/<tool>/<version>/` stays on disk, and at the next `tool-paths` run its `SBD_<TOOL>` line is gone and at the next `launchers` run its launcher is deleted, so a new pane no longer resolves `bun` (a pane that was already open finds the launcher gone at its next call). Naming it again needs no download: the stage finds the verified folder and only writes the two stages again. To make that hold, `current.json` keeps a dropped tool's version; `tool-paths` and `launchers` take the active recipe's tool set as an input (a change of the set fails their `detect`), so the `PATH` follows the recipe and not `current.json`; and the prune of inactive versions keeps the folder `current.json` names, dropped or not (FE2R-F001). A stack update that no longer lists an optional tool an active recipe names is refused (**Updater**).

The kit's `user-path` and `forge-path` stages are not ported: they put `tools\npm`, Herdr, Git, and `tools\bin` on the user's PATH, which changes the user's own terminals. The pi shim replaces them (Environment).

### Resume

`state/bootstrap.json` holds, per stage, `status`, `version`, `evidence`, `at`, and the hashes `detect` checks.
Resuming is running the graph again: verified stages are skipped, and a stage that was interrupted finds only a staging folder, which it deletes before it starts over.
The wizard's place (`state/wizard.json`) survives a quit, a crash, or a reboot, and the app opens on the step where it stopped.

### Rollback

The unit is a stage, not the whole run.

- **Binary stages** keep the previous version beside the new one (`tools/<tool>/<old>/`). A failed `install` or `verify` leaves `current.json` untouched; a stack update that fails later points `current.json` back, and the same engine run writes `tool-paths` and `pi-settings` again for the old versions (**Tool paths**). The previous version is deleted after the next successful start.
- **npm and pi stages** roll back by installing the previous pin again; the archives come from the npm cache, so a rollback works offline when the cache holds them.
- **The profile stage** already never overwrites a PM's file; a failed run leaves the manifest from before (the installer writes it last).
- **First install** has nothing to roll back to: the failed stage's staging folder is removed and the stage can be retried alone.

### Logs and failures

Every stage writes JSON lines to `logs/bootstrap.jsonl` (start, each action, result, milliseconds, evidence, `fsErrors` as the kit collects them) and its raw tool output to `logs/stage-<name>.log`.
Every log line goes through one redactor: the GUI URL token (`127.0.0.1:<port>/<token>` becomes `<token>`), every pattern in `recipe/secret-patterns.json`, and, by exact match, every secret value main holds at that moment (the GUI token, `server.json`'s control secret, the GUI's CSRF value when the shell sees one, a GitLab token or Claude login code in flight, the decrypted Linear key).
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
It starts from the system essentials (`SystemRoot`, `USERPROFILE`, `TEMP`, `HOME`, `USER`, `LANG`, …), then sets what the kit's `Set-SbdEnv` sets: `PATH` with `tools/bin` first, then Node, the npm prefix, Git, Herdr; `PI_CODING_AGENT_DIR`; the npm prefix, cache, and `NPM_CONFIG_PREFER_ONLINE=true`; `STRAW_BOSS_DESK=1` and `STRAW_BOSS_DESK_ROOT=<root>` (the Windows shims test both); `XDG_CONFIG_HOME`, `HERDR_CONFIG_PATH`, `HERDR_SOCKET_PATH`, `HERDR_BIN_PATH`, `HERDR_DISABLE_SOUND`; `CLAUDE_CONFIG_DIR`; `GIT_CONFIG_GLOBAL`; `PI_TELEMETRY=0`, `PI_SKIP_VERSION_CHECK=1`.
It adds the telemetry switches of the Decisions table (`DISABLE_TELEMETRY=1`, `DISABLE_ERROR_REPORTING=1`, `NPM_CONFIG_UPDATE_NOTIFIER=false`), and `NODE_USE_SYSTEM_CA=1`, so npm and pi trust the OS certificate store as well as Node's bundled one (supported by the pinned Node 24).
On macOS it adds `ZDOTDIR=<root>/config/zsh` (below) and, if task 5 shows the dugite-native build needs them, `GIT_EXEC_PATH` and `GIT_TEMPLATE_DIR` (dugite's own JavaScript wrapper sets both).
It passes these through from the app's environment when they are set, in either case: `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY`, `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `SSL_CERT_DIR`, `GIT_SSL_CAINFO`.
**The OS proxy setting.** A Finder-launched Mac app and a Windows app behind a WinINET or PAC proxy usually have none of those variables, and npm, Git, gh, glab, pi, and Claude Code read only the variables. So main resolves the OS setting before every engine run (the first install's `pi`, `pkg:*`, and `profile` stages run npm before any start) and at each start before Herdr starts (its environment is fixed for its lifetime). It asks Chromium with `session.defaultSession.resolveProxy(url)` for `https://registry.npmjs.org/`, `https://github.com/`, and `https://<host>/` for each forge host the recipe names. Chromium's answer is a list (`PROXY a:8080; PROXY b:8080; DIRECT`); the first entry is taken, and the rest are logged.

- When the registry's answer is `PROXY host:port` (or `HTTPS host:port`), and the app's environment sets neither `HTTPS_PROXY` nor `HTTP_PROXY`, the constructed environment gets `HTTPS_PROXY` and `HTTP_PROXY` set to `http://host:port`, and `NO_PROXY` set to the loopback names (`127.0.0.1,localhost,::1`, so the GUI's loopback calls never go through it) plus every resolved host whose answer is `DIRECT`. A company GitLab that the PAC file sends `DIRECT` therefore keeps its direct path for Git, glab, and the push.
- The registry's `DIRECT` sets nothing.
- A `SOCKS` answer, or a host whose proxy differs from the registry's (a PAC file routing hosts through different proxies), is logged with every answer and passes nothing, since npm cannot use SOCKS and one variable cannot name two proxies; the preflight's reachability check then names the host that fails.
- Variables the app's environment sets win, unchanged, `NO_PROXY` included.

The engine passes the result to every child it starts; its own downloads keep using Electron `net` directly.
A company network that needs a proxy or its own CA is thus configured for npm, Git, gh, glab, pi, and Claude Code from the OS setting or the variables (**Network**).
It never carries `PI_SUBAGENT_*`, `PI_INTERCOM_SESSION_ID`, `HERDR_*` pane ids, `STRAW_BOSS_ROLE`, `SSH_AUTH_SOCK`, `CLAUDE_SECURESTORAGE_CONFIG_DIR` (it would move Claude Code's Keychain item onto another name, possibly the PM's own; **Secrets**), or any variable in the launchers' unset list.
`LINEAR_API_KEY` is added, decrypted from `secrets/linear.bin`, only to the Herdr server's environment, so panes and `ttt` see it and no file holds it.
An agent can read it from its environment, as it could read a key `ttt` kept in a file; the profile forbids printing it.
Because a running Herdr server's environment cannot change, a key saved in settings while the stack runs reaches panes only after the stack restarts: the Linear section says so and offers **Restart now** (running agents stop and Herdr restores them; the shell cannot yet tell whether they are working, seam U3) or **Later** (the key applies at the next start).

**Panes on Windows.** Herdr rebuilds a pane's `PATH` from the registry (Windows spike), while the other variables reach the pane (desk B7 plan, task 1; `spike/mac/09-pane-env.sh`).
A pane's shell is PowerShell: Herdr starts `pi.cmd` there with `Start-Process -Wait` (pi-straw-boss `docs/how-it-works.md`, the standing-pane note).
Two things are typed into such a pane by name and must resolve there: `pi` (Herdr's `agent start`, pi-straw-boss's bases and towers) and `bash '<script>'` (every pi-herdr-agents subagent and resume: `maestro/surfaces/herdr/terminal.ts` writes a `#!/bin/bash` script whose body runs `pi --session …`, `maestro/adapters/pi/launch.ts`).
Inside that script `pi` is looked up by MSYS bash, which does not apply `PATHEXT`, so a `pi.cmd` alone is not found there; that is why npm writes an extensionless `pi` script beside `pi.cmd`.

The stopgap is one user PATH entry, `<root>\tools\shims`, first among the user entries, holding three files:

- `pi.cmd`, for PowerShell and cmd, and `pi`, a POSIX script for MSYS bash. Neither holds a path: cmd reads a batch file in the OEM code page, so a user folder with CJK characters written into a `.cmd` would be decoded wrongly (the kit's launchers avoid it the same way, `forge-cli.mjs` `cmdLauncher`). Each finds the app's root from its own place (`pi.cmd`: `for %%I in ("%~dp0..\..") do set "SBD_APP_ROOT=%%~fI"`; `pi`: `${0%/*}` and `pwd -W`, shell built-ins only) and makes the same test: in a desk pane (`STRAW_BOSS_DESK=1` and `STRAW_BOSS_DESK_ROOT` equal to that root, compared case-insensitively with any trailing separator dropped; the POSIX `pi` turns every `\` into `/` in both strings first, since `pwd -W` answers `C:/…` and the variable holds `C:\…`; both are runtime strings, never file bytes) they rebuild `PATH` from `tools\bin\paths.cmd` or `paths.sh` (**Tool paths**), with `tools\bin` first, and run the pinned pi under that root (`tools\npm\pi.cmd`, `tools/npm/pi`), so pi, its extensions, and its bash tool find the app's Git, Herdr, `gh`, and `glab` ahead of anything on the machine PATH. Anywhere else they run the next `pi` on the PATH (the shims folder skipped), or say that pi is not installed, so a user's own terminal is unchanged. The shims leave `PI_CODING_AGENT_DIR` as they find it: pi-herdr-agents gives a child `<cwd>/.pi/agent` when that folder exists (`launch.ts`), and that choice stays pi-herdr-agents'.
- `bash.cmd`: in a desk pane it runs PortableGit's `bash.exe` (`SBD_GIT_BASH` from `paths.cmd`) with its arguments; anywhere else the next `bash` on the PATH, or a message that bash is not installed.

Windows puts the machine PATH before the user PATH, so a `bash.exe` on the machine PATH wins over `bash.cmd`. A Git for Windows install there is harmless: its bash runs the script, and the script's `pi` still resolves to the shim's `pi`. WSL's `System32\bash.exe` is not: it would run the script in Linux, where `pi` does not exist, and pi-herdr-agents sees only a nonzero done marker, with nothing naming WSL. The app cannot see that failure, so it names the cause before it happens:

- **The WSL check** reads the machine and user `Path` values with `%SystemRoot%\System32\reg.exe query` (two short processes, no PowerShell, so it never delays the GUI), expands their `%VAR%` entries in main, walks the machine PATH, then the user PATH, as a pane gets them from the registry, checking files only, and reports when the first `bash.exe` or `bash.cmd` it meets is `%SystemRoot%\System32\bash.exe`. Its walk is a pure function of the two values and a file-exists check, all three of which its unit tests pass in. It runs in the preflight, at **Repair**, and at every start (WSL installed after the app is still found).
- **What the PM sees** when it reports: a line on the welcome screen, and at every start a shell banner over the GUI that stays until dismissed for this start: "On this computer, agents cannot hand work to helper agents, because Windows Subsystem for Linux provides its own `bash`. Everything else works." **Details** names `System32\bash.exe` and seam U10. The same sentence is in **Diagnostics**.
- The fix is seam U10 (pi-herdr-agents runs the script through an absolute bash path, pi's `shellPath`). Whether such machines are supported meanwhile is **Open for the boss**, item 10.
The same holds for `pi`: a `pi` on the machine PATH wins over the shim, so the preflight reports one when it finds it.

This replaces the kit's five user PATH entries, and with them the team-profile problem that a `gh` on the machine PATH would win in a pane (section 4, **Isolation**).
It is listed as seam U1, and its existence is in **Open for the boss** because it bends the repository rule against touching the user's global setup.

**Writing the PATH entry.** One module in `platform/win.ts` (UserPath) owns every change, and these rules hold for each:

- It reads the raw `HKCU\Environment\Path` value (`RegistryKey.GetValue` with `DoNotExpandEnvironmentNames`), keeps its type (`REG_EXPAND_SZ` stays `REG_EXPAND_SZ`) and every unexpanded `%VAR%` entry as written, and changes only its own exact entry (compared case-insensitively, trailing backslash ignored). The kit's `[Environment]::Get/SetEnvironmentVariable` round trip expanded `%USERPROFILE%` entries (`bootstrap.ps1:333-339`), and `setx` truncates at 1024 characters; neither is used.
- After a write it broadcasts `WM_SETTINGCHANGE` (`Environment`), so new terminals and Herdr panes see it.
- Removal deletes only that entry; when it was the only one, the value is deleted.
- The `pi-shim` stage adds it, **Repair** adds it again when it is missing, and the NSIS uninstaller and **Remove all data** remove it. The uninstaller's removal runs inside `${ifNot} ${isUpdated}`: electron-builder runs the old uninstaller during every update, and an unguarded removal would drop the entry at each update until a Repair.

**Panes on macOS.** Panes inherit the server's environment (kit check `09-pane-env.sh`), but that check used a scratch `HOME` and compared four variables, not `PATH`. With the real `HOME`, the pane's interactive zsh (even with `shell_mode = "non_login"`) reads the PM's `~/.zshrc`, which can put a Homebrew `gh` or `git`, or an exported token, ahead of the app's.
So the pane shell is zsh by Herdr's `default_shell = "/bin/zsh"` (a PM whose login shell is bash would otherwise get `~/.bashrc`, the same leak), and the Herdr server's environment carries `ZDOTDIR=<root>/config/zsh`, whose `.zshenv` and `.zshrc` (written by the `herdr` stage) only set `PATH` again from `"$STRAW_BOSS_DESK_ROOT/tools/bin/paths.sh"` (**Tool paths**), with `tools/bin` first. zsh then reads none of the PM's own startup files; macOS's `/etc/zshrc` sets no `PATH`, and `/etc/zprofile` (path_helper) runs only in login shells. A PM who types in the GUI's terminal tile gets a plain zsh, which is what the team profile expects.

**Uninstall and data.** The uninstaller (Windows) and dragging the app to the Trash (macOS) remove the program only. The uninstaller first runs the app with `--stop-stack`, which runs the stop sequence and exits, and it removes the PATH entry (outside an update). electron-builder's uninstaller force-closes a running app before that, which skips `before-quit`; if the app is still running when `--stop-stack` starts, the second instance loses `requestSingleInstanceLock` and exits, and the running app receives the flag in `second-instance`, where it runs the stop sequence and quits. The data root stays, as with most apps, so a reinstall resumes; so do the gh and glab tokens the app's logins put in the OS store (**Open for the boss**, item 12).
**Remove all data** in settings (both platforms) is the full removal, and the PM guide tells a PM to use it before uninstalling: it runs the stop sequence, signs out of every store entry the app owns (**Removing a login**; never an entry it does not own, K1), signs Claude Code out with the app's `CLAUDE_CONFIG_DIR` (on macOS its Keychain item has its own name, **Secrets**), deletes the Linear key, removes the PATH entry, the macOS Keychain item "`<product>` Safe Storage" (named by the running build's product name, never a fixed string), the fallback folder of `state/layout.json` if there is one, and `<root>`, and leaves the work folder and its clones, which are the PM's work. It asks once, naming the size of `<root>` and what is kept.
What it leaves in the credential store is named, never silent: every store entry marked `left` in `state/accounts.json` (**Ownership**, **Removing a login**), and every entry this removal leaves for the same reasons, is listed by name and host on the confirmation screen and again in the result ("Left in this computer's credential store: `gh:github.com`. Straw Boss created it but did not remove it, because it was changed afterwards."), with a link to the guide's page on removing it by hand. Once `<root>` is gone no record names them, which is why the result says so first.
Chromium holds files in `<root>/electron` open while the app runs (on Windows `Local State`, cookies, caches), so the app deletes everything else, writes `<root>/remove-pending`, starts a detached cleanup (`cmd /c` on Windows, `/bin/sh -c` on macOS, with `<root>` passed on the command line, which is Unicode, never in a file) that waits up to 30 s for the app's pid to end and then deletes `<root>`, and quits. If `<root>/remove-pending` still exists at a later launch, main deletes `<root>` before `app.setPath("userData")` and before Chromium opens anything, then starts as on a new machine.

### Start

The start order, the `up` failure table, and the retry rules are the desk B7 plan's (**Start order, after the B6 + B7 release**, **Exit codes**), as `start.ps1` implements them on 0.51.0:

1. Herdr: when the app's own socket answers `herdr workspace list` and `state/start.json` holds the same environment fingerprint, reuse that server (adoption, below); when the socket answers with another or no fingerprint, stop it with `herdr server stop` on that socket and start anew. Otherwise start `herdr server` detached and hidden with `stdio: "ignore"`, write its pid and the fingerprint to `start.json` at once, and wait until `herdr workspace list` answers (45 s).
2. `node <agent>/npm/node_modules/pi-straw-boss/dist/server/cli.mjs up --dir <home base folder> --label "Straw Boss" --timeout 120 --exact`, with a process limit of 150 s (`--timeout` counts from when `up` starts its steps). The app creates the work folder and the home base folder first when they are missing, since `up --dir` only checks it. The sb server's pid from `up`'s answer goes to `start.json`.
3. The slot folder must be `<agent>/straw-boss` itself (primary); the URL must have the GUI's shape; then the GUI view loads it.

The kit's exit codes 2 to 27 become typed failures (`StartFailure { kind, step, wait, reason, startError }`), each with a screen sentence in both catalogs.
`loader` and `intercom` run the engine's repair of that package and retry once, as the kit does.

**Start times.** The app kills a process, or adopts it as its own, only by a pid it holds a live `ChildProcess` handle for, or by a pid whose current start time equals a non-empty start time in `start.json`.
With neither, it never kills: it stops through the CLIs (`cli.mjs stop`, `herdr server stop` on its own socket), and whatever still runs afterwards is reported, by pid, on the failure screen and in `logs/start.jsonl`. "Whatever still runs" is found, not assumed from the records: after the stop sequence one listing looks for any process whose executable, by its full path, lies under `<root>/tools`, and whether the app's Herdr socket or pipe still answers. On macOS that is `lsof -d txt -Fpn` (each process's executable and mapped files, by path); `ps -o comm=` is not used, since it shows `argv[0]`, and a pi started by name through `#!/usr/bin/env node` shows as `node`, while its executable is the app's Node under `<root>/tools`. On Windows it is one `Get-CimInstance Win32_Process` call, reading `ProcessId` and `ExecutablePath` only. Process command lines are never read: other programs put passwords in theirs. The report names the pid and the executable's file name.

- **Recording.** macOS reads start times with `ps -o lstart=` right after each start. On Windows each PowerShell start costs 2 to 5 s, so nothing is read before the GUI shows: the Herdr server the app started in this run is covered by its handle, which also keeps Windows from reusing the pid. Once the GUI shows, the app reads the start times of the Herdr pid and the sb server pid in one PowerShell call, asynchronously, and writes both to `start.json`. The app never holds the sb server's handle (`up` starts it through WMI or a breakaway job), so this read is the sb server's only record. The record is always the app's own read, so the kill check, which reads the same way, compares like with like; `up`'s `started` is logged, not used.
- **Re-recording.** Every restart the app makes (the supervisor starting Herdr again, an `up` after the gone rule) and every restart the follower sees (a new `server.json` `pid`, from `cli.mjs restart` or a pi session's own restart) first drops that process's old record from `start.json` and then records the new pid's start time with the same read (on Windows the same single asynchronous PowerShell call, queued so two never overlap). A pid the app did not start (the follower's, or `up`'s answer) is recorded only when that read also shows that its executable lies under `<root>/tools` (the leftover listing's rule; on Windows the same call reads `ExecutablePath`, on macOS `lsof -a -p <pid> -d txt -Fn` runs beside `ps -o lstart=`), so a stale `server.json` pid already reused by another program is never recorded. Until the read lands, the new process has no record, so the kill check skips it and the stop sequence reports it if the CLIs leave it running.
- **Adopting.** On a later launch Herdr is reused when its socket answers and the fingerprint matches; reuse through the socket needs no start-time read, so on Windows nothing is still read before the GUI shows. The deferred read after the GUI shows then compares Herdr's and the sb server's current start times with the records: a match keeps the record, so the kill fallback covers that process in this run; a mismatch or no record drops it, the app gets no kill fallback for that process in this run, and its quit uses `herdr server stop` (or `cli.mjs stop`) alone. On macOS the same comparison runs at once with `ps -o lstart=`. `up` answering `server: "found"` is reused the same way.
- **Killing.** The stop sequence's kill step reads each recorded pid's current start time (one PowerShell call on Windows) and kills only on a match.

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
| The app crashes | the stack keeps running; the next launch reuses it (Herdr socket and fingerprint, then `up` answers `server: "found"`) and keeps a kill fallback for a process only while its recorded start time still matches (**Start times**, **Adopting**) |
| `powerMonitor` `suspend` | pause the follower |
| `powerMonitor` `resume` | read the slot folder again and allow 20 s before the gone rule applies, so the sleep's gap is not counted as an unanswered GUI |
| A second launch | `requestSingleInstanceLock`: the running app comes to the front; two shells never race for the stack |

### Window and page security

- The GUI view: `sandbox`, `contextIsolation`, no Node, and the GUI preload, which exposes only `strawBossDesk.pickFolder({ defaultPath, title }) => Promise<string | null>` (the hook `gui/picker.ts` reads, desk-mode S10), and only when the page's origin is the loaded GUI's `http://127.0.0.1:<port>`. The dialog opens in the work folder. A folder outside home is still refused by the page (desk-mode decision D7: home only).
- Navigation stays on the GUI's origin (`will-navigate`). A new-window request, and a navigation that `will-navigate` blocks, open a link in the default browser only when it is an `https:` URL or a **preview link**: an `http:` URL whose parsed host is exactly `localhost`, `127.0.0.1` or `[::1]`, with no user name or password, on an explicit port from 8080 to 8100 inclusive. For a preview link the blocked navigation is cancelled and the link opens in the browser; the GUI view stays where it was. Everything else is refused and opens nothing: any other `http:` host (`localhost.evil.test`, `0.0.0.0`, a private address), `localhost.` with a trailing dot, a URL with a user name or password, a port outside the range or none, and any scheme other than `http:` and `https:`. The GUI's own origin is never opened externally, even if its port lies in the range. The rule is one pure function the unit tests call, so the e2e case checks only the wiring. Why the range is fixed is in the Decisions table (**Preview links**).
- Permissions: camera for the GUI origin only (Straw Link's QR join), with `NSCameraUsageDescription` on macOS; everything else is denied.
- The shell view loads only packaged `file://` pages under a strict CSP, with its own preload (wizard and settings calls).
- A desk-settings entry inside the GUI would need a page hook like S10 (seam U4); until then settings open from the app menu and from the banner of any pending item.

## The wizard

### First run

| # | Step | What happens |
| --- | --- | --- |
| 1 | Welcome | language from the OS (`zh-Hant`, `zh-TW`, `zh-HK` give zh-TW, else en), a switch for the other; one paragraph on what will be installed and where; the preflight's findings |
| 2 | Team recipe | drop or choose `<id>.strawboss.json`, or **I have no recipe**, which asks for the code hosts (GitHub, GitLab with its host name); a recipe is validated by `recipe/validate.mjs` with the reserved package names and the optional tool names from `stack.json` (`reservedPackages`, `knownTools`), and refused with the field and rule named, never the value |
| 3 | Trust | team-profile section 5, **Trust: show before applying**, line by line; **Apply** or **Cancel**; nothing is written before Apply |
| 4 | Work folder | `~/StrawBoss` by default; **Change** opens the native dialog, inside home; changeable here once; the home base is `Straw Boss` inside it |
| 5 | Install | the engine's stages as a list, each with a badge (waiting, working, done, skipped, failed); one plain line for the current action; **Details** opens the log tail; **Retry** on a failed stage |
| 6 | Start | the supervisor's start; its failure screen on a failure |
| 7 | Claude | **Sign in**: `claude auth login` with the app's `CLAUDE_CONFIG_DIR`; the screen says a browser window opened, shows the URL to copy if it did not, and a field for a code if the CLI asks for one, under the GitLab token's rules (masked, over IPC to main, written to the CLI's standard input, never on a command line or in a log, cleared at once); done when the CLI's status says signed in |
| 8 | Code hosts | one screen per forge (below) |
| 9 | Linear | when the recipe has `linear.enabled` true, or there is no recipe: a link to Linear's API key page, a masked field, then the `ttt` stage and a non-interactive `ttt init` |
| 10 | Projects | each recipe repository: clone into `<work folder>/<folder>` (reuse only when `origin` is the same URL), `git remote set-head origin <defaultBranch>` when the recipe gives one, on Windows the symlink check below, then open it as a base through the `open-base` endpoint, labeled; a progress row per repository, each retryable alone |
| 11 | Done | the GUI view takes the window |

**Projects: the default branch.** A recipe repository's `defaultBranch` can differ from the code host's own default (FE2's GitLab default is `main`, its work goes to `develop`). After the clone or the reuse, `git remote set-head origin <defaultBranch>` makes `origin/HEAD` point at it, which is where the PM workflow reads the branch to start from and the merge request to target. A branch that `origin` does not have fails that repository alone, naming the repository and the branch. A repository without `defaultBranch` is left as cloned. A recipe update that changes a repository's `defaultBranch` runs `set-head` again for that repository, and one that changes nothing touches nothing.

**Projects: symlinks in a repository (Windows).** After a clone or a reuse, the step lists the index entries of mode 120000 under `.agents/`, `.pi/` and `.claude/` (`git ls-files -s -z -- .agents .pi .claude`, keeping the entries whose mode is `120000`). When there are any, the repository's row ends done and shows one plain sentence that names the repository and the paths (up to ten, then "and N more"): "In `<repository>`, these are links that Windows cannot create here, so pi does not see them: `<paths>`. The fix is in the repository: ask its owners to replace each link with the real files." The repository is still opened as a base. The check only lists; the app never changes `core.symlinks`, and it never writes to the repository. Under PortableGit's default (`core.symlinks=false`) Git checks such a link out as a small text file holding the target path, so pi finds a file where it expects a folder of skills. The reason there is no setting to turn on: creating a symlink on Windows needs Developer Mode (turning it on needs an administrator) or an elevated process, and the desk runs without administrator rights. macOS makes the links and runs no check.

Every sign-in step has **Later**.
A later item shows as a badge in settings and a thin shell banner over the GUI ("GitLab is not signed in yet") with a **Settings** button, so a PM without a token today still reaches the GUI, and CI walks the same path without a test hook.

### The code-host screens

**Before either sign-in**, two checks run, in this order, and the step stops before the PM makes a token if one fails.

1. **The store probe.** Windows writes, reads, and deletes a throwaway generic credential (`straw-boss-desk-probe-<nonce>`); macOS does the same as go-keyring does it: `security -i` with `add-generic-password` on standard input, no keychain argument (so the default keychain), then find and delete. Each command has a 10 s limit, so a locked keychain's unlock dialog on a PM's Mac is answered by the PM or ends in a timeout, which counts as a failed probe. A failed probe: "This computer's credential store is not available, so Straw Boss will not sign in (it would have to keep your token as plain text)."
2. **Existing sign-ins (K1, boss decision 2026-11-01).** gh and glab keep their tokens in the OS store under names that depend on the host alone, whatever `GH_CONFIG_DIR` or `GLAB_CONFIG_DIR` says (`mac-account/design.md` §1 and K1; `account-check/report.md` for the Windows targets). The app's login would therefore replace the PM's own token for that host, perhaps with another account, and a logout would delete it.
   The app lists the entries for the host by their attributes (name, account, modification time; an empty listing means no entry; any failure of the listing is a failed probe), through the `CredentialStore` interface. macOS: `security dump-keychain` without `-d`, over the default search list as go-keyring searches it, filtered by service, which gives every item with its account and `mdat` and never reads a secret (`find-generic-password -s` would return only the first match, and gh writes two items per host; an empty account prints as `"acct"<blob>=<NULL>`, which the parser maps to `""`). Windows: `CredEnumerateW` with a target filter, called from one PowerShell process through `Add-Type` P/Invoke, as the kit's `account-check.ps1` already does. The API returns every matching credential with its secret (`CredentialBlob`) in the helper's memory; the helper's struct declares that field as a bare pointer, copies only `TargetName`, `UserName`, and `LastWritten` into its output, never dereferences or marshals the pointer, and calls `CredFree` before it prints anything. So on Windows the secret passes through the helper's process unread and never reaches its output, main, or a log. `cmdkey` is not used (its labels are localized, and it shows no write time). The names: gh `gh:<host>` (with any account) and `gh:_refreshable:<host>`; glab `glab:<host>:token` and the legacy `glab:<host>`; on Windows the same names as Credential Manager targets, with any suffix.
   An entry the app does not own (**Ownership**, below) stops the step: "This computer already has a sign-in to `<host>` from another program, probably your own GitHub (GitLab) command-line tool. Straw Boss would have to replace it, so it stops here and leaves yours as it is." **Details** names the entries found. The step stays **Later**, and its banner keeps the same sentence. The guide explains it; seam U9 is the later fix.
   After a login that passes, the app lists the host's entries again at once and records each one that was not there before, or that it owned before (a **Sign in again**), in `state/accounts.json`: name, account, host, which login, and the modification time it just read.

**Ownership.** The app owns a store entry only while its name is in `state/accounts.json` and its current modification time (macOS `mdat`, Windows `LastWritten`) equals the recorded one. A write changes that time: gh's `add-generic-password -U` and glab's write update the item in place under the same name, so a PM's own `gh auth login` or `glab auth login` after the app's login leaves the name and changes the time. Windows sets `LastWritten` itself on every `CredWriteW`, finely enough; macOS keeps `mdat` to the second, so two writes within one second leave it unchanged. The window that matters is the one between the app's login and its recording read, which is a fraction of a second; the anchors keep at least 2 s between the app's login and their foreign write. An entry whose time changed, whose time cannot be read, or that is not recorded is foreign, and the app neither logs it out nor overwrites it. The time is chosen over a token fingerprint because reading it does not read the secret and works the same on both stores, and over the account name because the PM usually signs the app in with their own account.
The cost is in the safe direction, and the app keeps it small. gh rewrites its entry on routine use when it holds an expiring token (`gh:_refreshable:<host>`, refreshed near expiry), so the app logs gh in with `--expiring=false` (below), and tasks 16 and 17 record whether a refreshable entry appears anyway. A write by the app's own gh outside the wizard (an agent running `gh auth refresh` in a pane) still makes the entry foreign.
When an entry the app created turns foreign, the app keeps it in the record marked `left` (name, host, account; no time), shows the host as not signed in by Straw Boss, and says: "The sign-in to `<host>` that Straw Boss made was changed afterwards, by your own GitHub (GitLab) command-line tool or by an agent using it. Straw Boss leaves it as it is." **Details** names the entry and links to the guide's page on removing it by hand (**Open for the boss**, item 13). A `left` entry never counts as owned again; once a later listing no longer finds it (the PM removed it), the record drops it and **Sign in again** works. The check runs before every logout and every login.

**GitHub (device code).**
The app runs `gh auth login --hostname github.com --git-protocol https --web --expiring=false` through the launcher (no refreshable token, so no rewrite by gh's refresh; **Ownership**), reads the one-time code from its output, and shows it large, with **Copy** and **Open GitHub** (the device page), and a line that the browser asks to approve "GitHub CLI".
It waits for gh to finish (15 minutes, then **Try again**).

**GitLab (token).**
The screen links to `https://<host>/-/user_settings/personal_access_tokens?name=Straw%20Boss&scopes=api`, says in two lines what to click, and takes the token in a masked field with no reveal toggle and no autofill.
**Sign in** sends it over IPC to main, which writes it to `glab auth login --hostname <host> --git-protocol https --api-protocol https --stdin` and drops its reference; the field is cleared at once.
The token never touches the renderer's storage, a log, a file, or a command line.

**After either**, the verdict of team-profile section 4, **Where the token goes**, as `account-verdict.ps1` implements it, ported: gh's `tokenSource` must be `keyring`, and neither `hosts.yml` nor `config.yml` may hold a token for the host; glab's `config.yml` may hold no `token` for the host.
The YAML reading takes followup R3-F001: keys and sections compare case-insensitively, and multi-line value bodies are skipped.
On evidence of a plain-text token the app removes it and shows the refusal; a status it cannot read is "could not verify", which fails the step and keeps the login.
The refusal is the same sentence as the probe's.

**Removing a login** (the plain-text case above, settings' **Sign out**, **Remove all data**) acts only on entries the app owns.
Right before it, the app lists the host's store entries again with their times. When every one is owned (**Ownership**), or there is none, it runs `gh auth logout` or `glab auth logout` and drops the record. When any entry is foreign, it runs no logout: it removes the host from its own `hosts.yml` or `config.yml` (files in `<root>/config`, the app's own), marks every entry it created for that host `left` (they stay in the store beside the foreign one), and says that a sign-in it does not own was left alone and names what stays.

### Settings

Reached from the app menu (macOS app menu, the Windows window menu) and from banners.

| Section | Contents |
| --- | --- |
| Accounts | Claude, each forge, Linear: state, **Sign in again** (the checks of **The code-host screens** first), **Sign out** (for a forge, **Removing a login**: only entries the app owns; for Linear, deleting `linear.bin`); saving a Linear key while the stack runs offers **Restart now** or **Later** (Environment) |
| Team recipe | name, version, source; an update from `updateUrl` shown as a change list with **Apply** or **Keep**; **Replace** with another file |
| Team guidance | the installer's notices: a kept file, a kept key, with **Keep mine** or **Use the team version** (backup under `.straw-boss-profile/backup/`) |
| Updates | app version and the stack's generation; **Check now**; **Restart to update** when ready |
| Computer | keep awake (off by default); language; **Remove all data** (Environment, **Uninstall and data**) |
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
| Claude login | Claude Code | on Windows a `.credentials.json` file in `CLAUDE_CONFIG_DIR`, the app's private folder (Windows spike), in plain text, outside our control (**Open for the boss**, item 9). On macOS a Keychain item whose service name carries a hash of `CLAUDE_CONFIG_DIR`: Claude Code 2.1.309 names it `Claude Code-credentials-<first 8 hex of sha256(config dir)>` when `CLAUDE_CONFIG_DIR` is set and `CLAUDE_SECURESTORAGE_CONFIG_DIR` is not, so it never shares the PM's own `Claude Code-credentials` item (read from the 2.1.309 binary; task 11 confirms the bundled `claude` of the pinned Agent SDK names it the same way, by attribute only, and task 17 records it in the guest) |
| Linear API key | the app | `secrets/linear.bin`, encrypted with `safeStorage` |
| GUI page token | pi-straw-boss | `gui.json`, `server.json`; the app keeps it in memory and never logs it |

`safeStorage`:

- **Windows: DPAPI**, bound to the user account; any process of the same user can decrypt, which is DPAPI's model. Unchanged by an app update. Phase 0's untested roundtrip runs in the VM in the packaged app, and again after an update (task 16). The key lives in `<root>/electron/Local State` (App data layout).
- **macOS: a Keychain item** ("`<product>` Safe Storage", named after the build's product name, not the data root, so development builds use their own name, Decisions) whose access list names the app's code signature. An unsigned v1 is ad-hoc signed, and an ad-hoc signature changes with every build, so after an update macOS may ask the PM to allow access, and denying it loses the key. The app treats a failed decrypt as "Linear key needs to be entered again", never as a crash. A Developer ID signature removes the prompt (**Open for the boss**).
- **Unavailable store**: when `isEncryptionAvailable()` is false, the Linear step refuses to save the key and says so. There is no plain-text fallback.

## Network: the WARP finding

**What happened.** In the Windows VM on the author's Mac, with Cloudflare WARP connected on the Mac, the VM could not reach `github.com:443`, and Git's schannel got `CRYPT_E_REVOCATION_OFFLINE` for `gitlab.moldplan.app`; with WARP off both worked (account-check report, finding 1).

**The cause** (`~/.local/share/sbd-review/vm-warp/report.md`). UTM's Shared networking sends the VM's traffic through the Mac's NAT. When macOS routes a forwarded packet out of WARP's tunnel interface (`utun4`), it is dropped: every probed destination routed through `utun4` timed out at the TCP handshake, ICMP included, and every destination WARP excludes, or that goes through Tailscale, worked.
GitLab's revocation error is the same fault: its certificate's CRL host (`ye1.c.lencr.org`) and its intermediate (`ye1.i.lencr.org`) sit behind `utun4`. The error is intermittent, since it appears only once Windows' cached CRL has expired, so a single passing run proves nothing.
It is not TLS inspection (the chains are the public CAs' on both machines), not DNS, and not MTU.

**PM laptops are not affected.** The Mac's own traffic through WARP reaches GitHub, npm, and the CRL hosts. The fault needs a second machine's packets forwarded through the host's WARP interface, which a PM's laptop running the app directly never does. A PM who runs the app inside a VM on a Mac with WARP would hit it, and the guide says so in one line.

**The fix for our VMs.** Run the VM on UTM Bridged networking (Network Mode: Bridged, interface `en0`), as a second NIC beside the Shared one, which keeps the fixed address for ssh. A bridged VM talks to the router directly, outside WARP. Bridging onto Wi-Fi is untested and an access point may refuse the extra MAC address; when it does, the VM steps that need GitHub, npm, or the GitLab host run with WARP off and WARP is reconnected after (the account-check routine). This applies to the Windows VM (task 16) and the macOS guest (task 17).

**What phase 2 does:**

- The private `gitconfig` sets nothing for revocation: `http.schannelCheckRevoke` keeps its default. Turning it off would not have fixed the fault, and it would stop Git checking revocation for every host.
- The preflight names the unreachable host in plain words ("network path: VPN or proxy"), within a few seconds, so a blocked download host shows up before an install half-runs, and not as a schannel error.
- **Company networks** are a separate risk that this machine did not exercise: Cloudflare Gateway or another proxy with TLS inspection presents its own CA. The engine downloads through Electron's `net` (OS proxy and certificate store); gh and glab, being Go programs, use the OS store; Git on Windows uses schannel, which uses the OS store; npm and pi get `NODE_USE_SYSTEM_CA=1`; the OS proxy setting becomes `HTTPS_PROXY` and `HTTP_PROXY` for every child, with `NO_PROXY` naming the hosts the PAC file sends `DIRECT` (a company GitLab among them), and the proxy and CA variables set in the app's environment pass through (Environment, **The OS proxy setting**). Claude Code (the Agent SDK's bundled `claude`, used for sign-in and every model call) reads the proxy variables; it may be a native build that ignores `NODE_USE_SYSTEM_CA`, so task 6 records whether it does, and when it does not, the app writes the OS store's certificates (`tls.getCACertificates("system")` under the private Node) to `<root>/config/system-ca.pem` at each start and sets `NODE_EXTRA_CA_CERTS` to that file unless the app's environment already sets it. Git on macOS (dugite-native) trusts its bundled CA file, so a company CA reaches it only through `GIT_SSL_CAINFO` or `SSL_CERT_FILE`; task 5 records whether that holds. A TLS failure with an unknown issuer is named as "a proxy or certificate inspection" with that remedy. No CI runner or VM here has such a network, so the first PM on one is the test; the pilot asks each PM.
- **A private code host.** A recipe's forge host can be private. `gitlab.moldplan.app` has no public DNS record and resolves only on the company's tailnet (`100.123.124.6`), so a PM's computer must be on that network before the wizard can reach it: the preflight check, the clone, the GitLab sign-in, and every push need it. This is a prerequisite of that recipe, not something the app can provide: desk installs no VPN and no Tailscale, since that needs administrator rights and a network driver. When a recipe forge host does not resolve or does not answer, the preflight names the host and says, in one plain sentence: "Could not reach `<host>`; it may be reachable only on the company network, so connect to that network and try again." (zh-TW in the catalog). The same sentence replaces the generic network sentence for that host wherever the failure shows (the projects step and the GitLab step). The PM guide lists the network as a prerequisite for a recipe with a private host. The validator already accepts such a host: only `updateUrl` must be public.
- CI runners have no WARP, so the anchor does not depend on any of this.

## SmartScreen, signing, and notarization

v1 ships unsigned, as the design record decides. What that means, and what phase 2 checks:

**Windows.**

- The installer is per-user NSIS (`perMachine: false`, `allowElevation: false`), so no UAC prompt.
- Downloaded in a browser, it carries Mark-of-the-Web: Edge may say the file "isn't commonly downloaded" (**Keep**), and SmartScreen shows "Windows protected your PC" (**More info**, **Run anyway**). The PM guide shows both with zh-TW screenshots from the VM.
- **Smart App Control** (SAC), when it is on (only on a freshly installed Windows 11), blocks unsigned programs with no override. That covers the app itself, so none of the app's code runs and no preflight can explain it: the explanation lives in the PM guide and on the download page. It also covers, probably, the unsigned `herdr.exe` whatever the app's own signature. The only remedy a PM has is turning SAC off, a security downgrade that some Windows builds cannot undo without a reinstall; the policy is **Open for the boss** (item 6). The preflight still reads `HKLM\SYSTEM\CurrentControlSet\Control\CI\Policy\VerifiedAndReputablePolicyState` (0 off, 1 on, 2 evaluation; to be confirmed in the VM, task 16): in evaluation mode the app runs today, and the welcome screen says Windows may turn SAC on later and then block Straw Boss.
- Updates downloaded by electron-updater, and tools downloaded by the engine, get no Mark-of-the-Web, so no SmartScreen prompt is expected after the first install; task 16 records whether one appears.
- **Signing later** needs a code-signing certificate. Azure Artifact Signing (formerly Trusted Signing) takes individuals only in the US and Canada, and organizations only in a list of countries that does not include Taiwan, so the realistic path is an OV certificate from a public CA with cloud signing, which electron-builder can use in GitHub Actions. Neither Artifact Signing nor an OV certificate gets SmartScreen reputation at once; it builds with installs.

**macOS.**

- The app is ad-hoc signed, which Apple Silicon requires to run at all. electron-builder 26.18 has no automatic ad-hoc fallback, so `electron-builder.json` sets `mac.identity: "-"` (with `hardenedRuntime: false`), and a test runs `codesign --verify` on the packaged app (task 1).
- A downloaded, unnotarized app is blocked on first open. Since macOS 15 the right-click **Open** shortcut is gone: the PM opens **System Settings**, **Privacy & Security**, and clicks **Open Anyway**, which may ask for an administrator password. On a company Mac a PM may not have one.
- The app offers to move itself into `/Applications` on first run (`app.moveToApplicationsFolder`), so it never runs from the disk image or a translocated path. When `/Applications` is not writable, Electron's call is believed to ask for an administrator password; the app then copies itself into `~/Applications` with its own code and relaunches from there instead. Task 17 checks both paths.
- Squirrel.Mac refuses unsigned updates, so the macOS updater offers the new dmg (Updater).
- **Signing and notarizing later** need an Apple Developer Program membership: a Developer ID certificate and an app-specific password or API key for `notarytool`, stored as Actions secrets.

What needs the boss's accounts or money is in **Open for the boss**.

## Updater

Two channels, as the design record says; phase 2 builds both clients and proves them against a local feed; phase 4 points them at GitHub Releases and publishes.
Both channels are checked against the same Ed25519 public key built into the app, so replacing release assets is not enough to ship a new shell or a new stack.

**The shell, Windows.** electron-updater with NSIS.
It checks at start and every 6 hours, downloads in the background, and shows **Restart to update** in settings and as a banner.
`autoInstallOnAppQuit` is off, so nothing installs without the check below.
On `update-downloaded` the app fetches `<installer>.sig` from the same feed and verifies the downloaded file (`downloadedFile`) with the built-in key; on a mismatch it deletes the file, logs it, and offers nothing.
Only a verified file enables **Restart to update**; on the PM's click it runs the stop sequence, then `quitAndInstall(true, true)` (silent, start after).
Unsigned builds name no publisher, so electron-updater itself checks only the SHA512 in `latest.yml`; once a certificate exists, `publisherName` is set and Windows' signature check is added to the Ed25519 one.
The provider is generic for tests (`test/fixtures/feed/`) and GitHub for releases, chosen at build time.

**The shell, macOS.** electron-updater's check against the same feed; a newer version shows **Download the new version**. The app downloads the dmg itself, verifies its `.sig` the same way, and reveals the verified file; it never opens an unverified one.
Once the app is signed and notarized, the zip target and Squirrel.Mac take over with no change to the check.

**`stack.json`.** The app carries its own `stack.json`.
The channel offers `stack.json` and `stack.json.sig` (Ed25519 over the exact bytes) as assets of a rolling release in this repository; phase 4's workflow publishes them, signed by `scripts/sign-stack.mjs`.
The app applies a candidate only when the signature verifies against its built-in public key, its `generation` is higher than the active one, and its `minShell` is at most the app's version (otherwise the shell must update first).
Applying is: show the change list (tool and package versions); on **Apply**, stop the stack, run the engine against the candidate, start; when a stage fails, roll back to `previous.json`, start, and report.
A recipe's `profile` pin still wins over `stack.json`'s profile entry (team-profile section 7). A candidate that no longer lists an optional tool the active recipe names is refused, since the recipe could no longer be applied; the change list shows an optional tool's added or changed version like any other tool's.

**Precedence.** The active stack is the verified `stack.json` with the highest `generation`, whether it came with the shell or from the channel. A new shell's bundled `stack.json` applies at its first start only when its `generation` is higher than the active one; otherwise the downloaded one stays.

**The key.** One Ed25519 key signs installers, dmgs, and `stack.json`. Its private half lives in a GitHub Actions secret of a protected environment (`release`) with the boss as required reviewer, so a workflow pushed to the repository cannot read it without that approval. Rotation: the app accepts any key in its built-in list of at most two; a shell release signed by the old key adds the new one, and a later release drops the old one. That rotation assumes the old key is not compromised: with the key, an attacker can ship a shell that adds their own key, and v1 has no revocation beyond the protected environment that keeps the key from leaking. Recovery after a leak is manual: a new key, a release announced outside the app, and each PM reinstalling from the download page.

## CI anchor

### Runners

| Runner | Role |
| --- | --- |
| `windows-2025` (x64) | required on every push and pull request |
| `macos-15` (arm64) | required on every push and pull request |
| `windows-11-arm` | nightly: the x64 stack under emulation, as PM ARM laptops run it |
| `macos-15-intel` | nightly: the x64 macOS build |

### Fixtures that change the machine

Workers run these tests on the author's Mac, where the real `gh:github.com` item, the real `~/.zshrc`, the developer tools, and the real app data folder belong to the author (repository AGENTS.md, **Development on the author's machine**; the 0.45.0 test leak is the precedent). So every fixture that changes something outside the test's own root runs only on an ephemeral GitHub-hosted runner:

| Fixture | Used by | A local run instead |
| --- | --- | --- |
| the real default data root (`STRAW_BOSS_DESK_ROOT` unset) | the macOS anchor, tasks 9 and 15 | a temporary `STRAW_BOSS_DESK_ROOT`, which the harness always sets locally |
| a seeded or deleted gh or glab store entry, a foreign write into one, and the probe smoke test, in the default keychain or Credential Manager | tasks 1, 3, 10, 14, the anchor | macOS: a scratch `HOME` with its own keychain (design 1b), whose search list the harness first checks holds no keychain from the real home; Windows: skipped |
| a fixture `~/.zshrc` | task 8b, the anchor | written into the scratch `HOME` the app is launched with |
| moving the Xcode apps and `/Library/Developer/CommandLineTools` aside with sudo | task 5, the anchor | skipped, always |
| a real write to `HKCU\Environment` and a real NSIS install, update, or uninstall | tasks 3, 6, 13, 14, the anchor | skipped |
| a test CA added to the OS certificate store | task 6 | skipped |
| the macOS "`<product>` Safe Storage" item and the app's `Claude Code-credentials-<8 hex>` item, written and deleted in the default keychain | tasks 11 and 14, the anchor | a development build (product `Straw Boss Desk Dev`, so its item is `Straw Boss Desk Dev Safe Storage`) launched with the scratch `HOME` and its keychain; the harness refuses a local run of a build whose product name is the shipped one |

- **The guard.** Each such fixture, its setup and its teardown, is registered through one test helper, `app/test/harness/hosted.ts` (test code, never shipped). Before anything runs, it calls `hostedRunner(env, os.userInfo())`, a pure function that answers yes only when every signal holds: `CI=true`, `GITHUB_ACTIONS=true`, `RUNNER_ENVIRONMENT=github-hosted`, `ImageOS` and `RUNNER_TEMP` set, and the user name the hosted images use (`runner` on macOS, `runneradmin` on Windows). One signal alone is not enough, since a developer's shell may set `CI`.
- **A refusal** skips the test with the fixture's name and the failing signal ("seeded store entry runs only on a GitHub-hosted runner: RUNNER_ENVIRONMENT is not github-hosted"). The anchor workflows set `SBD_REQUIRE_HOSTED_FIXTURES=1`, under which a refusal fails the job instead, so a skip can never pass the anchor unseen.
- **Its own test** (in `ci.yml`, task 1): `hostedRunner` refuses an empty environment, `CI=true` alone, every variable set with a developer's user name, and a copy of a developer Mac's environment, and accepts the full hosted set; and every registered fixture, called with a non-hosted environment, refuses before its command runner or file writer records a single call.
- **The scan.** A test in `ci.yml` (task 1) reads every file under `app/test` and fails when a machine-changing command appears outside `app/test/harness/` (the guard in `hosted.ts`, and the scan's own pattern list beside it): the store commands (`add-generic-password`, `delete-generic-password`, `CredWrite`, `CredDelete`, `cmdkey`), registry writes (`reg add`, `reg delete`, `Set-ItemProperty`, `SetValue` on a registry key, `HKCU\Environment`), `.zshrc`, `sudo`, and certificate-store commands (`add-trusted-cert`, `certutil`, `Import-Certificate`). A fixture is therefore used only through the guard, and a new one cannot slip in unregistered; the reviewer's check stays as the second gate.

### Workflows

- **`ci.yml`**: `node --test` for `recipe/`, `profile/`, and `app/` (unit tests, the i18n parity, CSS-only, and border tests); TypeScript build; `electron-builder --dir` on both required runners; on `macos-15`, a store smoke test that adds, finds, and deletes a throwaway item in the default keychain with the probe's 10 s limits, so a runner keychain problem shows on day one (a guarded fixture); the guard's own test.
- **`wizard-from-zero.yml`**, the anchor, on both required runners from an empty data root, with `SBD_REQUIRE_HOSTED_FIXTURES=1`; every machine-changing step below is a guarded fixture (**Fixtures that change the machine**). On `macos-15` the root is the real default, `~/Library/Application Support/straw-boss-desk` (runners are ephemeral; it has the space); on `windows-2025` it is `STRAW_BOSS_DESK_ROOT=%LOCALAPPDATA%\sbd 測試`, inside home, with a space and CJK characters. The fallback outside home is a unit case (task 3). Before the run, on macOS, the job moves the Xcode apps and `/Library/Developer/CommandLineTools` aside (sudo, ephemeral runner) so that any call into a developer-tools stub such as `/usr/bin/git` fails loudly, and writes a fixture `~/.zshrc` that prepends a folder holding a fake `gh` and `git` and exports `GH_TOKEN=fake`. On both, it seeds one foreign store entry, `gh:github.com` with a dummy secret (macOS `security add-generic-password`, Windows a generic credential).
  1. Launch the packaged app with Playwright, locale zh-TW.
  2. Walk the wizard: welcome; the CI recipe `app/test/fixtures/ci.strawboss.json` (forges `github.com` and a GitLab host, one public GitHub repository, Linear on); trust; default work folder; install; start; Claude **Later**; GitHub, which stops at the existing-sign-in check with its sentence, then **Later**; GitLab with the test token when the secret is present, else **Later**; Linear **Later**; projects; done.
  3. Assert: every stage is verified in `state/bootstrap.json`; the GUI view shows the page (`meta[name="sb-desk"]` is `1`); `cli.mjs status` says `live`, `primary: true`, `desk: true`; one home base (`<work folder>/Straw Boss`) with one tower; the cloned repository is a base beside it; the banner names the later items; the seeded `gh:github.com` entry is unchanged (same secret, same modification time), and settings' GitHub **Sign out** leaves it unchanged too. The secret is compared by the test harness, never by the app.
  4. With the GitLab secret: glab's verdict passes, `state/accounts.json` lists the entries the login created with their modification times, and a token search over the whole data root finds nothing (followup R3-F003: linked folders and missing roots are listed as unread, with the reason). Then, as a PM's own later login would, the test writes a dummy secret into the same `glab:<host>:token` slot at least 2 s later (`security add-generic-password -U`, Windows `CredWriteW`): GitLab **Sign out** runs no `glab auth logout` (none in `logs/shell.jsonl`), says the sign-in was changed and left alone, and the entry keeps the dummy secret and its new time; **Sign in again** stops at the existing-sign-in check. On macOS: quit, relaunch with `HOME` set to a scratch folder with no `Library/Keychains` and `STRAW_BOSS_DESK_ROOT` set to the same root; GitLab **Sign in again** stops at the store probe with the refusal at once (no dialog), and no token lands on disk; quit and relaunch with the real `HOME`.
  5. A pi turn through the harness-configured stub model in the cloned repository's base.
  6. Follow checks: `cli.mjs restart` is logged by pid change while the window stays live, and `start.json` then holds the new pid with its start time; a killed sb server comes back within 15 s and is recorded the same way; `/boss gui stop` shows the shell screen, and **Start** brings the GUI back.
  7. Panes, both platforms. In a Herdr pane of the cloned repository's base, a pi started as the pane starts it (`pi`, by name) runs `command -v gh git pi` with its bash tool (pi's RPC `bash` command): all resolve to the app's folders although the runner has its own `gh` and `git` on the machine PATH and, on macOS, the fixture `~/.zshrc`. Then, from that pi, one pi-herdr-agents subagent is dispatched through the stub model's scripted mode (test code: a marker in the prompt makes the stub answer with a fixed `subagent` tool call in the parent and a fixed `bash` call in the child); the child runs `command -v gh git pi bash`, its answers resolve to the app's folders, and the parent sees the child's done marker with exit 0. On Windows also: the user PATH has exactly one app entry (`tools\shims`), and its value kept its registry type.
  8. Quit: no Herdr or sb server process for this root remains, found by the test itself, not from the records: no process whose executable lies under `<root>/tools` by its full path (the leftover listing's rule, **Start times**), and the app's Herdr socket or pipe does not answer; the log shows the kill check compared the start times recorded after step 6's restarts; the workspaces are kept.
  9. Relaunch: no wizard, GUI within 30 s, base still there; quit again.
  10. A second, short run in en up to the trust screen, and a reduced-motion pass (`emulateMedia({ reducedMotion: "reduce" })`) that finds no running infinite animation (`document.getAnimations()`); screenshots of every screen in both languages as artifacts.
- **`stack-check.yml`**: weekly and on any change to `stack.json`: `scripts/check-stack.mjs` downloads every asset for every platform key and compares its SHA256, and runs `npm view <name>@<version> dist.integrity` for every package.

### What runs headless, and what does not

| Runs in CI | Does not run in CI, and where it is checked instead |
| --- | --- |
| The wizard from zero to the GUI, both languages, reduced motion | Claude sign-in and a real model turn (needs a subscription and a browser): VM and macOS guest, author present |
| Every install stage, resume after a kill, rollback (unit and e2e) | GitHub device approval (needs a person): VM and macOS guest, author present |
| GitLab token login and the keyring verdict (with the test secret) | SmartScreen and Mark-of-the-Web dialogs, Smart App Control: VM |
| The existing-sign-in refusal, a **Sign out** that leaves a foreign entry, and a foreign write over the app's own entry, on both runners | A bare Mac with no developer tools at all, and Gatekeeper's first-open dialog and the move to Applications: the macOS guest (task 17) |
| The macOS refusal with no keychain (at the store probe); the post-login removal on plain-text evidence, on the kit's nine fixtures | The Windows refusal with Credential Manager unavailable: VM, in a network-logon session (where the account check found Credential Manager failing). An Electron window cannot be driven there, so a repository test script runs the app's compiled probe and verdict modules under the private Node and asserts the refusal; the refusal screen itself is proved by the macOS run. The post-login logout itself already ran for real on both CLIs in the account check (`Remove-Login`) |
| The follower: restart, kill, stop, Start | A real sleep of 5 minutes and more: VM and the author's Mac |
| Sleep and resume as `powerMonitor` events emitted by the test | The real folder dialog: VM and macOS guest |
| The native folder dialog, with `dialog.showOpenDialog` replaced from the test through `electronApp.evaluate` | The camera and Straw Link's QR join: the author's Mac |
| A subagent launched from a pane, on both runners | A subagent with a real model, on the CJK profile with no Git installed (so `bash.cmd` is the `bash` that runs): VM |
| Silent update 0.0.1 to 0.0.2 against a local feed (Windows), and a tampered installer refused | Company proxies and TLS inspection: no test network here (**Network**) |
| `stack.json` signature checks and a rolled-back failed update | |

## Upstream seams

Each is a stopgap here, as thin as possible, and an upstream change; none is built in this repository beyond the stopgap named.

| # | Package | Gap | Stopgap here | Proposed upstream change |
| --- | --- | --- | --- | --- |
| U1 | herdr | a Windows pane (PowerShell) rebuilds `PATH` from the registry, so the app's tools, and the `pi` and `bash` typed into it, are invisible there (reported after the spike) | `tools\shims` with `pi.cmd`, `pi`, and `bash.cmd`, one user PATH entry, pass-through outside a desk pane | keep the server's `PATH` for panes on Windows, or a config key for a pane's extra `PATH` |
| U2 | pi-straw-boss | a restart keeps port and token (D27), so only `server.json` `pid` and `started` show that it happened | the follower compares them | `server.json` `restarts: { count, last: { at, reason } }` |
| U3 | pi-straw-boss | the shell cannot tell whether agents are working, for keep-awake and for warning before a quit | keep-awake means "while the app is open"; no quit warning | a documented field, e.g. `server.json` `busy: { sessions, since }`, or one in `cli.mjs status` |
| U4 | pi-straw-boss | no way into the desk's settings from the GUI | the app menu and banners | a page item shown when `globalThis.strawBossDesk.openSettings` exists, like S10's `pickFolder` |
| U5 | pi-straw-boss | `up` omits `started` until the server knows it (Windows) | the app reads both start times once, asynchronously, after the GUI shows (**Start times**) | desk B7 P3: `up` waits for it or says `startedPending` |
| U6 | pi | first start downloads `fd` and `rg` without a pin | the `fd-rg` stage provisions them | a documented switch that forbids the download and uses what `bin/` holds (check whether `PI_OFFLINE` already covers it) |
| U7 | pi | `pi install` resolves a package's dependencies afresh, so only the top package is pinned | none; recorded as a supply-chain limit | install a package's published lockfile, or accept one |
| U8 | team-toon-tack | `ttt init` prompts (design seam) | `ttt init -y` with `LINEAR_API_KEY` in the environment, falling back to a failure that names the step | non-interactive flags that need no TTY |
| U9 | gh, glab (go-keyring) | store entries are named by host only, so the app's sign-in and a PM's own share one slot (K1) | the existing-sign-in check refuses, and removal acts only on owned entries (name and modification time, **Ownership**) | a setting or environment variable for a service-name prefix in both CLIs |
| U10 | pi-herdr-agents | a subagent is launched by typing `bash '<script>'`, so the pane's PATH decides which `bash` runs; on Windows WSL's `System32\bash.exe` wins over any user PATH entry | `bash.cmd` in the shims; the WSL check at install, **Repair**, and every start, with a banner (**Open for the boss**, item 10) | run the script through an absolute bash path, e.g. pi's `shellPath` setting on Windows (a PR from the author's fork) |
| U11 | pi-straw-boss | agent sidecar sockets (`src/agent/paths.ts`) have no short-path fallback, unlike the server socket (`src/server/socket.ts`) | none; the v1 profile starts no non-pi agent, and the preflight records the length | the same fallback as the server socket |

Claude Code keeping its Windows login in a plain-text file is Anthropic's choice, not a seam we can propose; it is recorded under Secrets and shown to the boss (**Open for the boss**, item 9).

## Followups absorbed

| Followup | Where |
| --- | --- |
| RC-F002, P3R-F001: `safeRel` refuses trailing dot or space and device names, matched on the part before the first dot, plus `conin$`, `conout$`, `com0`, `lpt0` | task 7 |
| RC-F003: `writeAtomic` opens its temp with `wx` and re-checks parent folders right before each write | task 7 |
| RC-F004: `use-team --file` takes only manifest-managed files, without duplicates | task 7 (settings' **Use the team version**) |
| RC-F005, P3R-F002: `neutralize` closes an open fence, handles short `=` and `-` underlines, escapes `<pre>`, `<script>`, `<?`, `<![CDATA[` openers | task 7 |
| A hard kill between `pi install` and the skills-only listing | task 7: the stage's `detect` requires the skills-only listing, so a resume repeats both (engine contract) |
| P3R-F003: reads and deletes after planning are not re-checked for links | accepted: a same-user race only; recorded in the module |
| R3-F001: YAML keys case-insensitive, multi-line values skipped | task 10 |
| R3-F002: unset `GLAB_SKIP_TLS_VERIFY` and `SKIP_TLS_VERIFY`; keep proxy and CA variables | task 5 |
| R3-F003: the token search lists linked folders and missing roots as unread | task 10 |
| R-F009: hash check of installed binaries in every binary stage | tasks 4 and 5 |
| Wizard: refusal when the store is unavailable, masked token field, device-code screen | task 10 |
| K1 (`mac-account/design.md`): the existing-sign-in check and removal of owned entries only (name and modification time) | task 10; seam U9 |
| K2: gh, Claude Code, and npm telemetry off | tasks 3 and 5 |
| macOS account checks: design 1b (a scratch `HOME` with its own keychain), approved 2026-11-01 | the spike check runs on its own branch first (`mac-account/design.md` §8); task 17 repeats its items through the wizard |
| WARP | **Network** above; tasks 16 and 17 |
| desk-pin-051: `view`; the agent folder inside home; restarts seen only through `pid` and `started` | tasks 8a, 8b, and 3; seam U2 |

## Acceptance

The phase is done when:

1. `wizard-from-zero.yml` passes on `windows-2025` and `macos-15`, five runs in a row on each (the stack downloads from the internet, so one green run is not enough).
2. The Windows VM pass (task 16) and the macOS pass (task 17) have every item PASS or a finding with a severity, with P0 and P1 findings fixed and re-run.
3. The account checks of team-profile section 8 pass through the wizard on both platforms: gh device login with `tokenSource` `keyring`, glab token login with no token in `config.yml`, a push through each helper without a prompt, the refusal when the store is unavailable, and the refusal when a sign-in the app does not own exists for the host, including one written over the app's own after its login.
4. The design record's **Status** says phase 2 is done, and its seams table carries U1 to U11.

## Tasks

Each task is sized for one worker and has its own Reality anchor.
They run in order, each on its own branch from `main` after the one before merges, unless **Parallel** says otherwise.
A task that touches a shared contract, authorization or credentials, or security gets one fresh-context `reviewer` before merge, per the author's rule: tasks 3, 4, 5, 6, 7, 8a, 8b, 10, 11, 12, 13, and 14. Only P0 and P1 findings block the merge.
A task whose tests use a fixture that changes the machine registers it through the guard (**Fixtures that change the machine**), and its reviewer checks that none bypasses it.

### 1. App skeleton and CI

- **Files/area:** `app/` (package.json with Electron 45.0.0, TypeScript 7.0.2, electron-builder 26.18.0, Playwright as a test dependency), `app/src/main/index.ts` (single instance, `BaseWindow` with the two views, menus, `userData` moved before `requestSingleInstanceLock`), `app/src/renderer/` (one welcome screen, `style.css`, `i18n/en.ts`, `i18n/zh-TW.ts`), `electron-builder.json` (the fuses of the Decisions table), `.github/workflows/ci.yml` with the macOS store smoke test, `app/test/harness/hosted.ts` (the guard of **Fixtures that change the machine**) and the fixture scan beside it; the `SBD_BUILD` switch of the Decisions table (product name and application id per build).
- **Behavior:** the packaged app opens on the welcome screen in the OS language with a switch; the UI-rule tests exist (i18n parity, CSS-only animation, uniform borders).
- **Constraints:** no runtime dependency besides electron-updater (added in task 13); `STRAW_BOSS_DESK_ROOT` honored.
- **Reality anchor:** `ci.yml` green on `windows-2025` and `macos-15`, including the keychain smoke test; a Playwright test launches the packaged app on both and uploads screenshots in en and zh-TW; the reduced-motion test finds no running infinite animation; a test reads the packaged binary's fuses (`RunAsNode` and `EnableNodeOptionsEnvironmentVariable` off); the guard's own test passes, and the store smoke test is a guarded fixture (a local run uses a scratch `HOME` keychain); the fixture scan passes, and fails on a planted `security add-generic-password` in a test file outside the harness; a build without `SBD_BUILD=release` reports the product name `Straw Boss Desk Dev`.
- **Depends on:** none.

### 2. `stack.json`

- **Files/area:** `stack.json`, `stack.schema.json`, `scripts/check-stack.mjs`, `.github/workflows/stack-check.yml`.
- **Behavior:** the kit's `pins.json` content with platform keys `win32-x64`, `darwin-arm64`, `darwin-x64` (Windows is x64 only, by the Decisions table), plus macOS Node and herdr (from `spike/mac/env.sh`), dugite-native Git for macOS, `fd` and `ripgrep`, the profile package entry, `schema`, `generation`, `minShell`; playwriter dropped; ttt kept as an optional entry.
- **Reality anchor:** `check-stack.mjs` passes on both runners (every asset's SHA256 and every package's registry integrity); a schema test refuses a missing SHA256, an unknown platform key, and a non-exact version.
- **Depends on:** none. **Parallel:** with task 1.

### 3. Layout and environment

- **Files/area:** `app/src/main/paths.ts`, `env.ts`, `platform/` (interfaces and both implementations for Processes, UserPath, CredentialStore, Locate).
- **Behavior:** the layout and its constraints (agent folder inside home by `realpath.native`, macOS socket length and its fallback, the sidecar socket length recorded, all in `state/layout.json` once); the constructed environment: its unset list, the telemetry switches, `NODE_USE_SYSTEM_CA`, `ZDOTDIR` on macOS, `STRAW_BOSS_DESK_ROOT`, the proxy and CA pass-through, and the OS proxy setting (**The OS proxy setting**); `UserPath` with the rules of **Writing the PATH entry**; `CredentialStore` with probe, a listing with name, account, and modification time (macOS `dump-keychain` without `-d`, which reads no secret; Windows `CredEnumerateW` through one PowerShell `Add-Type` helper that outputs only name, user, and `LastWritten`, **The code-host screens**), and delete; the fallback folders per root (`<id>`).
- **Reality anchor:** unit tests on both runners: a CJK and a space-containing root; on Windows a junction that points `LOCALAPPDATA`-like folders outside home moves the agent folder; on macOS a long user-name path takes the `~/.straw-boss-desk/<id>/config` fallback, and two such roots get two different fallback folders; the built environment carries none of the forbidden variables even when the test sets them all, carries every telemetry switch, and passes through every proxy and CA variable the test sets (checked in a real child process); with `resolveProxy` stubbed to `PROXY 127.0.0.1:<port>` of a test-local CONNECT proxy (test code), a child `npm view <package> version` goes through that proxy, `NO_PROXY` holds the loopback names, and a set `HTTPS_PROXY` is kept over the stub's answer; a list answer (`PROXY 127.0.0.1:<port>; PROXY 10.0.0.1:8080; DIRECT`) takes its first entry; with the registry behind the proxy and a recipe GitLab host answered `DIRECT`, the built environment's `NO_PROXY` holds that host beside the loopback names; `DIRECT` for the registry, `SOCKS`, and a host whose proxy differs from the registry's set nothing and are logged; `CLAUDE_SECURESTORAGE_CONFIG_DIR` set by the test is not carried. `UserPath` against a test registry key: a `REG_EXPAND_SZ` value with `%USERPROFILE%` entries keeps its type and entries after an add and a remove; only the exact entry is removed; an emptied value is deleted; one real add and remove on the runner's `HKCU\Environment` returns it byte for byte. `CredentialStore` lists two seeded items under one service (accounts `""` and a user, as gh writes them) with their accounts and modification times on both runners, and a second write to one, at least 2 s later, changes only its time; on Windows the seeded items carry a known secret, and the helper's stdout and stderr and every log line lack it, and so does the listing's result in main; these and the `HKCU\Environment` write are guarded fixtures, so a local run covers them in a scratch-`HOME` keychain on macOS and skips them on Windows. A Windows unit test parses a zh-TW `CredEnumerateW` result, so nothing depends on localized text. Reviewer before merge.
- **Depends on:** task 1.

### 4. Engine core

- **Files/area:** `app/src/main/bootstrap/` (`engine.ts` as a `utilityProcess`, `graph.ts`, `stage.ts`, `state.ts`, `download.ts` on Electron `net`, `extract.ts` with `tar` by absolute path, `log.ts` with the redactor and rotation).
- **Behavior:** the stage contract, staging and activation, resume, rollback, failure categories, logs; installed-file hashes recorded and checked by `detect` (R-F009).
- **Reality anchor:** unit tests against a local HTTP fixture server (test code only): a wrong SHA256 activates nothing and is never retried; killing the engine mid-stage and resuming re-runs only that stage and leaves no staging folder; a failing verify of version B leaves version A active; a corrupted installed binary fails `detect`; no log line holds a planted token, a GUI URL, or any secret value registered with the redactor (exact match); on Windows a GNU `tar` placed first on the PATH is not used. Reviewer before merge.
- **Depends on:** task 3.

### 5. Tool stages

- **Files/area:** `bootstrap/stages/` for `preflight` (with the check of the recipe's forge hosts), `node`, `git`, `herdr` (its config with `default_shell` on macOS, and the `ZDOTDIR` files), `fd-rg`, `gh`, `glab`, `opt:<tool>` (today `opt:bun`, run only for a tool the recipe names), `tool-paths` (**Tool paths**), `launchers` (port of `forge-cli.mjs`, R3-F002, the telemetry switches; they read `paths.sh` or `paths.cmd`; the bun launcher), `git-helpers`.
- **Behavior:** as the **Stages** table says, both platforms. It records in the design record whether dugite-native needs `GIT_EXEC_PATH` and `GIT_TEMPLATE_DIR` set, whether it reads `GIT_SSL_CAINFO` and `SSL_CERT_FILE`, and glab 1.124.0's telemetry setting (and sets it off in the launchers if there is one).
- **Reality anchor:** an e2e-light test on both runners runs these stages from an empty root: all verified, each `--version` through its launcher, each Git helper run through Git's `sh`; the app's Git runs `git ls-remote https://github.com/<a public repository>` and a `!` helper, which a wrong exec path would fail; on macOS the test runs with the developer tools moved aside, as the anchor does (a guarded fixture: a local run skips that case by name); on macOS a Herdr pane started from an app whose environment has `SHELL=/bin/bash` runs zsh and reads only the `ZDOTDIR` files; a launcher started with `GH_TELEMETRY` unset shows `GH_TELEMETRY=disabled` and `DO_NOT_TRACK=1` to its child; a second run is all `skipped-verified` in under 30 s; with a test stack whose gh pin is another released gh version, the gh stage installs it beside the old one, `tool-paths` fails `detect` and is written again while the launchers stay `skipped-verified`, and the launcher then runs the new gh; a byte search finds no version string in the launchers or the `ZDOTDIR` files and no byte of the root's path in `paths.sh` or `paths.cmd`; the Windows run sees the runner's machine-PATH `gh` and still resolves the launcher; the preflight names an unreachable host (a blackholed fixture address) within 10 s. Reviewer before merge.
  - **Preflight and a private forge host:** a recipe forge host that does not resolve (a `.invalid` name, which never resolves) gives the sentence of **Network**, **A private code host**, naming that host and saying it may be reachable only on the company network, within 10 s, as a warning: the install still completes, with every stage verified; a blackholed download host still gets the network-path wording; with no recipe host nothing of this runs.
  - **Optional tools:** with a recipe naming bun, `opt:bun` is verified and `bun --version` prints the pin through its launcher in a Herdr pane, on both runners; `command -v bun` in that pane resolves to the launcher under `<root>/tools/bin`; run with `HOME` (`USERPROFILE` on Windows) set to a scratch folder, a `bun install` of a small local package leaves nothing in that scratch home and fills `<root>/tools/bun-home`; with a recipe that names no tool there is no `opt:bun` stage in `state/bootstrap.json`, no `tools/bun`, no bun launcher in `tools/bin`, no `SBD_BUN` in the paths files, and `command -v bun` in a pane does not resolve to a file under `<root>/tools`; after the recipe drops bun, the engine run leaves `tools/bun/<version>/` in place, writes `tool-paths` and `launchers` again, and a new pane no longer finds `bun`; a full successful start then runs (with its prune of inactive versions) and `tools/bun/<version>/` is still there; naming it again downloads nothing and the launcher works; a test stack whose bun pin is another version installs it beside the old one and the launcher runs the new one. The x64 build under test is the `-baseline` zip (the stack test already pins its file name).
- **Depends on:** task 4.

### 6. pi stages and the Windows shims

- **Files/area:** stages `pi`, `pi-shim` (`pi.cmd`, `pi`, `bash.cmd`, the PATH entry through `UserPath`), `pi-settings`, `claude`; the WSL check (a module the preflight, **Repair**, and every start call) and the preflight's check for a machine-PATH `pi`.
- **Behavior:** as the **Stages** table and **Panes on Windows** say; the engine's npm stages get the resolved OS proxy (**The OS proxy setting**), resolved by main before the engine run. It records in the design record whether the bundled `claude` honours `NODE_USE_SYSTEM_CA` (a stand-in HTTPS server on 127.0.0.1 whose test CA is added to the runner's OS store, a guarded fixture), and when it does not, adds the `system-ca.pem` file and `NODE_EXTRA_CA_CERTS` of **Network**.
- **Reality anchor:** from a root task 5's stages filled, on both runners: `pi --version` through the shim (Windows) or the private prefix (macOS) prints the pin; with main's `resolveProxy` stubbed to the test-local CONNECT proxy of task 3 and no proxy variable in the app's environment, the `pi` stage's `npm install` goes through that proxy (its log shows the CONNECT to the registry) on a first install, before any start; after a first `pi --mode rpc --no-session --offline` start, `<agent>/bin` holds the pinned `fd` and `rg`, unchanged. On `windows-2025`: `pi.cmd` run from a plain `cmd` with another `pi` on the PATH runs that other `pi`, and so does `pi` from Git's `sh`; a PowerShell started with `PATH` set to `System32` plus `tools\shims` and the desk variables runs `bash '<script>'` (a script in a folder with a space and CJK characters) through `bash.cmd` into PortableGit's bash, and the script's `pi --version` prints the pin; the same holds with the root itself under `%LOCALAPPDATA%\sbd 測試`, and a test reads every file in `tools\shims` and finds no byte of the root's path in it; with `STRAW_BOSS_DESK_ROOT` naming another folder, or without the desk variables, both pass through; a child given `PI_CODING_AGENT_DIR=<cwd>\.pi\agent` still gets the pinned pi and keeps that variable; the user PATH has the entry with its registry type kept; the WSL check's walk, given a machine `Path` value and a file-exists check by the test (never a write to `HKLM`) under which `%SystemRoot%\System32\bash.exe` is the first `bash.exe`, reports it, and stays quiet when a Git for Windows `bash.exe` comes first; its real `reg.exe` read of both values runs once on the runner and parses; the `HKCU\Environment` write is a guarded fixture. Reviewer before merge.
- **Depends on:** task 5.

### 7. Profile installer and packages

- **Files/area:** stages `profile`, `pkg:*`, `team-pkg:*`; `app/src/main/profile/team-profile.ts` (port of `lib/team-profile.mjs` with RC-F002, RC-F003, RC-F004, RC-F005, P3R-F001, P3R-F002); the kit's npm failure wording.
- **Behavior:** as the **Stages** table says; the profile installs from the npm profile package.
- **Reality anchor:** the kit's node tests for the installer and the forge module, moved with them, pass on both runners, plus new cases for each followup (the path-escape and link-race cases among them); from a root tasks 5 and 6 filled, `pi --mode rpc --no-session --offline` with `get_commands` lists `skill:pm-workflow` and stderr is empty. Reviewer before merge (the `safeRel` and `writeAtomic` fixes are security fixes).
- **Depends on:** task 6.

### 8a. Runtime supervisor: start, stop, and start times

- **Files/area:** `app/src/main/runtime/` `herdr.ts`, `sbup.ts`, `stop.ts`, `supervisor.ts` (start, stop, restarts); the lifecycle in `index.ts` (single instance, `before-quit`, Windows `session-end`, `--stop-stack` on the command line and in `second-instance`).
- **Behavior:** **Start** (with the OS proxy resolved into the constructed environment before Herdr starts), **Stop**, **Start times** (recording, re-recording, adopting, killing, and the leftover listing), the WSL check at every start, single instance, `before-quit`, `session-end`, `--stop-stack`.
- **Reality anchor:** an e2e test on both runners from a root tasks 5 to 7 filled: start, GUI 200 in the view; `start.json` gains both start times after the GUI shows; a supervisor restart of Herdr (its pid killed by the test) and a `cli.mjs restart` each leave `start.json` with the new pid and its start time, and the old record gone; quit leaves no process whose executable lies under `<root>/tools` by its full path and no answering Herdr socket or pipe (found by the test, not from the records), and the log shows the recorded start times were compared; a pi the test starts by bare name (`pi`, through `#!/usr/bin/env node`, outside Herdr so the stop does not end it) is reported by pid on the failure screen and in `logs/start.jsonl`, and the test then ends it; after the app's main process is killed, the stack keeps running and the next launch reaches the GUI in under 30 s without a second Herdr, and its quit again stops everything; with a running app, a second instance started with `--stop-stack` exits and the running app stops the stack and quits. Unit tests: a recorded pid now held by another process (a dummy process with another start time) is never killed; with the start times removed from `start.json`, quit kills nothing and reports anything left; a test stop sequence whose `cli.mjs stop` leaves the sb server running reports it by pid on the failure screen; a `server.json` pid that now belongs to a dummy process outside `<root>/tools` is never recorded; the listing reads no process command line (checked on the commands it runs). Reviewer before merge (kills).
- **Depends on:** task 7.

### 8b. Runtime supervisor: following, crashes, power, and the page

- **Files/area:** `app/src/main/runtime/` `follow.ts` (from the kit), the crash budgets in `supervisor.ts`, `power.ts`; the GUI view's preload (`pickFolder`); window and page security; the test harness's scripted stub model (test code).
- **Behavior:** follow with restart detection and `view`; **Crash and sleep**; **Window and page security**.
- **Reality anchor:** an e2e test on both runners from a root tasks 5 to 7 filled: `cli.mjs restart` logged as a restart with the window live; `kill` of the sb server followed within 15 s; a fourth restart within 10 minutes shows the failure screen; `/boss gui stop`, then **Start**; an emitted `suspend` and `resume` with the URL briefly down runs no `up`; `pickFolder` with the dialog stubbed opens a base under the work folder, and the preload is absent on a page of another origin; navigation off the GUI's origin is refused; one preview-link case (**Window and page security**): with `shell.openExternal` replaced through `electronApp.evaluate`, a page script in the GUI view runs `window.open("http://127.0.0.1:8080/")` and sets `location.href = "http://localhost:8100/"`, each calls it once with that URL and the GUI view stays on its page, while `http://127.0.0.1:8101/` in either form calls it zero times; a pane check and a subagent dispatch as in **Workflows** step 7, with the fixture `~/.zshrc` a guarded fixture (a local run writes it into the scratch `HOME` the app is launched with). Unit tests of the allow rule (the pure function): `http://localhost:8080/`, `http://127.0.0.1:8080/` and `http://[::1]:8080/` open, and so do the same hosts on 8100; refused: port 8079, port 8101, no port, `http://user:pw@localhost:8080/`, `http://localhost@evil.test:8080/`, `http://localhost.evil.test:8080/`, `http://localhost.:8080/`, `http://0.0.0.0:8080/`, `http://192.168.1.5:8080/`, `ftp://localhost:8080/`, `file:///etc/hosts`, `javascript:alert(1)`, text that is not a URL, and the GUI's own origin even when a test GUI port lies in the range; `https:` links still open. Reviewer before merge (page security, the preload).
- **Depends on:** task 8a.

### 9. Wizard and settings

- **Files/area:** `app/src/renderer/wizard/`, `settings/`, `screens/`, `banner/`, the shell preload; the recipe and trust steps on `recipe/validate.mjs`; the work folder step; the install and start steps on tasks 4 to 8b. It creates the settings sections as placeholder files (`settings/accounts.ts`, `updates.ts`, `diagnostics.ts`, `computer.ts`) and their menu entries, so tasks 10 to 14 each fill only their own files.
- **Behavior:** steps 1 to 6 and 11 of **First run**, every sign-in step as a **Later** placeholder; the settings sections as placeholders; the WSL line on the welcome screen and the WSL banner at start (**Panes on Windows**).
- **Reality anchor:** `wizard-from-zero.yml` in its first form passes on both runners (the macOS default root is a guarded fixture): from zero to the GUI with all sign-ins **Later**; an invalid recipe is refused with field and rule and no value; quitting during install and relaunching opens on the install step and finishes; with the WSL check stubbed to report (test code), the welcome screen has its line and the banner shows its sentence over the GUI at start, in both languages.
- **Depends on:** task 8b.

### 10. Accounts: code hosts

- **Files/area:** `app/src/main/accounts/` (`probe.ts`, `existing.ts`, `forge.ts` with the ported verdict and R3-F001, `token-search.ts` with R3-F003), the GitHub and GitLab screens, `settings/accounts.ts` for the forges.
- **Behavior:** step 8 of **First run** and **The code-host screens** in full: the existing-sign-in check, the store probe, the record in `state/accounts.json` with modification times, **Ownership**, the verdict, and **Removing a login**.
- **Reality anchor:** on both runners: the GitHub step's command carries `--expiring=false`, and the pinned gh's `auth login --help` lists the flag (if it does not, the task stops and reports); with the GitLab test secret, token login, verdict PASS, the created entries recorded, token search 0 hits over the whole root; a seeded foreign `gh:github.com` entry stops the GitHub step before any device code, and a seeded foreign `glab:<host>:token` entry stops the GitLab step before the token field, each entry unchanged afterwards; **Sign out** with a foreign entry present runs no logout and leaves it unchanged, and with only owned entries it logs out and empties the record; after the GitLab login, a foreign write into the same `glab:<host>:token` slot (dummy secret, at least 2 s later) makes **Sign out** run no logout and leave the entry with the dummy secret, **Sign in again** stop at the existing-sign-in check, and the account row say the sign-in was changed; the entry is then marked `left` in `state/accounts.json`, its **Details** names it, and after the test deletes it, **Sign in again** passes the existing-sign-in check; every seeded entry and foreign write is a guarded fixture (a local macOS run uses the scratch-`HOME` keychain); on `macos-15` the scratch-`HOME` run stops at the probe at once with no token on disk; the masked field's value is absent from the renderer's storage and every log after sign-in (searched). Unit tests: each R3-F001 case and every fixture of the kit's nine; the probe's timeout counts as a failure; ownership is refused for a recorded name with another time, a recorded name whose time cannot be read, an unrecorded name, and a `left` name whose time matches again; a listing failure is a failed probe, not "no entry"; the macOS parser maps `"acct"<blob>=<NULL>` to the empty account; a mixed host (one owned entry, one foreign) runs no logout and marks the owned one `left`. Reviewer before merge.
- **Depends on:** task 9.

### 11. Accounts: Claude and Linear

- **Files/area:** `accounts/claude.ts`, `accounts/linear.ts` (`safeStorage`, the `ttt` stage, `ttt init`), the Claude and Linear screens, their rows in `settings/accounts.ts`.
- **Behavior:** steps 7 and 9 of **First run**; the Claude code field's rules; the Linear key's restart offer.
- **Reality anchor:** on both runners: the Claude screen's code field, fed a planted value, sends it to a stand-in CLI's standard input and the value is in no log, no command line, and no renderer storage; a dummy Linear key saved while the stack runs, then **Restart now**, appears as `LINEAR_API_KEY` in a new pane of the cloned base and in no file under the root; with `isEncryptionAvailable()` stubbed false, the Linear step refuses to save; the `safeStorage` write is a guarded fixture (a local macOS run uses a `Straw Boss Desk Dev` build with the scratch-`HOME` keychain, and the harness checks before and after that the shipped product's Safe Storage item, if any, keeps its modification time). The worker reads the Keychain naming code in the pinned SDK's bundled `claude` (as **Secrets** read it in 2.1.309) and records it in the design record; when it would use the PM's default `Claude Code-credentials` name, the task stops and reports that Claude sign-in is a K1 case for the boss. Reviewer before merge.
- **Depends on:** task 10.

### 12. Projects and recipe updates

- **Files/area:** the projects step (clone, `set-head`, the Windows symlink check, `open-base` through the GUI's HTTP endpoint as `gui-client.mjs` calls it), relay and AGENTS.md block through the installer, recipe updates from `updateUrl`; the reserved folder name `Straw Boss` in `recipe/validate.mjs`.
- **Behavior:** step 10 of **First run**, with **Projects: the default branch** and **Projects: symlinks in a repository (Windows)**; settings' Team recipe; the fetch rules of team-profile section 5 (https, no credentials, at most 3 redirects, 256 KB, public host re-checked on the resolved address and every redirect).
- **Reality anchor:** in `wizard-from-zero.yml` the public repository is cloned beside the home base and opened as a base (it appears in `herdr workspace list` and in the page); an existing folder with another `origin` is reported and untouched; a recipe repository whose `defaultBranch` differs from the server's default ends with `origin/HEAD` pointing at that branch (a local fixture server whose `HEAD` is `main`, a recipe saying `develop`: `git symbolic-ref refs/remotes/origin/HEAD` prints `refs/remotes/origin/develop`; a repository without `defaultBranch` keeps `main`), a recipe update that changes `defaultBranch` runs `set-head` again for that repository and an unchanged one is not touched, and a `defaultBranch` that `origin` lacks fails that repository alone naming the repository and the branch; a recipe repository whose folder is `Straw Boss` is refused; a **Trust** saved for the home base does not cover a clone (a fixture repository with `.pi/extensions` still gets the trust question); unit tests for each fetch rule against a local server; an update served by a local fixture server shows its change list and applies (the same check against the repository's raw URL runs in task 15, once the fixture is on `main`). **Symlink anchor:** a fixture repository whose index holds a mode-120000 entry `.agents/skills` (added with `git update-index --add --cacheinfo`, so it builds on Windows without symlink rights), a real file `.pi/settings.json`, and a mode-120000 entry `docs/link` outside the three folders; the app's Git clones it by path. On `windows-2025` the row ends done and shows the one sentence naming the repository and `.agents/skills` and no other path, the repository is opened as a base, `core.symlinks` in the clone is whatever the app's `gitconfig` gives (the test reads `git config --show-origin core.symlinks` and a search of the app's code finds no write of `core.symlinks`), and reusing the same folder shows the sentence again; a fixture repository with no such entries shows no sentence; on `macos-15` the same fixture shows no sentence and the test records that the check ran no Git process. Reviewer before merge (the fetch rules guard against SSRF).
- **Depends on:** task 11.

### 13. Updaters

- **Files/area:** `app/src/main/update/shell.ts`, `stack.ts`, `scripts/sign-stack.mjs` (signing installers and dmgs too), `test/fixtures/feed/`, `settings/updates.ts`.
- **Behavior:** **Updater** as written, both channels, the precedence, and the key list.
- **Reality anchor:** on `windows-2025`: build 0.0.1 and 0.0.2, install 0.0.1 silently, update through the local feed, 0.0.2 runs and the stack is back; a 0.0.2 installer with one byte changed (its `latest.yml` SHA512 regenerated) is refused by the Ed25519 check, deleted, and never offered. On both runners: a signed candidate applies; a wrong signature, a lower `generation`, and a `minShell` above the app are refused; a candidate whose pi stage fails rolls back, the stack starts on the old generation, and the report names the stage; a shell whose bundled `stack.json` has a lower `generation` than the downloaded one keeps the downloaded one; a candidate signed by the second key of the list verifies, and one signed by a key not in the list does not; an applied candidate that changes the Node, Git, and gh versions rewrites `paths.sh` and `paths.cmd`, and a new pane of the home base then resolves `pi --version`, `git --version`, and `gh --version` from the new folders, and still does after the next start deletes the old ones; a rolled-back candidate leaves panes on the old folders the same way. The Windows install and update are guarded fixtures (they write the user PATH entry). Reviewer before merge.
- **Depends on:** task 9. **Parallel:** with tasks 10 to 12, in its own worktree; it writes only the files above, and rebases on `main` before merge.

### 14. Diagnostics, data removal, uninstall, and the PM guide

- **Files/area:** `settings/diagnostics.ts` (collect, repair, status), `settings/computer.ts` (**Remove all data**, the detached cleanup and `remove-pending`), the NSIS uninstall script (`--stop-stack`, the PATH entry under `${isUpdated}`), `README.md` and a zh-TW PM guide: the install path per platform, SmartScreen and Gatekeeper with marked screenshot placeholders (tasks 16 and 17 fill them from the VM and the guest), Smart App Control as the boss decides it, the existing-sign-in refusal and what it means, removing a `left` sign-in by hand in Keychain Access or Credential Manager (only when it is not the PM's own) as the boss decides it (item 13), the one line on VMs on a Mac with WARP, WSL machines as the boss decides it (item 10), the notices of items 11 and 12, and **Remove all data** before uninstalling.
- **Reality anchor:** the collected zip holds no file from the excluded folders and no planted token (test); **Repair** after deleting a pi package reinstalls it, after deleting the PATH entry adds it again, and the stack starts. On `windows-2025`: after the update 0.0.1 to 0.0.2 the PATH entry is still there; after uninstall the entry is gone, no process under `<root>/tools` remains (the leftover listing's rule), and `<root>` is kept. On both runners: **Remove all data** leaves no process under `<root>/tools` (the same rule), no PATH entry, no `<root>` and no fallback folder within 30 s of the app's exit (on Windows with `<root>/electron` held open until the exit; a unit case covers a root with a fallback folder), and no owned store entry, while a seeded foreign store entry, a foreign write over an owned one, and the work folder are unchanged; the foreign write over the owned one is named on the confirmation screen and in the result; on macOS the running build's "`<product>` Safe Storage" Keychain item and the app's `Claude Code-credentials-<8 hex>` item are gone, and on a local run the shipped product's item is never touched; a `<root>` left with `remove-pending` (the cleanup killed by the test) is removed at the next launch before any window opens. The uninstall, the PATH, the store, and the Safe Storage cases are guarded fixtures. Reviewer before merge (PATH removal and credential removal).
- **Depends on:** tasks 12 and 13.

### 15. Full anchor run

- **Files/area:** `wizard-from-zero.yml` in its final form (steps 1 to 10 of **Workflows**), nightly runners; the recipe-update check of task 12 pointed at the fixture's raw URL on `main`.
- **Reality anchor:** the recipe update from the raw URL shows its change list and applies; five consecutive green runs on `windows-2025` and `macos-15`; one green nightly on `windows-11-arm` and `macos-15-intel`, or a finding per failure.
- **Depends on:** task 14.

### 16. Windows VM acceptance

- **Files/area:** a report at `~/.local/share/sbd-review/phase2-vm/report.md`; the kit's state in the VM reset first, Git for Windows not installed.
- **Network:** the VM gets a UTM Bridged NIC beside its Shared one (**Network**); when bridging does not work on the Wi-Fi, the steps that need GitHub, npm, or the GitLab host run with WARP off and WARP is reconnected after.
- **Reality anchor:** every item PASS or a finding: the installer downloaded in Edge with Mark-of-the-Web (Edge warning, SmartScreen dialog; the zh-TW screenshots replace the guide's placeholders, committed on this task's branch); Smart App Control state read and its registry value confirmed, and an SAC-on image tested if one is available; the wizard from zero on the CJK profile under the default root; Claude sign-in and a real model turn; a subagent with the real model, dispatched from a pane, whose child runs `command -v gh git pi bash` (all the app's); gh device login and glab token login with the verdicts, a push through each helper, token search; whether a `gh:_refreshable:github.com` entry appears after the device login (a finding if it does: gh would then rewrite the app's entry on use, **Ownership**), and whether the entry's `LastWritten` is unchanged after an hour of agent use; the existing-sign-in refusal with a seeded entry; the store-unavailable refusal in a network-logon session through the test script (**What runs headless**); `safeStorage` roundtrip in the packaged app before and after an update 0.0.1 to 0.0.2, and whether any SmartScreen prompt appears on the update; the PATH entry after the update and after uninstall; **Remove all data**; whether the WSL check matches a real WSL install (when the VM has or can enable WSL); a real sleep of 5 minutes.
- **Depends on:** task 15. Run by whoever drives the VM, with the author for the sign-ins.

### 17. macOS acceptance

- **Files/area:** a report at `~/.local/share/sbd-review/phase2-mac/report.md`.
- **Where:** a fresh macOS guest in UTM on the author's Mac, never signed in with the author's accounts, with no Command Line Tools and no Xcode, networked as task 16; plus the author's Mac for the hardware items only, with a development build on its own data root and Herdr socket and no sign-ins (repository AGENTS.md). The approved account-check design 1b (`mac-account/design.md`) runs earlier on its own branch with the spike kit; this task repeats its account items through the wizard in the guest, where no isolation trick is needed.
- **Reality anchor:** every item PASS or a finding. In the guest: Gatekeeper's first open and **Open Anyway** (does it ask for an administrator password; screenshots replace the guide's placeholders), the move to Applications as an administrator and as a standard user (the `~/Applications` path); the wizard from zero with no developer tools present (no install dialog appears); Claude sign-in, with the guest's own default `Claude Code-credentials` item seeded first: the app's credentials land in `Claude Code-credentials-<8 hex>` and the seeded item keeps its modification time (attributes only), a model turn; gh and glab logins with the verdicts and gh's `tokenSource` value, and whether a `gh:_refreshable:github.com` item appears after the device login (a finding if it does, as in task 16); the existing-sign-in refusal with a seeded entry; the Linear key's Keychain prompt after an ad-hoc-signed update; **Remove all data**. On the author's Mac: a real sleep of 5 minutes; the camera permission prompt from the GUI's QR join.
- **Depends on:** task 15. **Parallel:** with task 16.

### 18. Retire the spike and update the records

- **Files/area:** `spike/` removed (the docs under `docs/spikes/` stay); `docs/specs/2026-10-25-design.md` Status and seams (U1 to U11), Tools table (dugite-native, `fd`, `rg`, playwriter dropped, bun as an optional tool a recipe turns on).
- **Reality anchor:** `ci.yml` and `wizard-from-zero.yml` green after the removal; no file outside `docs/` refers to `spike/`.
- **Depends on:** tasks 16 and 17 with no open P0 or P1.

## Risks

- **The pi shims (U1)** are the only thing between a Windows pane and the machine PATH. A `pi` or a WSL `bash.exe` on the machine PATH wins over them; the preflight reports both, the WSL check repeats at every start with a banner, and seam U10 removes the `bash` case. If a pane starts pi by another path (a full path to `node`), the shim is skipped and the agent finds the machine's `gh`. Tasks 6 and 8b and the anchor's step 7 read the PATH from inside real panes and a real subagent; Herdr's fix (U1) removes the risk.
- **A PM who already uses gh or glab for a code host** cannot sign the app in to that host (K1): the step stays **Later** and the PM's agents cannot push there through the app until seam U9 lands. Engineers and engineer-adjacent PMs are the likely cases; the pilot will show how many.
- **Smart App Control** blocks the unsigned app and probably the unsigned `herdr.exe` on a fresh Windows 11. Signing the app does not cover `herdr.exe`; a signed herdr release does. The policy is **Open for the boss**, item 6.
- **Nested home base**, only if the boss keeps the home base as the parent of the clones (item 7): pi-straw-boss does not refuse it (`src/spawn.ts`, `openBase`), but three things leak into every clone: a saved **Trust** on the home base, or pi's "Trust parent folder" chosen in any clone, trusts every clone, so a teammate repository's `.pi/extensions` loads with no question (pi's trust is the closest of a folder and its parents); any `AGENTS.md` left in the home base applies to every clone session (pi loads context files from the folder and all its parents); and an ancestor `.agents/skills` or `.pi/` makes every clone ask the trust question. The recommended sibling layout avoids the saved **Trust**, the `AGENTS.md`, and the ancestor folders, and task 12's anchor checks it. It does not avoid pi's terminal answer "Trust parent folder" chosen in a clone, which trusts `~/StrawBoss` and so every clone; in desk mode the trust question goes to the GUI, which offers no parent option (`gui/trust.ts`), so only a PM who answers in a pane's terminal can choose it.
- **The macOS path with a space** may break a tool that writes an unquoted path into a script or a shebang. CI runs under it, so it fails early.
- **Company proxies and TLS inspection** are configured through the OS proxy setting, the OS certificate store, and pass-through variables (**Network**) but untested on a real such network until the pilot; a PAC file that sends hosts through different proxies, or a SOCKS proxy, is logged and not configured; hosts it sends `DIRECT` are honored through `NO_PROXY`.
- **The inspect fuse** stays on in v1 so the anchor drives the shipped build; a same-user process can attach a debugger to the app, which on an unsigned app gains it nothing it lacks already.
- **A private code host** (FE2's `gitlab.moldplan.app`) resolves only on the company tailnet, so a PM whose computer is off that network cannot clone, sign in to GitLab, or push, and desk installs no VPN to fix it (it needs administrator rights and a network driver). The preflight names the host with the company-network sentence, the guide lists the network as a prerequisite, and a connection that drops mid-session still shows as a Git or glab error, not as this sentence (**Network**).
- **Symlinks in a repository on Windows.** A repository that keeps its pi skills in a symlink (`.agents/skills`) gives a Windows PM a text file instead of a folder, and the app can neither turn symlinks on (they need Developer Mode or elevation) nor repair the repository; it only says so, once, and the fix is in the repository (**First run**, step 10). The first case, FE2, switches to a real directory.
- **Floating transitive dependencies (U7)**: a package's dependency can change between two installs of the same pin. Registry integrity covers only the top package.
- **CI network**: the anchor downloads about 1 GB per run from nodejs.org, GitHub, gitlab.com, and npm. A provider outage fails the anchor without a bug; the five-run rule and the failure categories make that visible.
- **Account checks need people and test accounts**: the device flow and the Claude sign-in cannot run unattended, and the store-unavailable refusal needs a token that is not the author's main one.

## FE2 asks

The CTO approved four asks on 2026-11-01 for the MoldPlan FE2 PM workflow (`scratch/pm-workflow/design.md` §4.3 in moldplan-center); a fifth row records the prerequisite they bring. This spec carries their contract; the code is in tasks 5, 8b, and 12, and the recipe and stack parts are already in `recipe/` and `stack.json`.

| # | Ask | Where it lives | Why |
| --- | --- | --- | --- |
| 1 | FE2 recipe with `defaultBranch: develop` | **Projects: the default branch**; task 12 anchor; team-profile section 5 | already supported (recipe `repos[].defaultBranch`, `set-head`, the PM workflow reading `origin/HEAD`); the anchor now proves `origin/HEAD` ends on the recipe's branch and moves with a recipe update |
| 2 | Optional tool bun 1.2.23, turned on by the recipe | `stack.json` `optionalTools`, recipe `tools`; Decisions (**Optional tools**), **Stages** (`opt:<tool>`), **Tool paths**; task 5 anchor | FE2 installs and starts only with bun; x64 uses the `-baseline` zips so a CPU or an emulator without AVX2 works |
| 3 | Open `http://localhost:8080-8100` links | **Window and page security**; Decisions (**Preview links**); task 8b anchor; **Deferred** | PMs cannot open the preview URL today; the fixed narrow range is the CTO's ask and limits the reach of a link to local services |
| 4 | Windows symlinks in repositories | **Projects: symlinks in a repository (Windows)**; task 12 anchor; **Risks** | PortableGit's `core.symlinks=false` makes a link a text file; the app cannot enable symlinks without administrator rights, so it says so and the repository fixes it |
| 5 | Private forge host as a prerequisite | **Network** (**A private code host**); **Stages** (`preflight`); task 5 anchor; **Risks** | `gitlab.moldplan.app` resolves only on the company tailnet, and desk installs no VPN |

**Review notes for later tasks** (FE2R, `~/.local/share/sbd-review/fe2-asks/review.md`; P0=0 P1=0, the two P2s are fixed in the text above):

- Task 5 adds `optionalTools` to `parseStack` and `Stack` (task 4's parser ignores the key today and accepts generation 2) and passes the recipe's tool names into the engine's configuration (FE2R-F003). It also writes a `bunx` launcher beside `bun`, and checks whether FE2's scripts spawn `bun` without a shell on Windows, where `bun.cmd` would not be found; if they do, the launcher folder gets a `bun.exe` shim instead (FE2R-F009).
- Task 8b compares a loopback link's port against the GUI's port on all three loopback hosts, not one origin string, and passes the parsed `href` to `openExternal`. The in-page (`will-navigate`) path now opens allowed `https:` links externally too; the task 8b anchor covers that path as well. The fixed port range limits which loopback services a link opens directly; it does not stop an `https:` page from redirecting to another loopback port, so the range is a narrowing, not a CSRF guarantee (FE2R-F006, FE2R-F007).
- Recipe tool names have no hyphen, and `scripts/lib/stack.mjs` refuses an optional tool named after a folder under `tools/` (`bin`, `shims`, `downloads`, `bun-home`, `staging`) (FE2R-F008). The recipe schema says `uniqueItems` (FE2R-F005). `knownTools` stays optional, so a shape-only check stays possible without a stack; the shell always passes it (FE2R-F004).

## Open for the boss

**Decided 2026-11-01:** the boss approved this spec and took the recommendation on every item below (「全部照建議核准」). Item 13 is guide only. Item 5's accounts and secrets are prepared by the boss when the tasks need them.

1. **Windows code signing.** Recommendation: stay unsigned through the pilot, as the design record decides, and buy an OV code-signing certificate with cloud signing before more than the pilot PMs install it. Azure Artifact Signing is not available to Taiwanese individuals or organizations. A certificate costs on the order of a few hundred US dollars a year, and SmartScreen still warns until reputation builds.
2. **Apple Developer Program** (US$99 a year; an organization membership needs a D-U-N-S number). Recommendation: join before any PM pilots on a Mac. Without it the PM must click **Open Anyway** in System Settings, which may need an administrator password; updates mean downloading a dmg by hand; and the Linear key may ask for Keychain access after each update.
3. **The app's name, icon, and application id.** Recommendation: the name "Straw Boss Desk" in both languages, an icon drawn from the straw-boss mark, and an id under a domain the boss controls, e.g. `tw.wayneh.straw-boss-desk`. The internal folder name `straw-boss-desk` stays whatever is chosen.
4. **One user PATH entry on Windows (seam U1).** The repository says the app never writes to the user's global setup. The shim folder adds one entry to the user PATH, holding `pi.cmd`, `pi`, and `bash.cmd`, each of which passes every call through to the user's own program outside the app's panes; the entry survives updates, and the uninstaller and **Remove all data** remove it. Recommendation: allow it until Herdr keeps the server's PATH for panes. The alternative is agents, and every subagent, not finding the app's pi, Git, and code-host CLIs on Windows.
5. **Test accounts and CI secrets.** Recommendation: a dedicated gitlab.com account with one empty project and an `api` token (one year expiry) as an Actions secret, for the CI login and the VM's refusal check; a dedicated GitHub account for the device-flow checks, so neither touches the boss's own logins; an Ed25519 signing key for installers and `stack.json`, generated by us and stored in a protected `release` environment with the boss as required reviewer, so no workflow can use it without his approval. Adding repository secrets and the environment needs the boss's approval.
6. **Smart App Control.** An unsigned app cannot run at all on a Windows 11 with SAC on, and the only thing a PM can do is turn SAC off, which some Windows builds cannot undo without a reinstall. Recommendation: in the pilot, machines with SAC on are not supported; the guide says so and asks the PM to contact us rather than turn SAC off. SAC-on machines become supported once the app is signed (item 1) and herdr ships signed releases (to be asked upstream).
7. **Where the home base sits.** The first draft made the work folder itself (`~/StrawBoss`) the home base, with every clone inside it. pi then treats the home base as a parent of each clone: a **Trust** saved for the home base trusts every clone, including a teammate repository's extensions, and any `AGENTS.md` left in the home base applies to every clone. Recommendation: the home base is `~/StrawBoss/Straw Boss`, beside the clones, at the cost of one more visible folder. The spec and the tasks are written this way unless the boss prefers the single folder.
8. **Notice: playwriter is dropped from the default stack.** The approved design's Starting point and Tools rows include it, but no role or skill in the profile uses it now that visual-tester is out of v1, and it needs a Chrome extension installed by hand. Recommendation: drop it; it can come back as a recipe package. Dropped unless the boss objects.
9. **Notice: Claude Code keeps its login in plain text on Windows.** It is a `.credentials.json` file in the app's private folder, which any program running as the PM can read. On macOS it goes to a Keychain item of its own, apart from the PM's own Claude Code login (read from Claude Code 2.1.309; tasks 11 and 17 confirm it for the pinned version). This departs from the repository's secrets rule, and it is Anthropic's choice, outside our control. Recommendation: accept it for the pilot, say so in the guide, and move to the OS store if Claude Code adds it.
10. **Windows machines with WSL.** On a Windows machine with Windows Subsystem for Linux, the `bash` a subagent is started with is WSL's, so agents cannot hand work to helper agents (subagents); everything else works. The fix is in pi-herdr-agents (seam U10), a PR from the author's fork to a project we do not control, so no date can be promised. The app finds the case at install, at **Repair**, and at every start, and tells the PM on the welcome screen and in a banner. Recommendation: in the pilot, WSL machines are supported without subagents, the guide says so, and the PR is opened in phase 2. The alternative, Herdr's `default_shell` set to PortableGit's bash on Windows, would also change how pi-straw-boss starts `pi.cmd` in a pane (`Start-Process -Wait` is PowerShell's), so it needs its own check and is not recommended now.
11. **Notice: on Windows, closing the window stops every running agent.** Closing the window quits the app and stops the stack, the Windows convention; agents in the middle of work end, and Herdr restores their workspaces at the next start. Until pi-straw-boss says whether agents are working (seam U3), the app cannot warn first. Recommendation: keep it, and say so in the guide; the warning comes with U3. The alternative, a tray icon that keeps the stack running, is a larger change kept for later.
12. **Notice: uninstalling without Remove all data leaves the PM's code-host sign-ins.** The gh and glab tokens the app's logins wrote stay in Windows Credential Manager or the macOS Keychain, with the data root, so a reinstall resumes signed in. The PM guide tells the PM to use **Remove all data** first, which signs them out (only the entries the app owns, and it names any it leaves, item 13). Recommendation: keep this, as most apps do.
13. **When the app's own sign-in is changed afterwards.** The app owns a GitHub or GitLab sign-in only while it is exactly as the app left it (K1). If something writes over it later (the PM's own `gh auth login`, or an agent running `gh auth refresh` in a pane), the app treats it as the PM's: **Sign out** and **Sign in again** stop with a sentence, and **Remove all data** leaves the entry in the credential store, naming it on its confirmation screen and in its result. The PM's own `gh` or `glab` cannot remove it either, since their settings folder does not know that sign-in. gh's own token refresh, the routine cause, is switched off (`--expiring=false`); tasks 16 and 17 confirm that. Two ways out:
    - **Guide only** (recommended): the app names the entry and links to a guide page that shows how to delete it in Keychain Access or Credential Manager, and says to do it only if the PM never signed in to that site with their own tool on this computer. After that, **Sign in again** works. K1 stays as decided.
    - **A confirmed Replace it** in the app, which deletes the changed entry after the PM confirms that it is not theirs. Easier for the PM, but it bends K1: the app would delete an entry it does not own on the PM's word, and if the PM is wrong, their own token is gone.

    Recommendation: guide only for the pilot, since what remains after `--expiring=false` is either the PM's own login (where deleting would be wrong) or a rare agent command; revisit if tasks 16 and 17 or the pilot show it happening.

## Deferred

- **A recipe-set range for preview links.** The allowed loopback ports (8080 to 8100) are fixed in the app (**Preview links**). A team whose preview server uses other ports would need a recipe field, shown on the trust screen and validated to a short range of loopback ports; nothing needs it yet, and a wider reach is the cross-site request forgery exposure the fixed range limits.
- **P2S-F017, the sidecar socket fallback itself.** No v1 path starts a non-pi agent, so no sidecar socket is opened; the preflight records the length, and the fallback goes upstream as seam U11.
- **Several proxies and SOCKS (from R-F005 and R2-F006).** A PAC file that sends the registry, GitHub, and the forge hosts through different proxies, or a SOCKS proxy, is logged and not configured: one `HTTPS_PROXY` cannot name two proxies, and npm cannot use SOCKS. Hosts sent `DIRECT` are handled (`NO_PROXY`). No test network here has either case, and the first pilot PM on one is the test (**Network**).
- **The same-second race on macOS (R2-F008).** `mdat` is kept to the second, so a foreign write in the same second as the app's login, before its recording read, would be recorded as the app's. The window is a fraction of a second during a login the PM is watching; it is stated in **Ownership** and not otherwise handled.
- **A launcher guard against `gh auth` in panes (from R2-F001).** The launchers could refuse `gh auth login`, `logout`, and `refresh` (and glab's) when an agent runs them in a pane, which would remove the last routine way the app's entry turns foreign. It changes what an agent may do with the CLIs, so it waits for the pilot to show whether agents do it.
- **Local runs of the Windows store fixtures (from R-F002).** Credential Manager has no per-process equivalent of the scratch-`HOME` keychain, so those cases run only on the hosted runner; the author's development machine is a Mac, and the Windows VM runs the acceptance pass (task 16), not the test suite.

## Review status (P2S, 2026-11-01)

| Finding | Status |
| --- | --- |
| F001 K1 | fixed: boss decision written in (Decisions; **The code-host screens**; **Removing a login**; task 10 anchor with seeded entries; seam U9) |
| F002 subagents on Windows | fixed: `pi` and `bash.cmd` beside `pi.cmd` (**Panes on Windows**); anchors in tasks 6 and 8, **Workflows** step 7, and task 16 with a real model; WSL case reported, seam U10 |
| F003 start times | fixed: one asynchronous read after the GUI shows into `start.json`; no record and no handle means no kill, only a report (**Start times**; task 8 anchor) |
| F004 WARP | fixed: **Network** rewritten from the scout's report; tasks 16 and 17 networking |
| F005 proxy and CA | fixed: pass-through, Electron `net`, `NODE_USE_SYSTEM_CA`, preflight wording, task 3 test |
| F006 telemetry | fixed: Decisions row, launchers and environment, task 3 and 5 checks; glab's setting checked in task 5 |
| F007 macOS panes | fixed: `ZDOTDIR` (**Panes on macOS**); fixture `~/.zshrc` in the anchor |
| F008 nested home base | fixed: sibling layout recommended and specified; trade-off in **Open for the boss** item 7; task 12 anchor |
| F009 CI data root | fixed: macOS default root, Windows root inside home with a space and CJK; fallback as a unit case |
| F010 PATH entry and uninstall | fixed: **Writing the PATH entry**, **Uninstall and data**; task 14 anchor |
| F011 Smart App Control | fixed: explanation moved to the guide; **Open for the boss** item 6 |
| F012 updater trust | fixed: Ed25519 on installers and dmgs, protected environment, precedence, key rotation; task 13 anchor |
| F013 reviewers | fixed: reviewer on tasks 3 to 8 and 10 to 14 |
| F014 Linear key | fixed: **Restart now** or **Later**; task 11 anchor |
| F015 bare Mac | fixed: `ls-remote` and helper anchor, developer tools moved aside in CI, the macOS guest in task 17 |
| F016 macOS store probe | fixed: go-keyring's default keychain, 10 s limits, scratch-`HOME` refusal, smoke test in task 1 |
| F017 sidecar socket | deferred (above) |
| F018 playwriter | fixed: **Open for the boss** item 8 |
| F019 exact-value redaction | fixed: redactor; Claude code field rules |
| F020 task sizing | fixed: tasks 6 and 9 split (now 6, 7, 10, 11); task 13's parallel files named; local feed in task 12's anchor |
| F021 `safeStorage` key folder | fixed: App data layout constraint |
| F022 `~/Applications` | fixed: the app's own copy; task 17 checks it |
| F023 fuses | fixed: Decisions row; task 1 anchor |
| F024 network-logon session | fixed: test script on the compiled modules (**What runs headless**) |
| F025 Claude plain text | fixed: **Open for the boss** item 9 |
| F026 `tar` path | fixed: Decisions row; task 4 anchor |

## Recheck status (R-F, 2026-11-01)

| Finding | Status |
| --- | --- |
| R-F001 K1 ownership by name | fixed: **Ownership** by name and store modification time (macOS `mdat`, Windows `LastWritten`), chosen over a token fingerprint and the account name; changed, unreadable, or unrecorded means foreign; Decisions row, **Removing a login**, **Remove all data**, U9; anchors in **Workflows** step 4 and tasks 3, 10, and 14 |
| R-F002 machine-changing fixtures | fixed: **Fixtures that change the machine** (the table, the multi-signal `hostedRunner` guard, skip with a named reason locally and fail under `SBD_REQUIRE_HOSTED_FIXTURES=1`), the guard's own test in task 1, the rule in tasks 1, 3, 5, 6, 8b, 9, 10, 13, and 14, and the reviewer's check that no fixture bypasses it |
| R-F003 path in a `.cmd` | fixed: the shims hold no path, find the root from `%~dp0` and `${0%/*}`, and test `STRAW_BOSS_DESK` and `STRAW_BOSS_DESK_ROOT`, not `PI_CODING_AGENT_DIR`; task 6 anchor under a CJK root and a byte search of the shims |
| R-F004 WSL | fixed: the WSL check at install, **Repair**, and every start; welcome line and banner (task 9 anchor); **Open for the boss** item 10 |
| R-F005 OS proxy | fixed: **The OS proxy setting** through `resolveProxy` at each start; Claude named, with the `system-ca.pem` fallback after task 6's record; task 3 anchor; PAC and SOCKS deferred |
| R-F006 start-time records | fixed: **Re-recording** after every restart; adoption without a read, the comparison in the deferred read; the stop's leftover listing; **Workflows** steps 6 and 8 and task 8a find leftovers themselves |
| R-F007 pane shell | fixed: `default_shell = "/bin/zsh"` on macOS; task 5 anchor |
| R-F008 store listing | fixed: `dump-keychain` without `-d`; `CredEnumerateW` only, no `cmdkey`; task 3 anchor |
| R-F009 `<root>/electron` in use | fixed: detached cleanup after exit and `remove-pending` at the next launch; task 14 anchor |
| R-F010 `--stop-stack` and the lock | fixed: handled in `second-instance`; task 8a anchor |
| R-F011 task wiring | fixed: guide screenshots as placeholders filled by tasks 16 and 17; the raw-URL check listed in task 15; task 8 split into 8a and 8b |
| R-F012 two notices | fixed: **Open for the boss** items 11 and 12 |
| R-F013 Claude Keychain item | resolved from the source: Claude Code 2.1.309 hashes `CLAUDE_CONFIG_DIR` into the service name, so no collision; `CLAUDE_SECURESTORAGE_CONFIG_DIR` is never carried; tasks 11 and 17 confirm the pinned version; **Remove all data** signs Claude out |
| R-F014 sibling layout claim | fixed: **Risks** names the terminal "Trust parent folder" residue |
| R-F015 key compromise | fixed: **The key** states no revocation and the manual recovery |

## Recheck 2 status (R2-F, 2026-11-01)

| Finding | Status |
| --- | --- |
| R2-F001 gh rewrites turn the app's entry foreign | fixed: `--expiring=false` in the GitHub login (Decisions, **GitHub (device code)**; task 10 checks the flag in the pinned gh); tasks 16 and 17 record whether a `gh:_refreshable:` entry appears; entries the app created but did not remove stay in the record as `left`, and **Sign out**, **Details**, and **Remove all data**'s confirmation and result name them (tasks 10 and 14); the stuck case is **Open for the boss** item 13, recommended guide only; a launcher guard is deferred |
| R2-F002 versioned tool folders | fixed: **Tool paths**: the `tool-paths` stage writes `paths.sh` and `paths.cmd` (relative, ASCII) from `current.json`; the shims, launchers, and `ZDOTDIR` files read them and hold no version; `tool-paths` and `pi-settings` keep the versions in their evidence, so every update, rollback, or **Repair** writes them again; anchors in tasks 5 and 13 |
| R2-F003 proxy before the first install | fixed: main resolves before every engine run as well as at each start (**The OS proxy setting**); task 6 routes the first `pi` install through the test proxy |
| R2-F004 `CredEnumerateW` returns the secret | fixed: the wording says so; one PowerShell `Add-Type` helper outputs only name, user, and `LastWritten`, never dereferences `CredentialBlob`, and calls `CredFree` (**The code-host screens**, Decisions); task 3 seeds a known secret and searches the helper's output, main's result, and every log |
| R2-F005 Safe Storage item per product | fixed: non-release builds are `Straw Boss Desk Dev` (Decisions, task 1); a guarded fixture row for the Safe Storage and Claude items, with the harness refusing a local run of the shipped product name; tasks 11 and 14 |
| R2-F006 internal GitLab through the proxy | fixed: each recipe forge host is resolved, and hosts answered `DIRECT` go into `NO_PROXY`; task 3 |
| R2-F007 `ps -o comm` shows `argv[0]` | fixed: the leftover listing matches by full executable path (`lsof -d txt` on macOS, `ExecutablePath` on Windows) and never reads command lines; task 8a leaves a bare-name pi running and expects it reported; **Workflows** step 8 and task 14 use the same rule |
| R2-F008 one-second `mdat` | fixed in wording (**Ownership**); the anchors keep 2 s; the same-second race is deferred as accepted |
| R2-F009 separators and the WSL check | fixed: the POSIX shim turns `\` into `/` before comparing; the WSL check reads the registry with `reg.exe query`, no PowerShell |
| R2-F010 fallback folders per home | fixed: `~/.straw-boss-desk/<id>/…` with `<id>` from the root's hash; **Remove all data** deletes the fallback folder; tasks 3 and 14 |
| R2-F011 `resolveProxy` lists, follower pids | fixed: the first entry is taken; a pid the app did not start is recorded only when its executable lies under `<root>/tools`; tasks 3 and 8a |
| R2-F012 opt-in guard | fixed: the fixture scan over `app/test` (task 1); task 6's WSL case passes the `Path` value and the file check in and never writes `HKLM` |

## Build notes

Decisions made while building, with the task that made them. Later tasks follow them.

- **Task 3: gh and glab configuration stays at `<root>/config/gh` and `<root>/config/glab-cli`**, even when the macOS fallback moves Herdr's folder. The launchers derive that path from their own location; only `herdr/` and `zsh/` follow the fallback `configHome`.
- **Task 3: the agent-folder-inside-home rule is Windows only**, as **App data layout** says. A macOS development root outside home keeps its agent folder.
- **Task 3: the macOS pane `PATH` is the tool folders followed by `/usr/bin:/bin:/usr/sbin:/sbin`**, never the inherited `PATH`, so a Homebrew gh, git, or node cannot win (F007). Windows keeps the inherited `PATH` after the tool folders.
- **Task 3: kit parity adds `NPM_CONFIG_FUND=false` and `NPM_CONFIG_AUDIT=false`**; credential-store calls on Windows have a 60 s limit.
- **Task 3 review (T3-F002 to T3-F007), carried by later tasks:**
  - Task 10 never records an empty modification time and never treats `""` as a match: an unreadable time is foreign (T3-F004).
  - Task 10 deletes only an entry it listed: on Windows it checks that the name and account it lists identify one stored entry before `delete`, and on macOS it names the keychain it listed the entry in (T3-F002, T3-F003).
  - Task 14 checks that `fallbackDir` from `state/layout.json` lies under `~/.straw-boss-desk/` and matches the root's `<id>` before it deletes it (T3-F006).
  - The fixture scan catches literal commands only. Reviewers of tasks 5 to 14 check that no test calls the platform layer's writing methods outside the harness (T3-F005).
  - On macOS a lowercase `no_proxy` the PM set is kept beside the resolved `NO_PROXY`. Task 6 records whether npm, Git, and Claude read both (T3-F007).
- **Task 4: the state files.** `state/bootstrap.json` holds, per stage, `status` (`running`, `ok`, `failed`), `version`, `evidence`, `at`, `hashes`, `dependsOn`, and `lastFailure` when a later attempt failed. `state/current.json` holds `versions` (the active version per tool) and `previous` (the rollback target). Both are written by rename. A file that does not parse is moved to `<name>.corrupt-<time>` and logged as `state-quarantined`, and the engine starts from what is on disk, since every stage re-verifies its own files.
- **Task 4: installed-file hashes (R-F009).** A stage's `verify` names the files to hash in `Evidence.files` (paths relative to the data root with `/` separators). The engine hashes them after `activate` and stores them in the stage's record; `detectFromRecord` compares them, the pinned version, `current.json`, and the `dependsOn` versions, and logs why it failed (`detect-failed`). Every binary stage is `archiveStage` (`bootstrap/archive-stage.ts`): download, extract or copy into `<version>.staging`, check, then rename. Tasks 5 and 6 build their stages from it or from the same `Stage` contract.
- **Task 4: a failed attempt keeps the old record.** When a stage that finished before fails on a new version, its record keeps the old version, hashes, and evidence and gains `lastFailure`; `current.json` is untouched. A first install records `failed`. A killed run leaves the record `running`, which fails `detect`.
- **Task 4: rollback.** `StateStore.rollbackTool` points `current.json` back at `previous`. The stack of the previous generation is then run: the stage reinstalls that version from `tools/downloads`, which is offline, and every stage whose evidence names the tool runs again. `pruneInactive` deletes the folders that are not active; task 8 calls it after the next successful start.
- **Task 4: one engine per root.** `state/engine.lock` holds the pid and start token (from the platform's `Processes`); a lock whose owner is gone or whose pid now has another start token is taken over. An engine run begins by deleting `*.staging` and `*.replaced` folders under `tools/` and `*.part` files in `tools/downloads`, under that lock.
- **Task 4: failure handling.** Network, registry, and locked failures are tried once more after `retryDelayMs` (5 s); integrity, disk, and other never. A 5xx, 408, or 429 answer is a network failure; any other HTTP status on a pinned URL (404) is `other`, since the pin is wrong, not the network. Dependent stages of a failed stage are `blocked`; independent ones still run. Failure details and evidence kept in state or sent to the UI pass through the redactor.
- **Task 4: the redactor.** Main passes `recipe/secret-patterns.json` (parsed) in the `run` message, and `secret` messages register and drop exact values at any time (held until `run` if they come first). A registered value must be at least 4 characters, and its percent-encoded form is registered too. The GUI token is the first path segment of 16 or more URL-safe characters on `127.0.0.1`, `localhost`, or `[::1]` that ends the URL; a file name with a dot after it is not a token. Strings are redacted before JSON serialization. The patterns file must ship with the app (task 9 adds it to `electron-builder.json`'s files); the engine refuses to run without patterns.
- **Task 4: extraction.** `extract.ts` lists the names with `tar -tf` and refuses `..`, absolute, and drive-letter names before writing; after extracting it walks the tree and refuses a link with an absolute target or one that resolves outside, and removes everything. It relies on bsdtar's own secure extraction (no `-P`) for hard-link targets; a test checks that no outside file gains a link. PortableGit's `.7z.exe` self-extractor is not in `extract.ts`; task 5's `git` stage runs it.
- **Task 4: the engine entry.** `bootstrap/engine.ts` exports `createEngine` (testable in Node) and starts itself only when `process.parentPort` exists. Messages: `run`, `secret`, `cancel` in; `ready`, `stage-start`, `stage`, `done`, `error` out. Its default stage list, `bootstrap/stages/index.ts`, is empty until task 5.
- **Task 4: `tar.exe` cannot take non-ANSI characters in its arguments (found on `windows-2025`, code page 1252).** Given `-xf C:\...\root 測試\...zip` it answered "Failed to open ... root ??\...": the program reads its command line in the ANSI code page, so a user name or root with CJK characters outside the machine's code page fails, which a zh-TW PM can hit with a character outside Big5. The engine therefore runs `tar` with the archive's folder (listing) or the destination (extraction) as its working directory, which Windows passes as UTF-16, and gives it only names the app chose: the archive's file name and the relative path between two folders of the data root (`..\..\downloads\<file>`). `RunOptions` gained `cwd` for this. Later stages that call a Windows program with a path in its arguments (Git's self-extractor, `npm`) check the same.
