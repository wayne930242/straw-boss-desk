import { contextBridge, ipcRenderer } from "electron";

// The GUI view's preload (spec: Window and page security). It exposes one thing, `strawBossDesk.pickFolder({ defaultPath, title }) => Promise<string | null>`, the hook pi-straw-boss's
// folder picker reads (`gui/picker.ts`, desk-mode S10), and only when the page's origin is the loaded GUI's `http://127.0.0.1:<port>`. Main knows that origin, so it is asked
// (synchronously, once, before the page runs) rather than passed as an argument that a moved listener would make wrong. Main answers null for any other sender, so a page of another
// origin that somehow got this preload gets no hook; main checks the sender again on every call. The channel names repeat `shared/shell-state.ts` (a test keeps them equal).

const origin: unknown = ipcRenderer.sendSync("sbd:gui-origin");
const here = (globalThis as { location?: { origin?: string } }).location?.origin;

if (typeof origin === "string" && origin !== "" && here === origin) {
	contextBridge.exposeInMainWorld("strawBossDesk", {
		pickFolder: (options?: { defaultPath?: unknown; title?: unknown }): Promise<string | null> =>
			ipcRenderer.invoke("sbd:pick-folder", { defaultPath: typeof options?.defaultPath === "string" ? options.defaultPath : "", title: typeof options?.title === "string" ? options.title : "" }) as Promise<string | null>,
	});
}
