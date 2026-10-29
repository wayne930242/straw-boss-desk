# Phase 0 spike, macOS

Reproduces the run in `docs/spikes/mac.md` on pi-straw-boss 0.46.0 (the desk B7 plan, `docs/specs/2026-10-28-desk-b7.md`, tasks 5 and 8: the start order after the B6 + B7 release): private Node, herdr, pi, pi-straw-boss and pi-intercom under a throwaway HOME (`/tmp/sbd-spike`, override with `SPIKE=`), a headless `herdr server`, the sb server and its GUI brought up by `cli.mjs up --dir`, and an Electron window that loads the GUI and follows it through a restart.

Everything runs through `run.sh`, which drops the caller's environment so a spike started from inside a herdr pane cannot join that herdr. Long-lived steps (`02`, `05`, `06`) are meant to run under `MonitorCreate`, one monitor each; stop only the monitors you started.
The environment (`env.sh`) sets `STRAW_BOSS_DESK=1` and puts herdr's socket at its default for the spike's own `XDG_CONFIG_HOME` (`$SPIKE/home/.config/herdr/herdr.sock`), so the sb server is the **primary** server of this environment: its files are in `$SPIKE/home/.pi/agent/straw-boss/` and it holds Straw Link. `_isolated.sh` refuses any socket outside `$SPIKE`, or one that is not that default, or longer than 100 bytes. Nothing under `~/.config/herdr` or `~/.pi` is read or written.

```sh
spike/mac/01-install.sh                      # Node, herdr, pi, packages (pi-straw-boss 0.46.0, pi-intercom 0.18.1), config, stub model (~20-80 s)
spike/mac/04-electron-build.sh               # Electron + TypeScript, compile the window app with the shared follow.ts (~15-45 s)
spike/mac/98-reset.sh                        # clear runtime state for a fresh run (optional; refuses while a recorded process runs)
spike/mac/06-stub-llm.sh                     # monitor 1: local stand-in model on 127.0.0.1:18999 (only if a pi session should complete a turn)
spike/mac/02-herdr-server.sh                 # monitor 2: headless herdr server
spike/mac/03-up.sh                           # cli.mjs up --dir "$HOME/Straw Boss" --label "Straw Boss" --exact: Herdr's pi integration, the sb server, the home base and its tower, the GUI; prints GUI_URL= and SB_DIR=, records the sb server pid and start time and the base (run/base.json)
spike/mac/08-check.sh                        # M1: GUI 200, status live/primary/desk, no `open` call recorded, one server.json; M4: one base with one tower tab, the integration installed
spike/mac/09-pane-env.sh                     # a pane sees the server's STRAW_BOSS_DESK, XDG_CONFIG_HOME, HERDR_SOCKET_PATH, PI_CODING_AGENT_DIR
spike/mac/07-follow-check.sh                 # M2 without a screen: the shared follower follows restart, kill -9 and stop + Start (no window)
SBD_SHOT=$PWD/docs/spikes/mac-gui.png SBD_SHOT_DELAY_MS=4000 \
  SBD_SCRIPT=$PWD/spike/mac/electron/scripts/new-base-create.js \
  spike/mac/05-electron-run.sh               # monitor 3: window ("+ New base" from the GUI, capture); runs `up` itself
spike/mac/99-stop.sh                         # stop order: cli.mjs stop, wait for the sb server, herdr server stop, leftovers by recorded pid and start time
```

`03-up.sh` exit codes: 0 done; 2 pi-straw-boss not installed; 4 the spike's herdr is not running; 10 + N `up` failed with exit N (11 a step failed, 12 usage, 13 the server cannot run); 21 `up` answered without a usable URL; 22 the sb server is not in the primary slot; 23 step `base` busy (another `up --dir` holds `desk.lock`); 24 step `base` failed (the folder, or Herdr said no); 25 step `integration` failed; 26 `up` answered without a base; 27 step `tower` failed.
The home base folder is `$HOME/Straw Boss` (`$SPIKE/home/Straw Boss`; visible and under home, as the desk-mode spec asks); `03-up.sh` makes it when missing, since `up --dir` only checks it. `01-install.sh` no longer runs `herdr integration install pi`: `up --dir` does.
The URL carries the page token: `03-up.sh` prints it once and keeps it on disk only while it runs.

`99-stop.sh` follows the plan's **Stop order**: `cli.mjs stop` first (45 s), so a pi session's look cannot start a new server while herdr shuts down; then the sb server pid is waited for (10 s) and killed only while its recorded start time matches; then `herdr server stop`; then what is left of the recorded tree and the pi-intercom broker of this agent dir. Workspaces are not closed, and `gui.json` and `server.json` stay. It prints `stopped`, or `STILL RUNNING:` with exit 1.

Without `SBD_SCRIPT` and `SBD_SHOT` the Electron window stays open on the GUI and follows it: `cli.mjs restart`, a `kill` of the server, or a stop each end with the window on the live URL or on a plain page that says what was stopped. The follower is `spike/win/proto/src/follow.ts`, the file the Windows prototype uses; `04-electron-build.sh` copies it in.
`electron/scripts/terminal-tile.js` opens the terminal tile of the member instead.

The tower: `up --dir` makes the home base and its tower tab (the server marks the base's pane and types the tower prompt into it); a second run finds them (`created: false`), and so does a start after `99-stop.sh`, because workspaces are not closed and Herdr restores them. The Windows kit's real sessions are the plan's A6.
