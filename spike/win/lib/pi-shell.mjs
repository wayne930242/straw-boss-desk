// Which shell pi would use for its bash tool on this machine, resolved by pi's own exported getShellConfig.
// pi passes settings.json `shellPath` to it (bootstrap's pi-shell stage sets that), so this does too; without it pi 1.4.0 looks only in
// Program Files and on PATH. `where bash.exe` is reported as well: it is the PATH fallback, and C:\Windows\System32\bash.exe (WSL) must not win it.
// usage: node pi-shell.mjs <path to @earendil-works/pi-coding-agent package dir>
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const pkg = process.argv[2];
const mod = await import(pathToFileURL(join(pkg, "dist", "index.js")).href);
let shellPath;
try { shellPath = JSON.parse(readFileSync(join(process.env.PI_CODING_AGENT_DIR || "", "settings.json"), "utf8")).shellPath; } catch { }
const where = spawnSync("where", ["bash.exe"], { encoding: "utf8", timeout: 10000 });
const cfg = mod.getShellConfig(shellPath);
// Run something through that shell the way the bash tool does, with the profile path in play.
const probe = spawnSync(cfg.shell, [...cfg.args, 'echo "pwd=$(pwd)"; echo "home=$HOME"; ls "$USERPROFILE" >/dev/null 2>&1 && echo profile-listable || echo profile-not-listable; command -v git; command -v node; command -v python3 || echo no-python3'], { encoding: "utf8", timeout: 30000 });
console.log(JSON.stringify({ settingsShellPath: shellPath || null, whereBash: (where.stdout || where.stderr || "").trim().split(/\r?\n/).slice(0, 4), shell: cfg.shell, args: cfg.args, probeStatus: probe.status, probeOut: probe.stdout, probeErr: probe.stderr }));
