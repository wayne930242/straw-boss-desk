import { app, BrowserWindow, dialog, Menu, safeStorage, shell } from "electron";
import { autoUpdater } from "electron-updater";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { release } from "node:os";

// Spike prototype. It runs the kit's start.ps1 (which owns every straw-boss detail), shows a minimal status page while it runs,
// then loads the GUI URL start.ps1 prints. The debug menu exists for the Windows VM session; every action also runs unattended
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

const state = (text: string) => win?.webContents.send("sbd:state", text);
const ps = (script: string, args: string[] = []) => ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(config.kitDir, script), ...args];

function startStack(): Promise<string> {
	return new Promise((resolve, reject) => {
		const script = join(config.kitDir, "start.ps1");
		if (!existsSync(script)) return reject(new Error(`start.ps1 not found at ${script} (kit dir ${config.kitDir})`));
		state("Starting herdr and the tower...");
		const child = spawn("powershell.exe", ps("start.ps1"), { windowsHide: true });
		kitStarted = true;
		let out = "";
		let url: string | undefined;
		const eat = (chunk: Buffer) => {
			for (const line of chunk.toString("utf8").split(/\r?\n/)) {
				if (!line.trim()) continue;
				out += line + "\n";
				log("start.ps1", { detail: line });
				const m = /^GUI_URL=(.+)$/.exec(line.trim());
				if (m) url = m[1];
			}
		};
		child.stdout.on("data", eat);
		child.stderr.on("data", eat);
		child.on("error", reject);
		child.on("close", (code) => (code === 0 && url ? resolve(url) : reject(new Error(`start.ps1 exit ${code}\n${out.slice(-600)}`))));
	});
}

function stopStack() {
	if (!kitStarted) return;
	const r = spawnSync("powershell.exe", ps("stop.ps1"), { windowsHide: true, timeout: 90_000, encoding: "utf8" });
	log("stop.ps1", { detail: `exit ${r.status} ${(r.stdout ?? "").trim().split(/\r?\n/).pop() ?? ""}` });
	kitStarted = false;
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
		stopStack();
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
	await win.loadFile(join(__dirname, "..", "src", "status.html"));
	const runs = (arg("run") ?? "").split(",").filter(Boolean);
	try {
		guiUrl = await startStack();
		state("Loading the GUI...");
		await win.loadURL(guiUrl);
		log("gui-loaded", { detail: guiUrl.replace(/\/[0-9a-f]{16,}\//, "/<token>/") });
	} catch (e) {
		const msg = (e as Error).message;
		log("start-failed", { detail: msg });
		state("Start failed: " + msg.split("\n")[0]);
		win.webContents.send("sbd:log", msg);
	}
	// Unattended mode: run the requested actions once the GUI (or the failure page) is up, then optionally quit.
	if (runs.length) {
		await new Promise((r) => setTimeout(r, Number(arg("settle-ms") ?? 4000)));
		for (const a of runs) log("run", { detail: `${a}: ${(await runAction(a)).slice(0, 300)}` });
		if (process.argv.includes("--quit-after")) app.quit();
	}
}

app.on("before-quit", () => stopStack());
app.on("window-all-closed", () => app.quit());
void app.whenReady().then(main);
