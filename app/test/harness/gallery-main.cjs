// Test code: the main process of the page gallery (`e2e/gallery.e2e.ts`). It opens one window with the real shell preload (`dist/preload/shell.cjs`) on a real page of `dist/renderer`, answers the page's
// state calls with whatever view the test last set, and sends a view to the page on request, so every state of a page can be drawn and photographed without the app behind it. It runs no part of the app.
const { app, BrowserWindow, ipcMain } = require("electron");
const { join } = require("node:path");

const dist = process.env.SBD_GALLERY_DIST;
const state = { wizard: null, settings: null, locale: "en" };

app.whenReady().then(() => {
	ipcMain.handle("sbd:wizard-state", () => state.wizard);
	ipcMain.handle("sbd:settings-state", () => state.settings);
	ipcMain.handle("sbd:locale", () => state.locale);
	ipcMain.handle("sbd:wizard-act", () => undefined);
	ipcMain.handle("sbd:settings-act", () => undefined);
	ipcMain.handle("sbd:shell-state", () => null);
	ipcMain.on("sbd:shell-action", () => undefined);
	const win = new BrowserWindow({
		width: 1000,
		height: 900,
		webPreferences: {
			preload: join(dist, "preload", "shell.cjs"),
			sandbox: true,
			contextIsolation: true,
			nodeIntegration: false,
			additionalArguments: ["--sbd-locale=en", "--sbd-build=dev", "--sbd-product=Gallery"],
		},
	});
	globalThis.__gallery = {
		win,
		/** Loads a page and resolves when it has loaded. */
		load: (page, kind, view) => {
			state[kind] = view;
			state.locale = view.locale;
			return win.loadFile(join(dist, "renderer", `${page}.html`));
		},
		/** Sends a view to the page that is open. */
		push: (kind, view) => {
			state[kind] = view;
			state.locale = view.locale;
			win.webContents.send(kind === "wizard" ? "sbd:wizard-changed" : "sbd:settings-changed", view);
		},
	};
});
app.on("window-all-closed", () => app.quit());
