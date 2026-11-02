import { app, BaseWindow, Menu, session, WebContentsView } from "electron";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pickLocale } from "../shared/locale.ts";
import { identityFromProductName } from "./build.ts";
import { dataRoot, electronDir, computeLayout } from "./paths.ts";
import { createPlatform } from "./platform/index.ts";
import { execRunner } from "./platform/exec.ts";
import { checkPaneLookups } from "./pane-path.ts";
import { hasStopStack } from "./runtime/args.ts";
import { loadStartConfig } from "./runtime/config.ts";
import { RuntimeLog } from "./runtime/log.ts";
import { Supervisor } from "./runtime/supervisor.ts";
import type { SpawnFn } from "./runtime/herdr.ts";

// The lifecycle: single instance, Chromium's profile inside the app data root, one window holding the two views the design needs, the GUI view (pi-straw-boss) and the shell
// view (welcome now; wizard, settings, banners later) above it, and the runtime supervisor that starts the stack at launch and stops it at quit (task 8a).

const identity = identityFromProductName(app.getName());
const root = dataRoot({ env: process.env, argv: process.argv.slice(1), platform: process.platform, home: homedir() });

// userData moves first: the single-instance lock is keyed on it, and Chromium must never write into the roaming %APPDATA%.
mkdirSync(electronDir(root), { recursive: true });
app.setPath("userData", electronDir(root));

const home = homedir();
const layout = computeLayout({ root, home, platform: process.platform === "win32" ? "win32" : "darwin" });
const runtimeLog = new RuntimeLog({ dir: layout.logs });
const platform = createPlatform();
const run = execRunner();

const supervisor = new Supervisor({
	layout,
	home,
	platform,
	run,
	spawn: spawn as unknown as SpawnFn,
	appEnv: process.env,
	config: () => loadStartConfig(layout, home),
	log: (fields) => runtimeLog.event(fields),
	resolveProxy: (url) => session.defaultSession.resolveProxy(url),
	// Windows: what a pane's `bash` would resolve to, at every start (the WSL notice).
	...(layout.platform === "win32" ? { checkPane: () => checkPaneLookups({ run, locate: platform.locate, exists: existsSync, env: process.env }) } : {}),
});

let window: BaseWindow | undefined;
let guiView: WebContentsView | undefined;
let shellView: WebContentsView | undefined;

supervisor.on((event) => {
	if (event.type !== "gui-url" || !guiView) return;
	// The GUI's address carries the page token: it goes to the view and nowhere else. The shell view steps aside while the GUI shows.
	const contents = guiView.webContents;
	contents.once("did-finish-load", () => supervisor.guiShown());
	void contents.loadURL(event.url).catch((error: Error) => runtimeLog.event({ event: "gui-load-failed", detail: error.message.slice(0, 200) }));
	shellView?.setVisible(false);
});

function layoutViews(): void {
	if (!window || window.isDestroyed()) return;
	const { width, height } = window.getContentBounds();
	for (const view of [guiView, shellView]) view?.setBounds({ x: 0, y: 0, width, height });
}

function createWindow(): void {
	window = new BaseWindow({ width: 1280, height: 860, minWidth: 720, minHeight: 520, title: identity.productName });

	// The GUI stays loaded under any shell screen or banner, so it is added first and the shell view sits above it.
	guiView = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
	shellView = new WebContentsView({
		webPreferences: {
			sandbox: true,
			contextIsolation: true,
			nodeIntegration: false,
			preload: join(import.meta.dirname, "..", "preload", "shell.cjs"),
			additionalArguments: [
				`--sbd-locale=${pickLocale([app.getLocale(), ...app.getPreferredSystemLanguages()])}`,
				`--sbd-product=${identity.productName}`,
				`--sbd-build=${identity.kind}`,
			],
		},
	});
	// Blank until the supervisor loads the GUI; a view that never navigates has no renderer, which a CDP client such as Playwright waits on forever.
	void guiView.webContents.loadURL("about:blank");
	window.contentView.addChildView(guiView);
	window.contentView.addChildView(shellView);
	layoutViews();
	window.on("resize", layoutViews);
	// Windows log off or shutdown: `cli.mjs stop` for 10 s, run to the end here, and Windows ends the rest.
	window.on("session-end", () => supervisor.stopForSessionEnd());
	window.on("closed", () => {
		window = undefined;
		guiView = undefined;
		shellView = undefined;
	});
	void shellView.webContents.loadFile(join(import.meta.dirname, "..", "renderer", "welcome.html"));
}

function buildMenu(): void {
	// Roles only: Electron labels them in the OS language, so no string of ours is needed here.
	Menu.setApplicationMenu(Menu.buildFromTemplate([
		...(process.platform === "darwin" ? [{ role: "appMenu" as const }] : []),
		{ role: "fileMenu" },
		{ role: "editMenu" },
		{ role: "viewMenu" },
		{ role: "windowMenu" },
	]));
}

// The quit holds until the stop sequence is done, then leaves with `app.exit`, so a quit never abandons the stack half stopped.
let stopping = false;
let stopped = false;

function stopThenExit(code: (ok: boolean) => number): void {
	if (stopping) return;
	stopping = true;
	supervisor
		.stop()
		.then((report) => {
			runtimeLog.event({ event: "quit-stop", ok: report.ok, leftovers: report.leftovers.length });
			return report.ok;
		})
		.catch((error: Error) => {
			runtimeLog.event({ event: "quit-stop-failed", detail: error.message.slice(0, 300) });
			return false;
		})
		.then((ok) => {
			stopped = true;
			app.exit(code(ok));
		});
}

if (!app.requestSingleInstanceLock()) {
	// A second launch only hands over to the running one; with --stop-stack it is the running one that stops the stack and quits.
	app.quit();
} else if (hasStopStack(process.argv)) {
	// No instance runs: stop whatever a crashed or killed earlier run left, show nothing, and leave (the uninstaller's call).
	void app.whenReady().then(() => stopThenExit((ok) => (ok ? 0 : 1)));
} else {
	app.on("second-instance", (_event, commandLine) => {
		if (hasStopStack(commandLine)) {
			app.quit();
			return;
		}
		if (!window) return;
		if (window.isMinimized()) window.restore();
		window.focus();
	});
	app.on("before-quit", (event) => {
		if (stopped) return;
		event.preventDefault();
		stopThenExit(() => 0);
	});
	// macOS keeps the app and the stack running when the window closes; Windows quits and stops (design: Window close).
	app.on("window-all-closed", () => {
		if (process.platform !== "darwin") app.quit();
	});
	app.on("activate", () => {
		if (!window) createWindow();
	});
	void app.whenReady().then(() => {
		buildMenu();
		createWindow();
		// Failures reach the shell's screens in task 9; until then they are in logs/start.jsonl.
		void supervisor.start().catch(() => undefined);
	});
}
