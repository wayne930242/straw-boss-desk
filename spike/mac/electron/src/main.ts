// Spike main process: load the straw-boss GUI from the state file a tower wrote, optionally capture the page, then quit.
import { app, BrowserWindow } from "electron";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const agentDir = process.env.PI_CODING_AGENT_DIR;
const shot = process.env.SBD_SHOT;
const shotDelayMs = Number(process.env.SBD_SHOT_DELAY_MS ?? 8000);
const script = process.env.SBD_SCRIPT; // optional file with JS evaluated in the page before the capture
if (!agentDir) throw new Error("PI_CODING_AGENT_DIR is not set");
app.setPath("userData", process.env.SBD_USER_DATA ?? join(agentDir, "..", "electron-user-data"));

const log = (...a: unknown[]) => {
	const line = [new Date().toISOString(), "[electron]", ...a.map((x) => (typeof x === "string" ? x : JSON.stringify(x)))].join(" ");
	console.log(line);
	if (process.env.SBD_LOG) appendFileSync(process.env.SBD_LOG, `${line}\n`);
};
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function guiUrl(): string {
	const rec = JSON.parse(readFileSync(join(agentDir!, "straw-boss", "gui.json"), "utf8")) as { port: number; token: string };
	return `http://127.0.0.1:${rec.port}/${rec.token}/`; // the trailing slash matters
}

const main = async () => {
	await app.whenReady();
	const win = new BrowserWindow({ width: 1280, height: 860, show: true, useContentSize: true, webPreferences: { sandbox: true, contextIsolation: true } });
	const wc = win.webContents;
	wc.on("console-message", (e) => log("console", e.level, e.message));
	wc.on("did-fail-load", (_e, code, desc, url) => log("did-fail-load", code, desc, url.replace(/\/[0-9a-f]{32}\//, "/<token>/")));
	wc.on("render-process-gone", (_e, d) => log("render-process-gone", d.reason));
	const t0 = Date.now();
	await win.loadURL(guiUrl());
	log("loaded", `${Date.now() - t0}ms`, "title:", JSON.stringify(wc.getTitle()));
	if (script) {
		await sleep(2000);
		log("script result:", await wc.executeJavaScript(readFileSync(script, "utf8"), true));
	}
	if (!shot) return script ? app.quit() : undefined; // a scripted run without a capture ends here; a plain run is the app
	await sleep(shotDelayMs);
	const img = await wc.capturePage();
	writeFileSync(shot, img.toPNG());
	const { width, height } = img.getSize();
	log("captured", shot, `${width}x${height}`, `${img.toPNG().length} bytes`);
	app.quit();
};

// Fail fast: any error in the run is logged and ends the process with a non-zero code, so a monitor sees it.
main().catch((error: unknown) => {
	log("failed:", String(error));
	app.exit(1);
});

app.on("window-all-closed", () => app.quit());
