# Phase 0 spike, macOS

Reproduces the run in `docs/spikes/mac.md`: private Node, herdr, pi, pi-straw-boss and pi-intercom under a throwaway HOME (`/tmp/sbd-spike`, override with `SPIKE=`), a headless `herdr server`, a pi tower that serves the straw-boss GUI, and an Electron window that loads it and captures a PNG.

Everything runs through `run.sh`, which drops the caller's environment so a spike started from inside a herdr pane cannot join that herdr. Long-lived steps (`02`, `05`, `06`) are meant to run under `MonitorCreate`, one monitor each; stop only the monitors you started.

```sh
spike/mac/01-install.sh                      # Node, herdr, pi, packages, config, stub model (~20-80 s)
spike/mac/04-electron-build.sh               # Electron + TypeScript, compile the window app (~15-45 s)
spike/mac/98-reset.sh                        # clear runtime state for a fresh run (optional)
spike/mac/06-stub-llm.sh                     # monitor 1: local stand-in model on 127.0.0.1:18999
spike/mac/02-herdr-server.sh                 # monitor 2: headless herdr server
TOWER_OPEN=arg spike/mac/03-tower.sh         # base + tower pane; `/boss gui` is pi's first message
SBD_SHOT=$PWD/docs/spikes/mac-gui.png SBD_SHOT_DELAY_MS=4000 \
  SBD_SCRIPT=$PWD/spike/mac/electron/scripts/new-base-create.js \
  spike/mac/05-electron-run.sh               # monitor 3: window, "+ New base" from the GUI, capture
```

`electron/scripts/terminal-tile.js` opens the terminal tile of the member instead. Without `SBD_SCRIPT` and `SBD_SHOT` the window stays open on the GUI.
