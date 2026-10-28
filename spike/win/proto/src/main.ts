import { app, BrowserWindow, dialog, ipcMain, Menu, safeStorage, shell, WebContentsView } from "electron";
import { autoUpdater } from "electron-updater";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { release } from "node:os";
import { Follower, type FollowHost, type Screen, type UpResult } from "./follow.js";

// Spike prototype. It runs the kit's start.ps1 (which owns every straw-boss detail), shows a minimal status page while it runs,
// then loads the GUI URL start.ps1 prints as soon as it prints it (the tower step of start.ps1 goes on in the background).
// A Follower (follow.ts) then watches the sb server's slot folder (SB_DIR) and keeps the window on the live URL through restarts,
// upgrades and crashes, and shows the stopped and failed screens with a Start button.
// The debug menu exists for the Windows VM session; every action also runs unattended
// with --run=<action>[,<action>] and writes its outcome to results\ and logs\proto.jsonl.

interface Config { kitDir: string; feedUrl: string }

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const expand = (p: string) => p.replace(/%([^%]+)%/g, (_m, v: string) => process.env[v] ?? `%${v}%`);

function loadConfig(): Config {
	const bundled = JSON.parse(readFileSync(join(__dirname, "..", "config.default.json"), "utf8")) as Config;
	let user: Partial<Config> = {};
	try { user = JSON.parse(readFileSync(join(app.getPath("userData"), "config.json"), "utf8")) as Partial<Config>; } catch { /* none */ }
	return {
		kitDir: expand(arg("kit-dir") ?? process.env.SBD_KIT_DIR ?? user.kitDir ?? bundled.kitDir),
		feedUrl: arg("feed-url") ?? process.env.SBD_FEED_URL ?? user.feedUrl ?? bundled.feedUrl,
	};
}

const root = join(process.env.LOCALAPPDATA ?? app.getPath("userData"), "straw-boss-desk");
const logFile = join(root, "logs", "proto.jsonl");
const resultDir = join(root, "results");
mkdirSync(join(root, "logs"), { recursive: true });
mkdirSync(resultDir, { recursive: true });

function log(event: string, data: Record<string, unknown> = {}) {
	const line = JSON.stringify({ ts: new Date().toISOString(), event, ...data });
	appendFileSync(logFile, line + "\n");
	win?.webContents.send("sbd:log", `[${event}] ${data.detail ?? ""}`);
}
const saveResult = (name: string, o: unknown) => writeFileSync(join(resultDir, name), JSON.stringify(o, null, 2));
const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");

let win: BrowserWindow | undefined;
let config: Config;
let guiUrl: string | undefined;
let kitStarted = false;
let follower: Follower | undefined;
let quitting = false;
let startChild: ChildProcess | undefined;
// The previous start.ps1 run, whole: a second one (the follower's) never overlaps it, so the first run's tower step and the next run's `up` do not race.
let kitBusy: Promise<unknown> = Promise.resolve();

const state = (text: string) => win?.webContents.send("sbd:state", text);
const ps = (script: string, args: string[] = []) => ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(config.kitDir, script), ...args];
const hide = (text: string) => text.replace(/(127\.0\.0\.1:\d+\/)[0-9a-f]{16,}/gi, "$1<token>");

// start.ps1's exit codes (spike/win/start.ps1 header).
const START_CODES: Record<number, string> = {
	2: "a tool is missing (run the bootstrap)", 3: "a stack from another start is running (stop it first)", 4: "the herdr server did not answer",
	10: "another start held the lock", 11: "the sb server did not answer in time", 12: "another start did not finish", 13: "the old sb server did not leave",
	14: "no herdr server answers", 15: "the sb server is newer than the pin", 16: "the sb server was refused or did not start", 17: "the GUI did not start",
	18: "the sb server's start failed", 19: "the sb server cannot run (loader, intercom or acl; logs\\start.jsonl says which)", 20: "a bug in the kit (up usage)",
	21: "the start answered without a usable URL", 22: "the sb server is not in the primary slot",
};
class StartFailure extends Error {
	constructor(readonly code: number | null, message: string) { super(message); }
}

interface KitRun { url: string; dir: string | undefined; closed: Promise<number | null> }

