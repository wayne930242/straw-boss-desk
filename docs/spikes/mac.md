# Phase 0 spike: macOS

Run on 2026-10-25, macOS (Darwin 27, arm64), while the author's own herdr and pi sessions were live. The anchor is met: `docs/spikes/mac-gui.png` is a `webContents.capturePage` PNG of the straw-boss GUI served by the spike's own tower pi, under the spike's own herdr server. It shows two bases: `spike-base` (the tower) and `demo-base`, which the GUI's "+ New base" created with a member pi. `docs/spikes/mac-terminal.png` shows the terminal tile rendering that member's pi.

Reproduce with `spike/mac/` (see its README).

## Versions

| Part | Version | Source |
| --- | --- | --- |
| Node | 24.22.1 (LTS "Krypton") | `nodejs.org/dist/v24.22.1/node-v24.22.1-darwin-arm64.tar.gz`, SHA256 `89c68259…fbc0a7` from `SHASUMS256.txt` |
| herdr | 0.9.5 | `github.com/herdrdev/herdr/releases/download/v0.9.5/herdr-macos-aarch64`, SHA256 `fb77c223…c7a7e2` from `herdr.dev/latest.json` |
| pi | `@earendil-works/pi-coding-agent` 1.4.0 (npm latest, needs Node >= 22.19) | `npm install -g` into a private prefix with the private Node |
| pi-straw-boss | 0.42.7 (npm latest, same as the author runs) | `pi install npm:pi-straw-boss@0.42.7` |
| pi-intercom | 0.17.1 (what the author runs; npm latest is 0.18.1) | `pi install npm:pi-intercom@0.17.1` |
| Electron | 45.0.0 (npm latest) | npm, private prefix |
| TypeScript | 7.0.2 | npm |

The herdr SHA256 comes from the same `latest.json` the herdr updater reads, over TLS; the release page API was rate limited, so the checksum is not cross-checked against a second source.

## Isolation

`spike/mac/run.sh` starts every command under `env -i` with only `SPIKE`, `TERM`, `USER`, `LOGNAME`, `SHELL`, and a system `PATH`. `env.sh` then sets `HOME=/tmp/sbd-spike/home`, `PI_CODING_AGENT_DIR`, `XDG_CONFIG_HOME`, `HERDR_CONFIG_PATH`, `HERDR_SOCKET_PATH=/tmp/sbd-spike/run/herdr.sock`, `HERDR_BIN_PATH`, and npm prefix and cache, all inside `/tmp/sbd-spike`. `_isolated.sh` refuses any herdr call whose socket is outside the spike.

Checks:

- The spike's `gui.json` is at `/tmp/sbd-spike/home/.pi/agent/straw-boss/gui.json` with `"herdr":"/tmp/sbd-spike/run/herdr.sock"`. The author's `~/.pi/agent/straw-boss/gui.json` has the same md5 (`20e30ed0…`) before and after.
- The spike's pi-intercom broker lives under the spike agent dir (`intercom/broker.sock`); `pi-intercom list` there shows only the spike's sessions.
- No herdr command ran against the default socket.

One isolation slip, caught and fixed: my first herdr start ran with the caller's environment. A herdr server started from the author's herdr pane inherits `SSH_AUTH_SOCK`, which the author's herdr points at `~/.config/herdr/herdr.sock.agent`, and herdr created `herdr.sock.agent` next to the spike socket pointing at that path. Nothing was written to the author's files, but it showed that a plain `HOME` override is not enough. I stopped that server, reset the spike state, and added the `env -i` wrapper. The desk app must start herdr, pi, and Electron with a constructed environment, not an inherited one.

## Steps and timings

