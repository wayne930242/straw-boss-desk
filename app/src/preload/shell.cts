import { contextBridge } from "electron";

// The shell view's preload. Main passes the few values the page needs as additional arguments; nothing here reaches Node or the file system.
const arg = (name: string): string | undefined => {
	const prefix = `--sbd-${name}=`;
	return process.argv.find((a) => a.startsWith(prefix))?.slice(prefix.length);
};

contextBridge.exposeInMainWorld("sbdShell", {
	locale: arg("locale") === "zh-TW" ? "zh-TW" : "en",
	productName: arg("product") ?? "",
	build: arg("build") === "release" ? "release" : "dev",
});
