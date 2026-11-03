import { contextBridge, ipcRenderer } from "electron";
import type { ShellAction, ShellState } from "../shared/shell-state.ts";
import type { SettingsAction, SettingsView, WizardAction, WizardView } from "../shared/wizard.ts";

// The shell view's preload. Main passes the few values the page needs as additional arguments; nothing here reaches Node or the file system. The shell pages (the wizard, the settings, and the
// runtime page `screen.html`) ask main what they should show, hear when that changes, and send their requests back through the typed calls below. Main checks who asks on every one.
// The channel names repeat `shared/shell-state.ts` (a test keeps them equal).
const arg = (name: string): string | undefined => {
	const prefix = `--sbd-${name}=`;
	return process.argv.find((a) => a.startsWith(prefix))?.slice(prefix.length);
};

contextBridge.exposeInMainWorld("sbdShell", {
	/** The language when the page loaded; `onLocale` follows a change. */
	locale: arg("locale") === "zh-TW" ? "zh-TW" : "en",
	productName: arg("product") ?? "",
	build: arg("build") === "release" ? "release" : "dev",
	/** The state main wants the runtime page (`screen.html`) to show now (a plain object: see `ShellState`). */
	state: (): Promise<ShellState> => ipcRenderer.invoke("sbd:shell-state"),
	/** Calls `listener` with each new state main sends. */
	onState: (listener: (state: ShellState) => void): void => {
		ipcRenderer.on("sbd:shell-state-changed", (_event, state: ShellState) => listener(state));
	},
	/** The runtime page's requests: Start and Try again are `retry`; Repair; a notice's buttons. */
	act: (action: ShellAction): void => {
		ipcRenderer.send("sbd:shell-action", action);
	},
	/** The interface language, which the PM can change in the wizard and in settings. */
	getLocale: (): Promise<"en" | "zh-TW"> => ipcRenderer.invoke("sbd:locale"),
	onLocale: (listener: (locale: "en" | "zh-TW") => void): void => {
		ipcRenderer.on("sbd:locale-changed", (_event, locale: "en" | "zh-TW") => listener(locale));
	},
	wizardState: (): Promise<WizardView> => ipcRenderer.invoke("sbd:wizard-state"),
	onWizard: (listener: (view: WizardView) => void): void => {
		ipcRenderer.on("sbd:wizard-changed", (_event, view: WizardView) => listener(view));
	},
	wizardAct: (action: WizardAction): Promise<void> => ipcRenderer.invoke("sbd:wizard-act", action),
	settingsState: (): Promise<SettingsView> => ipcRenderer.invoke("sbd:settings-state"),
	onSettings: (listener: (view: SettingsView) => void): void => {
		ipcRenderer.on("sbd:settings-changed", (_event, view: SettingsView) => listener(view));
	},
	settingsAct: (action: SettingsAction): Promise<void> => ipcRenderer.invoke("sbd:settings-act", action),
});