| Step | Script | Time |
| --- | --- | --- |
| Node tarball, SHA256 check, unpack | `01-install.sh` | 2 s (5 s on the cold run) |
| herdr binary, SHA256 check | `01-install.sh` | 1–2 s |
| `npm install -g pi-coding-agent` | `01-install.sh` | 7 s (27 s cold, slower network) |
| `pi install` straw-boss + intercom | `01-install.sh` | 6 s (44 s cold) |
| Electron + TypeScript + binary | `04-electron-build.sh` | 15 s warm, 45 s cold |
| `herdr server` ready | `02-herdr-server.sh` | under 2 s |
| tower pi ready in its pane | `03-tower.sh` | 3–4 s |
| `gui.json` after tower start (`TOWER_OPEN=arg`) | `03-tower.sh` | 8–11 s total |
| Electron `loadURL` | `05-electron-run.sh` | 150–750 ms |
| "+ New base" to member joined the net | GUI | about 5 s after the click |

The whole install from nothing took about 80 s (cold npm cache) plus 45 s for Electron.

Sizes on disk: Node 199 MB, herdr 22 MB, pi global prefix 149 MB, pi agent dir 21 MB (14 MB packages, 6.7 MB `fd` and `rg` that pi downloads on first start), npm cache 134 MB, Electron app 302 MB (259 MB of it the Electron binary), Electron download cache under the fake HOME 182 MB, `/tmp/sbd-spike` total 1.0 GB. Of that, Node plus herdr plus pi plus packages is about 390 MB; the Electron runtime and its cache would belong to the app itself, not to `tools/`.

## What worked

- Private Node, herdr, pi, and both pi packages install with no admin rights and no write outside `/tmp/sbd-spike`.
- `herdr server` runs headless with a custom socket and its own config and session files. `herdr status`, `workspace create`, `tab create --env`, and `agent start --kind pi` all work against it.
- pi starts without any auth ("No models available" is a warning). The tower loads pi-straw-boss and serves the GUI; a model is not needed for any of what was tested. A local stub model (`stub-llm.mjs`, OpenAI chat-completions) lets a session complete a turn; it was used only to give the member a session file and was not required for the GUI.
- The GUI URL `http://127.0.0.1:<port>/<token>/` loads in Electron with the default security settings (sandbox on, context isolation on, no preload). Page CSP and CSRF work as designed.
- "+ New base" from the Electron page: folder picker (listed `Library/`, `projects/` under the fake HOME), base name, "Open the base here". It created herdr workspace `w2`, a member pi in it (`STRAW_BOSS_ROLE=member`, `pi --name "member · demo"`), and after about 5 s the GUI showed `demo-base` with the member, "member · demo joined" in the activity feed.
- The terminal tile renders: "Live · 120×40", the member's pi screen, and a row of key buttons (`mac-terminal.png`).
- The GUI works with only the tower alive: the first capture was taken with the tower and no member, and the final run closed `demo-base` first and the page still loaded.
- Takeover: closing the tower's tab while a member was alive made the member's pi host the GUI within 3 s on the same port and token ("This session now hosts the straw net GUI … the URL is unchanged"). So the GUI needs at least one live pi session, and the supervisor can lose the tower without losing the URL while a member lives.

## How the tower starts without typing

No env var, flag, or exported entry point exists for it. The thinnest working sequence, taken from `src/towertab.ts` and `src/herdr.ts` of pi-straw-boss and run only through the herdr CLI:

```sh
herdr workspace create --cwd <dir> --label <base> --no-focus
herdr tab create --workspace <ws> --label tower --cwd <dir> --no-focus --env STRAW_BOSS_ROLE=tower
herdr agent start tower-<ws> --kind pi --pane <pane> --timeout 60000 -- --name tower "/boss gui"
```

`/boss gui` as pi's first message works: the extension command runs once the session is up and `gui.json` appears 8–11 s after start (`TOWER_OPEN=arg`). Typing it afterwards with `herdr pane send-text` plus `send-keys enter` also works but is fragile: the first Enter only completes the slash-command menu, so a second Enter is needed (the first attempt took 35 s because of it). The first message is a prompt-level convention, not a contract; see the seams.

