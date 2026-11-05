# Straw Boss Desk

An Electron desktop app for macOS and Windows. On a bare machine it builds a pi coding stack (Node, Git, Herdr, pi and its packages, the code-host CLIs) in its own data folder, signs the PM in to Claude and their code hosts, and then opens the pi-straw-boss GUI as its main window.

The design record is [`docs/specs/2026-10-25-design.md`](docs/specs/2026-10-25-design.md); phase 2 (the shell) is [`docs/specs/2026-11-01-phase2-shell.md`](docs/specs/2026-11-01-phase2-shell.md). Read them before changing behavior. The rules for working in this repository are in [`AGENTS.md`](AGENTS.md).

**For PMs:** the guide is [`docs/pm-guide.zh-TW.md`](docs/pm-guide.zh-TW.md) (Traditional Chinese): installing past SmartScreen and Gatekeeper, Smart App Control, WSL, what an existing sign-in means, Diagnostics and Repair, and removing the app.

## Where things go

| | Windows | macOS |
| --- | --- | --- |
| Program | `%LOCALAPPDATA%\Programs\Straw Boss Desk` (per-user NSIS, no administrator prompt) | `/Applications`, or `~/Applications` when `/Applications` is not writable |
| Data root (`<root>`) | `%LOCALAPPDATA%\straw-boss-desk` | `~/Library/Application Support/straw-boss-desk` |
| Tools | `<root>\tools` | `<root>/tools` |
| Chromium profile | `<root>\electron` | `<root>/electron` |
| User PATH | one entry, `<root>\tools\shims` | none |

Everything the app installs is under `<root>`. It never writes to the user's global Node, Git, pi, or Herdr setup and never asks for administrator rights. The one exception is the Windows user PATH entry above, which `pi.cmd`, `pi`, and `bash.cmd` need so that agents started in a pane find the app's own tools; each passes the call straight through to the user's own program outside the app's panes.

A development build (`SBD_BUILD=dev`, the default for `npm run pack`) is a different product, `Straw Boss Desk Dev`, with its own id, update channel, Keychain item names, and a data root you choose with `STRAW_BOSS_DESK_ROOT` or `--root=`.

## Uninstalling and removing data

- **Uninstall** (the Windows uninstaller, or dragging the app to the Trash) removes the program only. On Windows the uninstaller first runs the installed app with `--stop-stack`, so the stack is not left running from files that are about to go (an update runs it too, and finds nothing to stop), and then, except during an update, with `--remove-user-path`, which removes the PATH entry. `<root>` stays, and so do the gh and glab sign-ins the app made in the OS credential store, so a reinstall resumes.
- **Remove all data** (Settings, Computer) is the full removal. It stops the stack, signs out of Claude and the code hosts, deletes the Linear key, removes the PATH entry (Windows), deletes this build's `<product> Safe Storage` and the app's `Claude Code-credentials-<8 hex>` Keychain items (macOS), and deletes `<root>` and any fallback folder. After the app exits, a detached cleanup deletes what Chromium held open; a `<root>/remove-pending` marker makes the next launch finish the job before any window opens. The work folder and its clones are never touched.
- **Credential entries it does not own stay.** The app owns a store entry only while it is exactly as the app left it (name in `state/accounts.json`, modification time unchanged). An entry another program made, or one the app made and something else then wrote over, is left alone and is named on the confirmation screen and in the result. The PM guide shows how to delete such an entry by hand.
- **Kill rule.** The app stops only processes it holds a handle to, or whose recorded start time matches; leftovers are listed by the path of their executable, never by command line, and there is no tree kill. If a program of the app is still running, **Remove all data** says so, removes nothing, and starts the stack again.

PMs are told to use **Remove all data** before uninstalling.

## Develop

```sh
cd app
npm ci
npm run typecheck
npm test                   # unit tests, the UI rules, the guarded-fixture scan
npm run pack -- --dir      # an unpacked development build in app/out/dev
```

- Runtime e2e (real windows, a real stack, the real credential store, the user PATH) runs on the hosted CI runners only. `SBD_E2E=1` plus the six-signal hosted-runner check gate every such file; do not run them on a development machine.
- Anything you start locally for development uses its own Herdr socket, its own `PI_CODING_AGENT_DIR`, and its own data root (see `AGENTS.md`).
- pi packages come from npm at the versions in `stack.json`; the team profile is [`profile/`](profile/) (see [`docs/releasing-profile.md`](docs/releasing-profile.md)).

## CI

| Workflow | What it proves |
| --- | --- |
| `ci` | build, type check, unit tests, tool and profile stages against the real releases, the packaged app, the page galleries (every state of the projects step, the recipe card, **Remove all data** and Diagnostics, in both languages) |
| `wizard-from-zero` | the packaged development build from an empty data root to the GUI, both platforms |
| `updates` | the stack and app updaters, the Windows install and update 0.0.1 to 0.0.2, the PATH entry across the update, the silent uninstall, Diagnostics and Repair, and **Remove all data** against a real store and a real folder |
| `stack-check` | on a change to `stack.json`: the SHA256 of every pinned asset on every platform and the registry integrity of every pinned package |

Screenshots of every state are uploaded as artifacts by the jobs that take them.
