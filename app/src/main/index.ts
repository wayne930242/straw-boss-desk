import { app, BaseWindow, Menu, WebContentsView } from "electron";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pickLocale } from "../shared/locale.ts";
import { identityFromProductName } from "./build.ts";
import { dataRoot, electronDir } from "./paths.ts";

// The skeleton: single instance, Chromium's profile inside the app data root, and one window holding the two views the design needs,
// the GUI view (pi-straw-boss, loaded from task 8a on) and the shell view (welcome now; wizard, settings, banners later) above it.

const identity = identityFromProductName(app.getName());
const root = dataRoot({ env: process.env, argv: process.argv.slice(1), platform: process.platform, home: homedir() });

// userData moves first: the single-instance lock is keyed on it, and Chromium must never write into the roaming %APPDATA%.
mkdirSync(electronDir(root), { recursive: true });
app.setPath("userData", electronDir(root));

let window: BaseWindow | undefined;
let guiView: WebContentsView | undefined;
let shellView: WebContentsView | undefined;

function layout(): void {
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
	window.contentView.addChildView(guiView);
	window.contentView.addChildView(shellView);
	layout();
	window.on("resize", layout);
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

if (!app.requestSingleInstanceLock()) {
	// A second launch only hands over to the running one.
	app.quit();
} else {
	app.on("second-instance", () => {
		if (!window) return;
		if (window.isMinimized()) window.restore();
		window.focus();
	});
	// macOS keeps the app and the stack running when the window closes; Windows quits (design: Window close).
	app.on("window-all-closed", () => {
		if (process.platform !== "darwin") app.quit();
	});
	app.on("activate", () => {
		if (!window) createWindow();
	});
	void app.whenReady().then(() => {
		buildMenu();
		createWindow();
	});
}