/** Runs start.ps1 and resolves as soon as it has printed GUI_URL= and SB_DIR=; the run goes on (its tower step) and `closed` settles at its end. */
async function runStart(args: string[]): Promise<KitRun> {
	await kitBusy;
	const script = join(config.kitDir, "start.ps1");
	if (!existsSync(script)) throw new StartFailure(null, `start.ps1 not found at ${script} (kit dir ${config.kitDir})`);
	return new Promise<KitRun>((resolve, reject) => {
		const child = spawn("powershell.exe", ps("start.ps1", args), { windowsHide: true });
		startChild = child;
		kitStarted = true;
		let out = "";
		let url: string | undefined;
		let dir: string | undefined;
		let settled = false;
		const closed = new Promise<number | null>((done) => {
			child.on("close", (code) => {
				if (startChild === child) startChild = undefined;
				if (!settled) {
					settled = true;
					const fail = /^FAIL .*$/m.exec(out)?.[0];
					const meaning = code === null ? "" : START_CODES[code] ?? "";
					reject(new StartFailure(code, `start.ps1 exit ${code}${meaning ? `: ${meaning}` : ""}${fail ? `\n${hide(fail)}` : ""}\n${hide(out.slice(-400))}`));
				}
				done(code);
			});
		});
		kitBusy = closed;
		const finish = () => {
			if (settled || !url || dir === undefined) return;
			settled = true;
			resolve({ url, dir: dir || undefined, closed });
		};
		const eat = (chunk: Buffer) => {
			for (const line of chunk.toString("utf8").split(/\r?\n/)) {
				if (!line.trim()) continue;
				out += line + "\n";
				const m = /^(GUI_URL|SB_DIR|NOTICE)=(.*)$/.exec(line.trim());
				// The URL carries the page token: it is never written to the log.
				log("start.ps1", { detail: m && m[1] === "GUI_URL" ? "GUI_URL=<token url>" : hide(line) });
				if (!m) continue;
				if (m[1] === "GUI_URL") url = m[2];
				else if (m[1] === "SB_DIR") dir = m[2] ?? "";
				else notice(m[2] ?? "");
				finish();
			}
		};
		child.stdout.on("data", eat);
		child.stderr.on("data", eat);
		child.on("error", (e) => { if (!settled) { settled = true; reject(new StartFailure(null, String(e))); } });
	});
}

// A line the kit printed as NOTICE= (a tower that did not start, a server that ends with its starter): shown for a while, never a failed start.
function notice(text: string) {
	banner(text);
	setTimeout(() => banner(undefined), 12_000);
}

/** Runs stop.ps1 (cli.mjs stop up to 120 s, herdr, leftovers) and waits for it; the quit that asked for it waits too. */
function stopStack(): Promise<void> {
	if (!kitStarted) return Promise.resolve();
	startChild?.kill();
	return new Promise<void>((resolve) => {
		const child = spawn("powershell.exe", ps("stop.ps1"), { windowsHide: true });
		let last = "";
		const timer = setTimeout(() => { log("stop.ps1", { detail: "timeout after 300 s" }); child.kill(); resolve(); }, 300_000);
		child.stdout.on("data", (c: Buffer) => { last = c.toString("utf8").trim().split(/\r?\n/).pop() ?? last; });
		child.on("error", (e) => { clearTimeout(timer); log("stop.ps1", { detail: String(e) }); resolve(); });
		child.on("close", (code) => {
			clearTimeout(timer);
			log("stop.ps1", { detail: `exit ${code} ${last}` });
			kitStarted = false;
			resolve();
		});
	});
}

// ---- the window: GUI, shell screens, banner ----------------------------------------------------------------------------

let bannerView: WebContentsView | undefined;
const escapeHtml = (t: string) => t.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);

/** A small notice over the top of the page (the shell's own, so the GUI page is not touched); undefined removes it. */
function banner(text: string | undefined) {
	if (!win || win.isDestroyed()) return;
	if (text === undefined) {
		if (bannerView) { win.contentView.removeChildView(bannerView); bannerView.webContents.close(); bannerView = undefined; }
		return;
	}
	if (!bannerView) {
		bannerView = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true } });
		win.contentView.addChildView(bannerView);
	}
	bannerView.setBounds({ x: 0, y: 0, width: win.getContentBounds().width, height: 28 });
	const html = `<body style="margin:0;padding:0 12px;font:13px/28px 'Segoe UI',sans-serif;background:#fde68a;color:#222">${escapeHtml(text)}</body>`;
	void bannerView.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
	log("banner", { detail: text });
}

