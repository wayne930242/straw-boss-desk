import { contextBridge, ipcRenderer } from "electron";
import type { ShellAction, ShellState } from "../shared/shell-state.ts";

// The shell view's preload. Main passes the few values the page needs as additional arguments; nothing here reaches Node or the file system. The runtime page (`screen.html`) also asks
// main what it should show (a notice over the GUI, or a whole screen), hears when that changes, and can send one request back: **Start** and **Try again** are the same, `retry`.
// The channel names repeat `shared/shell-state.ts` (a test keeps them equal).
const arg = (name: string): string | undefined => {
	const prefix = `--sbd-${name}=`;
	return process.argv.find((a) => a.startsWith(prefix))?.slice(prefix.length);
};

contextBridge.exposeInMainWorld("sbdShell", {
	locale: arg("locale") === "zh-TW" ? "zh-TW" : "en",
	productName: arg("product") ?? "",
	build: arg("build") === "release" ? "release" : "dev",
	/** The state main wants shown now (a plain object: see `ShellState`). */
	state: (): Promise<ShellState> => ipcRenderer.invoke("sbd:shell-state"),
	/** Calls `listener` with each new state main sends. */
	onState: (listener: (state: ShellState) => void): void => {
		ipcRenderer.on("sbd:shell-state-changed", (_event, state: ShellState) => listener(state));
	},
	/** The page's one request. */
	act: (action: ShellAction): void => {
		ipcRenderer.send("sbd:shell-action", action);
	},
});
