// Headless stand-in for the Electron window (M2 without a screen): the shared Follower (spike/win/proto/src/follow.ts, run by Node's type stripping) follows the
// spike's REAL sb server through the three rotations of the desk B7 plan, and this script reports what the window would have done. It never prints a URL's token.
//   1. `cli.mjs restart`   -> moved: the old URL answers 403, the new one 200, the follower loads it, and runs no `up` of its own
//   2. kill -9 the server  -> a pi session's look (the tower) restarts it within about 6 s and the follower follows (moved), else the follower's gone rule runs `up`
//   3. `cli.mjs stop`      -> the server-stopped screen; the Start button (startFromScreen) runs `up` and loads the new URL
// Needs the spike's herdr and sb server running (02-herdr-server.sh under MonitorCreate, then 03-up.sh); run it through 07-follow-check.sh.
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const { Follower, parseGuiUrl, probe } = await import(new URL("../win/proto/src/follow.ts", import.meta.url).href);
const agentDir = process.env.PI_CODING_AGENT_DIR;
const spike = process.env.SPIKE;
if (!agentDir || !spike || !agentDir.startsWith(`${spike}/`)) throw new Error("not the spike's environment: run through 07-follow-check.sh");
const cli = join(agentDir, "npm", "node_modules", "pi-straw-boss", "dist", "server", "cli.mjs");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hide = (t) => String(t).replace(/(127\.0\.0\.1:\d+\/)[0-9a-f]{16,}/gi, "$1<token>");

function up() {
	return new Promise((resolve) => {
		const child = spawn("node", [cli, "up", "--timeout", "30", "--exact"], { stdio: ["ignore", "pipe", "pipe"] });
		let out = "", err = "";
		child.stdout.on("data", (c) => (out += c));
		child.stderr.on("data", (c) => (err += c));
		child.on("close", (code) => {
			const json = (t) => t.split(/\r?\n/).filter((l) => l.trim().startsWith("{")).pop();
			try {
				if (code === 0) { const j = JSON.parse(json(out)); return resolve({ ok: true, url: j.url, dir: dirname(j.log), pid: j.pid }); }
				resolve({ ok: false, code, text: hide(`up exit ${code}: ${(json(err) ?? err).slice(-300)}`) });
			} catch (e) { resolve({ ok: false, code, text: hide(`up exit ${code}: ${String(e)}`) }); }
		});
	});
}
const cliSync = (args) => spawnSync("node", [cli, ...args], { encoding: "utf8" });

const loads = [], screens = [], notes = [], logs = [];
let upCalls = 0;
const host = {
	log: (event, data = {}) => logs.push([Date.now(), event, hide(data.detail ?? "")]),
	load: async (url) => { loads.push({ at: Date.now(), url }); },
	screen: (s) => screens.push({ at: Date.now(), kind: s.kind }),
	banner: (t) => { if (t) notes.push(t); },
	runUp: async () => { upCalls++; const r = await up(); return r.ok ? { ok: true, url: r.url } : r; },
};

const results = [];
const check = (name, ok, detail) => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"} ${name} - ${detail}`); };
const until = async (cond, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (await cond()) return true; await sleep(100); } return false; };
const portOf = (u) => parseGuiUrl(u)?.port;

const first = await up();
if (!first.ok) { console.log(`FAIL setup - ${first.text}`); process.exit(1); }
if (!first.dir.startsWith(`${spike}/`)) { console.log("FAIL setup - the sb server's folder is not under the spike"); process.exit(1); }
const f = new Follower(first.dir, host, first.url);
f.start();
await sleep(1500);
check("M2.0 steady", loads.length === 0 && upCalls === 0, `loads=${loads.length} up=${upCalls}; the window stays on port ${portOf(first.url)}`);

// 1. restart
const t1 = Date.now();
const r = cliSync(["restart", "--reason", "m2 follow check"]);
check("M2.1a restart", r.status === 0, `cli restart exit ${r.status}`);
const moved1 = await until(() => loads.length >= 1, 30_000);
const url1 = loads[0]?.url;
check("M2.1b follower loaded the new URL", moved1 && url1 !== first.url, `after ${loads[0] ? loads[0].at - t1 : "-"} ms, port ${portOf(first.url)} -> ${url1 ? portOf(url1) : "-"}`);
if (url1) {
	check("M2.1c old URL 403, new URL 200", (await probe(first.url)) === 403 && (await probe(url1)) === 200, `old ${await probe(first.url)}, new ${await probe(url1)}`);
}
check("M2.1d no up run by the follower on a plain restart", upCalls === 0, `up=${upCalls}`);

// 2. kill the server
let rec;
try { rec = JSON.parse(readFileSync(join(first.dir, "server.json"), "utf8")); } catch (e) { console.log(`FAIL M2.2 - cannot read server.json: ${String(e)}`); process.exit(1); }
const before = loads.length, upBefore = upCalls, t2 = Date.now();
const lstart = spawnSync("ps", ["-o", "lstart=", "-p", String(rec.pid)], { encoding: "utf8", env: { ...process.env, TZ: "UTC", LC_ALL: "C" } }).stdout.trim();
check("M2.2.pre the server still holds the recorded start time", lstart !== "" && lstart === rec.started, `pid ${rec.pid}`);
if (lstart !== "" && lstart === rec.started) process.kill(rec.pid, "SIGKILL");
const moved2 = await until(() => loads.length > before, 60_000);
const url2 = loads[loads.length - 1]?.url;
check("M2.2a follower followed the killed server", moved2 && url2 !== url1 && (await probe(url2)) === 200, `after ${moved2 ? loads[loads.length - 1].at - t2 : "-"} ms; follower ran up ${upCalls - upBefore}x (0 = a pi session restarted it; 1 = the gone rule did)`);

// 3. stop on purpose, then the Start button
const before3 = loads.length, nScreens = screens.length;
const s = cliSync(["stop"]);
check("M2.3a stop", s.status === 0, `cli stop exit ${s.status}`);
check("M2.3b server-stopped screen", await until(() => screens.length > nScreens && screens[screens.length - 1].kind === "server-stopped", 15_000), `screens: ${screens.map((x) => x.kind).join(",")}`);
await f.startFromScreen();
const moved3 = await until(() => loads.length > before3, 30_000);
check("M2.3c Start button brought the GUI back", moved3 && (await probe(loads[loads.length - 1].url)) === 200, `loads=${loads.length}`);

f.stop();
console.log(`log events: ${logs.map((l) => l[1]).join(" ")}`);
const failed = results.filter((x) => !x).length;
console.log(failed ? `FAILED ${failed}` : "M2 headless OK");
process.exit(failed ? 1 : 0);
