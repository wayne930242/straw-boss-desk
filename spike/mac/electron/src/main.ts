// Spike main process: runs `cli.mjs up --exact` for the spike's sb server, loads the GUI URL it prints, optionally captures the page, then quits.
// Without a capture or a script the window stays open and a Follower (follow.ts, the file the Windows prototype uses) keeps it on the live URL through a
// restart, an upgrade or a crash, and shows a plain page when the stack or its GUI was stopped. The URL comes from `up`; no file is read at the start.
import { app, BrowserWindow } from "electron";
import { spawn } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Follower, type FollowHost, type Screen, type UpResult } from "./follow.js";

const agentDir = process.env.PI_CODING_AGENT_DIR;
const shot = process.env.SBD_SHOT;
const shotDelayMs = Number(process.env.SBD_SHOT_DELAY_MS ?? 8000);
const script = process.env.SBD_SCRIPT; // optional file with JS evaluated in the page before the capture
if (!agentDir) throw new Error("PI_CODING_AGENT_DIR is not set");
app.setPath("userData", process.env.SBD_USER_DATA ?? join(agentDir, "..", "electron-user-data"));

const hide = (text: string) => text.replace(/(127\.0\.0\.1:\d+\/)[0-9a-f]{16,}/gi, "$1<token>");
const log = (...a: unknown[]) => {
	const line = hide([new Date().toISOString(), "[electron]", ...a.map((x) => (typeof x === "string" ? x : JSON.stringify(x)))].join(" "));
	console.log(line);
	if (process.env.SBD_LOG) appendFileSync(process.env.SBD_LOG, `${line}\n`);
};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const sbCli = join(agentDir, "npm", "node_modules", "pi-straw-boss", "dist", "server", "cli.mjs");
type Up = { ok: true; url: string; dir: string } | { ok: false; code: number | null; text: string };

/** `cli.mjs up --exact` in this process's environment (the spike's: STRAW_BOSS_DESK=1, the primary slot); one JSON line on stdout when it works, on stderr when not. */
function up(): Promise<Up> {
	return new Promise((resolve) => {
		const child = spawn("node", [sbCli, "up", "--timeout", "30", "--exact"], { stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		let err = "";
		child.stdout.on("data", (c: Buffer) => { out += c.toString("utf8"); });
		child.stderr.on("data", (c: Buffer) => { err += c.toString("utf8"); });
		child.on("error", (e) => resolve({ ok: false, code: null, text: String(e) }));
		child.on("close", (code) => {
			const json = (text: string) => text.split(/\r?\n/).filter((l) => l.trim().startsWith("{")).pop();
			try {
				if (code === 0) {
					const j = JSON.parse(json(out) ?? "") as { url?: string; log?: string };
					if (j.url && j.log) return resolve({ ok: true, url: j.url, dir: dirname(j.log) });
					return resolve({ ok: false, code, text: "up answered without a URL" });
				}
				const e = JSON.parse(json(err) ?? "{}") as { step?: string; wait?: string; reason?: string };
				resolve({ ok: false, code, text: hide(`up exit ${code}: ${e.step ?? "?"}${e.wait ? `/${e.wait}` : ""} ${e.reason ?? err.slice(-300)}`) });
			} catch {
				resolve({ ok: false, code, text: hide(`up exit ${code}: ${(err || out).slice(-300)}`) });
			}
		});
	});
}

let win: BrowserWindow | undefined;

const host: FollowHost = {
	log: (event, data = {}) => log("follow", event, data),
	load: async (url) => { await win?.loadURL(url); log("loaded", "followed to the new URL"); },
	// A plain page: the spike app has no Start button; `03-up.sh` (or `cli.mjs up`) brings the stack back and the follower sees the new record.
	screen: (s: Screen) => {
		const text = s.kind === "failed" ? `The stack could not be started: ${s.text}` : s.kind === "server-stopped" ? "The sb server was stopped on purpose. Run 03-up.sh to start it." : "The GUI was stopped on purpose. Run 03-up.sh to start it.";
		const html = `<body style="font:15px sans-serif;margin:24px"><h2>Straw Boss Desk (spike)</h2><p>${text.replace(/[&<>]/g, " ")}</p></body>`;
		void win?.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
		log("screen", s.kind);
	},
	banner: (text) => win?.setTitle(text ? `Straw Boss Desk - ${text}` : "Straw Boss Desk"),
	runUp: async (): Promise<UpResult> => {
		const r = await up();
		return r.ok ? { ok: true, url: r.url } : r;
	},
};

const main = async () => {
	await app.whenReady();
	win = new BrowserWindow({ width: 1280, height: 860, show: true, useContentSize: true, webPreferences: { sandbox: true, contextIsolation: true } });
	const wc = win.webContents;
	wc.on("console-message", (e) => log("console", e.level, e.message));
	wc.on("did-fail-load", (_e, code, desc, url) => log("did-fail-load", code, desc, url));
	wc.on("render-process-gone", (_e, d) => log("render-process-gone", d.reason));
	const t0 = Date.now();
	const started = await up();
	if (!started.ok) throw new Error(started.text);
	log("up", `${Date.now() - t0}ms`);
	const t1 = Date.now();
	await win.loadURL(started.url);
	log("loaded", `${Date.now() - t1}ms`, "title:", JSON.stringify(wc.getTitle()));
	if (script) {
		await sleep(2000);
		log("script result:", await wc.executeJavaScript(readFileSync(script, "utf8"), true));
	}
	if (!shot) {
		if (script) return app.quit(); // a scripted run without a capture ends here
		new Follower(started.dir, host, started.url).start(); // a plain run is the app
		return;
	}
	await sleep(shotDelayMs);
	const img = await wc.capturePage();
	writeFileSync(shot, img.toPNG());
	const { width, height } = img.getSize();
	log("captured", shot, `${width}x${height}`, `${img.toPNG().length} bytes`);
	app.quit();
};

// Fail fast: any error in the run is logged and ends the process with a non-zero code, so a monitor sees it.
main().catch((error: unknown) => {
	log("failed:", String(error));
	app.exit(1);
});

app.on("window-all-closed", () => app.quit());