async function showScreen(screen: Screen) {
	if (!win) return;
	banner(undefined);
	await win.loadFile(join(__dirname, "..", "src", "status.html"));
	win.webContents.send("sbd:screen", screen);
}

async function showGui(url: string) {
	if (!win) throw new Error("no window");
	guiUrl = url;
	await win.loadURL(url);
	log("gui-loaded", { detail: hide(url) });
}

const followHost: FollowHost = {
	log: (event, data = {}) => log(event, data),
	load: showGui,
	screen: (screen) => void showScreen(screen),
	banner,
	runUp: async (): Promise<UpResult> => {
		try {
			// -NoTower: the follower only needs the stack and the URL; the restored tower is already there, and the first run owned the tower step.
			const run = await runStart(["-NoTower"]);
			return { ok: true, url: run.url };
		} catch (e) {
			return { ok: false, code: e instanceof StartFailure ? e.code : null, text: (e as Error).message };
		}
	},
};

/** The first start, and the Start button of a failed one. */
async function launch() {
	state("Starting herdr and the sb server...");
	try {
		const run = await runStart([]);
		state("Loading the GUI...");
		await showGui(run.url);
		follower?.stop();
		if (run.dir) {
			follower = new Follower(run.dir, followHost, run.url);
			follower.start();
		} else {
			log("follow-off", { detail: "start.ps1 printed no SB_DIR; the window will not follow a rotation" });
		}
	} catch (e) {
		const msg = (e as Error).message;
		log("start-failed", { detail: msg });
		state("Start failed: " + msg.split("\n")[0]);
		await showScreen({ kind: "failed", code: e instanceof StartFailure ? e.code : null, text: msg.split("\n").slice(0, 4).join("\n") });
	}
}

// ---- debug actions -------------------------------------------------------------------------------------------------

async function capture(): Promise<string> {
	if (!win) throw new Error("no window");
	const image = await win.webContents.capturePage();
	const file = join(resultDir, `proto-capture-${stamp()}.png`);
	writeFileSync(file, image.toPNG());
	const size = image.getSize();
	log("capture", { detail: `${file} ${size.width}x${size.height}`, file, ...size });
	return `${file} (${size.width}x${size.height}, URL ${win.webContents.getURL().replace(/\/[0-9a-f]{16,}\//, "/<token>/")})`;
}

async function safeStorageRoundtrip(): Promise<string> {
	// The async API is the current one (the sync calls are deprecated in Electron 45).
	const available = await safeStorage.isAsyncEncryptionAvailable();
	const secret = "sbd-" + randomBytes(12).toString("hex") + " 中文"; // the secret is random; a non-ASCII tail checks encoding
	const result: Record<string, unknown> = { available };
	if (available) {
		const enc = await safeStorage.encryptStringAsync(secret);
		const dec = await safeStorage.decryptStringAsync(enc);
		const file = join(app.getPath("userData"), "safestorage-probe.bin");
		writeFileSync(file, enc);
		const again = await safeStorage.decryptStringAsync(readFileSync(file));
		Object.assign(result, { roundtrip: dec.result === secret, afterFileRoundtrip: again.result === secret, shouldReEncrypt: dec.shouldReEncrypt, encryptedBytes: enc.length, plaintextVisibleInFile: enc.toString("latin1").includes(secret.slice(0, 12)), backend: "dpapi" });
	}
	saveResult(`proto-safestorage-${stamp()}.json`, result);
	log("safestorage", { detail: JSON.stringify(result), ...result });
	return JSON.stringify(result);
}