## What failed or surprised

1. **Members did not join the net without herdr's pi integration.** The first "+ New base" produced a member pi that was idle in herdr but the GUI showed "UNALIGNED, not in the net", and the SSE net had no `demo-base`. Cause: herdr panes had no `agent_session`, so pi-intercom could not resolve the session's workspace and tab (`herdr-location.ts` matches by the session file herdr reports), and pi-straw-boss leaves unplaced sessions out of the net. `herdr integration install pi` writes `$PI_CODING_AGENT_DIR/extensions/herdr-agent-state.ts`; after that the member joined. The author's machine has it installed, so nothing in pi-straw-boss mentions it.
2. **`/boss gui` opens a browser.** `src/gui.ts:216` runs `open <url>` on macOS. The spike put a recording `open` shim first on `PATH` (`$SPIKE/shims/open`) so the author's browser was not launched. In the app this would open a second window next to Electron.
3. **npm 11.19 blocks dependency install scripts by default** (`allowScripts`). `pi install` and `npm install -g pi-coding-agent` print warnings for `esbuild`, `fsevents`, `@google/genai`, and `protobufjs` and skip their scripts; everything still worked (esbuild's binary comes from its platform package). Passing `--allow-scripts` to a project install fails with `EALLOWSCRIPTS`. Electron 45 has no postinstall at all: `npm install electron` leaves no binary, and the first `require("electron")` would download it. `04-electron-build.sh` runs `node node_modules/electron/install.js` explicitly, which downloads 259 MB. It honored `HOME` for its cache, not `ELECTRON_CACHE`.
4. **TypeScript 7.0.2 removed `moduleResolution: node10`**; the app tsconfig uses `module: nodenext`.
5. **pi downloads `fd` and `ripgrep` on first start** (6.7 MB into `$PI_CODING_AGENT_DIR/bin`) and checks pi.dev for a newer version and reports install telemetry. `PI_TELEMETRY=0` and `PI_SKIP_VERSION_CHECK=1` are set in `env.sh`; whether `PI_OFFLINE` also stops the `fd` download was not tested.
6. **herdr phones home** (update and agent-manifest checks) unless `[update] version_check` and `manifest_check` are false, and plays sounds; `01-install.sh` writes a config that disables all three and sets `onboarding = false` and `shell_mode = "non_login"`. I did not verify that a login shell would change `PATH` in a pane; `non_login` was chosen to keep the spike's `PATH` in front.
7. The tower's own dashboard showed "GUI not running; /boss gui opens it" in one capture taken right after the GUI started, then updated. Cosmetic, seen once.
8. Electron prints `sandbox_extension_issue_file_to_process failed for …/electron` at start. It is harmless here (the app lives in `/tmp`); not investigated.
9. `capturePage` needs the window to be shown; the window was visible on the author's screen during each run. A hidden or offscreen window for the anchor was not tried.
10. Electron's `executeJavaScript` fails with "WebFrame was removed" if the script itself navigates; the spike script now schedules the navigation after returning.

## Assumed the author's machine

- pi-straw-boss assumes `herdr integration install pi` was run (failure 1).
- herdr's server links `herdr.sock.agent` to the caller's SSH agent; a pane-inherited environment points it at the author's.
- pi-straw-boss lists folders under `os.homedir()` only, skipping dot folders (`src/spawn.ts` `pickable`/`listDirs`); under the fake HOME the picker rooted there. A desk user's repos may live elsewhere.
- `open` for the browser, `ps` for the start-time check in `gui.json` (`started`): both exist on macOS; Windows needs the variants already named in the design.
- No other `/Users/weihung` path was found in what ran. The pi `settings.json` pins (git forks, local plugin paths) are the author's and were not copied.

## Upstream seams needed for desk mode

Per the author's note, the shell must not reimplement any of this; the hacks above are spike-only and each seam names the change that removes one.

| Package | File | Gap seen in this spike | Proposed change |
| --- | --- | --- | --- |
| pi-straw-boss | `src/session.ts`, `src/host.ts` | The tower opens the GUI only on a typed or first-message `/boss gui`. | A documented env (e.g. `STRAW_BOSS_DESK=1`, with `STRAW_BOSS_ROLE=tower`) that makes the tower start the GUI at `session_start`, so the shell does not send input. |
| pi-straw-boss | `src/gui.ts:216` (`openBrowser`) | `/boss gui` always runs `open`/`start`/`xdg-open`; `Deps.openUrl` exists but has no env or flag. | Same desk env disables browser launch. |
| pi-straw-boss | `src/state.ts:109` (`cfg.stateDir`) | State dir follows `PI_CODING_AGENT_DIR/straw-boss`; `stateDir` is only a constructor argument. | Honor an env such as `STRAW_BOSS_STATE_DIR` so the shell reads `gui.json` from a fixed path it owns. |
| pi-straw-boss | `src/towertab.ts`, `src/spawn.ts` | The first base and tower exist only as the herdr command sequence above, which depends on the internal `STRAW_BOSS_ROLE` env and `sb_role` tokens. | An exported, documented way to create a base with its tower for a folder (CLI subcommand or a published function), so the shell calls it instead of mirroring `towertab.ts`. |
| pi-straw-boss | `src/spawn.ts` (`pickable`, `listDirs`) | Folder picker is limited to the home folder tree and shows no dot folders. | Desk mode accepts a folder chosen by the shell (native dialog result) and configurable roots; the page asks the shell through a small callback instead of its own picker. |
| pi-straw-boss | `src/net.ts`, `src/membership.ts` | A session herdr cannot place (no pi integration) stays silently out of the net. | Detect missing `agent_session` and tell the user or run the integration; at minimum document the `herdr integration install pi` requirement. The shell's bootstrap should run it either way. |
| pi-straw-boss | `src/host.ts` (`adopt`) | The GUI needs some live pi session; a dead tower with no survivor leaves no GUI. Takeover by a member on the same URL worked (3 s). | Keep as is; the runtime supervisor must restart the tower when `gui.json` stops answering and no survivor adopts. A headless GUI process independent of a pi session would remove the dependency, but is a larger change. |
| pi | startup | Downloads `fd` and `rg` and contacts pi.dev on first start. | A pre-provision step or an env that guarantees no network on start (check whether `PI_OFFLINE` covers the `fd` download). |
| herdr | config | Needs a config to avoid update checks, manifest checks, sounds, and onboarding; the server symlinks the caller's SSH agent socket. | Ship the config from `01-install.sh` (already works); no upstream change required beyond keeping those keys stable. |
| Electron shell (this repo) | `main/runtime` | `ELECTRON_CACHE` is not used; Electron 45 has no postinstall. | Download Electron through the build, not at first run; package with electron-builder in phase 4. |

## Not done

- Windows, and the ARM64 emulation question, are other spikes.
- No model call, no Claude OAuth, no real work in the member pi.
- Remote access (Tailscale) and stash were not touched.
- Whether a hidden Electron window can still capture the page.

## Cleanup

Processes started and confirmed gone by PID after `MonitorStop`: herdr server 75060 (and its panes: zsh 91421, 677, 1028; member pi 91490; tower pi 1813), pi-intercom broker 28297 and its esbuild child 28779, stub model 68261, last Electron 74195. Earlier runs' herdr servers (74085, 83005, 94731, 36992, 69957), stub model 36924, and Electron processes (2216, 26976, 88850) were stopped the same way and checked gone. No spike process, listening port (49656, 18999), or socket remains. The author's `gui.json` md5 is unchanged. `/tmp/sbd-spike` stays: 1.0 GB, of which 134 MB is the npm cache and 182 MB the Electron download under `home/Library/Caches`.
