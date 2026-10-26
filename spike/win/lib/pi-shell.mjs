// Which shell pi would use for its bash tool on this machine, resolved by pi's own exported getShellConfig.
// usage: node pi-shell.mjs <path to @earendil-works/pi-coding-agent package dir>
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const pkg = process.argv[2];
const mod = await import(pathToFileURL(join(pkg, "dist", "index.js")).href);
const cfg = mod.getShellConfig();
// Run something through that shell the way the bash tool does, with the profile path in play.
const probe = spawnSync(cfg.shell, [...cfg.args, 'echo "pwd=$(pwd)"; echo "home=$HOME"; ls "$USERPROFILE" >/dev/null 2>&1 && echo profile-listable || echo profile-not-listable; command -v git; command -v node; command -v python3 || echo no-python3'], { encoding: "utf8", timeout: 30000 });
console.log(JSON.stringify({ shell: cfg.shell, args: cfg.args, probeStatus: probe.status, probeOut: probe.stdout, probeErr: probe.stderr }));