function versions(): string {
	const v = { app: app.getVersion(), electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node, arch: process.arch, platform: process.platform, windows: release(), userData: app.getPath("userData"), exe: app.getPath("exe"), isPackaged: app.isPackaged, kitDir: config.kitDir, feedUrl: config.feedUrl, guiUrl: guiUrl?.replace(/\/[0-9a-f]{16,}\//, "/<token>/") };
	saveResult(`proto-versions-${stamp()}.json`, v);
	log("versions", { detail: JSON.stringify(v), ...v });
	return JSON.stringify(v, null, 2);
}

function updaterSetup() {
	autoUpdater.autoDownload = false;
	autoUpdater.autoInstallOnAppQuit = false;
	autoUpdater.allowDowngrade = false;
	autoUpdater.setFeedURL({ provider: "generic", url: config.feedUrl });
	autoUpdater.logger = { info: (m: unknown) => log("updater", { detail: String(m) }), warn: (m: unknown) => log("updater-warn", { detail: String(m) }), error: (m: unknown) => log("updater-error", { detail: String(m) }), debug: () => {} };
}

async function checkUpdate(install: boolean): Promise<string> {
	updaterSetup();
	const t0 = Date.now();
	const r = await autoUpdater.checkForUpdates();
	const info = r?.updateInfo;
	const out: Record<string, unknown> = { current: app.getVersion(), feed: config.feedUrl, latest: info?.version, updateAvailable: r?.isUpdateAvailable, files: info?.files?.map((f) => f.url), ms: Date.now() - t0 };
	if (install && r?.isUpdateAvailable) {
		await autoUpdater.downloadUpdate();
		out.downloaded = true;
		saveResult(`proto-update-${stamp()}.json`, out);
		log("update", { detail: JSON.stringify(out), ...out });
		follower?.stop();
		await stopStack();
		autoUpdater.quitAndInstall(false, true);
		return JSON.stringify(out);
	}
	saveResult(`proto-update-${stamp()}.json`, out);
	log("update", { detail: JSON.stringify(out), ...out });
	return JSON.stringify(out, null, 2);
}

async function runAction(name: string): Promise<string> {
	try {
		switch (name) {
			case "capture": return await capture();
			case "safestorage": return await safeStorageRoundtrip();
			case "versions": return versions();
			case "update-check": return await checkUpdate(false);
			case "update-install": return await checkUpdate(true);
			default: throw new Error(`unknown action ${name}`);
		}
	} catch (e) {
		const msg = (e as Error).message;
		log("action-failed", { detail: `${name}: ${msg}`, action: name, error: msg });
		return `FAILED ${name}: ${msg}`;
	}
}

const show = async (title: string, text: string) => {
	if (win) await dialog.showMessageBox(win, { type: "info", title, message: title, detail: text });
};

function buildMenu() {
	Menu.setApplicationMenu(Menu.buildFromTemplate([
		{ label: "File", submenu: [{ role: "quit" }] },
		{ label: "Debug", submenu: [
			{ label: "Capture page to PNG", click: async () => show("Capture", await runAction("capture")) },
			{ label: "safeStorage encrypt/decrypt roundtrip", click: async () => show("safeStorage", await runAction("safestorage")) },
			{ label: "Check for updates", click: async () => show("Update check", await runAction("update-check")) },
			{ label: "Download and install update", click: async () => show("Update", await runAction("update-install")) },
			{ label: "Show versions", click: async () => show("Versions", await runAction("versions")) },
			{ type: "separator" },
			{ label: "Open results folder", click: () => void shell.openPath(resultDir) },
			{ label: "Toggle DevTools", role: "toggleDevTools" },
		] },
	]));
}

async function main() {
	config = loadConfig();
	log("launch", { detail: `v${app.getVersion()} arch=${process.arch} kit=${config.kitDir}`, argv: process.argv.slice(1) });
	buildMenu();
	win = new BrowserWindow({ width: 1280, height: 860, show: true, webPreferences: { preload: join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true } });
	win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) void shell.openExternal(url); return { action: "deny" }; });
	win.on("resize", () => { if (bannerView && win) bannerView.setBounds({ x: 0, y: 0, width: win.getContentBounds().width, height: 28 }); });
	ipcMain.on("sbd:start", () => void (follower ? follower.startFromScreen() : launch()));
	await win.loadFile(join(__dirname, "..", "src", "status.html"));
	const runs = (arg("run") ?? "").split(",").filter(Boolean);
	await launch();
	// Unattended mode: run the requested actions once the GUI (or the failure page) is up, then optionally quit.
	if (runs.length) {
		await new Promise((r) => setTimeout(r, Number(arg("settle-ms") ?? 4000)));
		for (const a of runs) log("run", { detail: `${a}: ${(await runAction(a)).slice(0, 300)}` });
		if (process.argv.includes("--quit-after")) app.quit();
	}
}

// Quitting waits for the stop sequence (cli.mjs stop alone may take 120 s on Windows), then exits; a crash of this app leaves the stack running, and the next launch reuses it.
app.on("before-quit", (event) => {
	if (quitting || !kitStarted) return;
	event.preventDefault();
	quitting = true;
	follower?.stop();
	void stopStack().finally(() => app.exit(0));
});
app.on("window-all-closed", () => app.quit());
void app.whenReady().then(main);
