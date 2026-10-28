import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("sbd", {
	onLog: (cb: (line: string) => void) => ipcRenderer.on("sbd:log", (_e, line: string) => cb(line)),
	onState: (cb: (text: string) => void) => ipcRenderer.on("sbd:state", (_e, text: string) => cb(text)),
	onScreen: (cb: (screen: { kind: string; code?: number | null; text?: string }) => void) => ipcRenderer.on("sbd:screen", (_e, screen) => cb(screen)),
	start: () => ipcRenderer.send("sbd:start"),
});
