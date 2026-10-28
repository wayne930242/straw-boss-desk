import { readFileSync, watch, type FSWatcher } from "node:fs";
import { request, type IncomingMessage } from "node:http";
import { join } from "node:path";

// Follows the GUI of the sb server through token rotations (desk B7 plan, "The GUI URL and a rotation").
// It reads the slot folder (SB_DIR from start.ps1): server.json for `stopped`, `restarting`, and `gui: {port, token, stopped}`, with gui.json as the
// fallback for the GUI's port, token and `stopped`. Both files are secrets: nothing here logs them or a URL's token. The only HTTP it speaks is a GET
// of 127.0.0.1 URLs the server itself named. It never calls `cli.mjs status` (every call costs a PowerShell start on Windows).
// No Electron import: the window, the screens and the `up` run are handed in, so the logic runs under plain Node (the Windows prototype and the macOS
// spike app share this one file; spike/mac/07-follow-check.sh runs it headless against a real server).

export interface GuiTarget { port: number; token: string }
export type Screen =
	| { kind: "gui-stopped" }
	| { kind: "server-stopped" }
	| { kind: "failed"; code: number | null; text: string };
export type UpResult = { ok: true; url: string } | { ok: false; code: number | null; text: string };

export interface FollowHost {
	log(event: string, data?: Record<string, unknown>): void;
	/** Loads a URL into the window. */
	load(url: string): Promise<void>;
	/** Replaces the page with a shell screen (the GUI is not worth showing then). */
	screen(screen: Screen): void;
	/** A small notice over the page; undefined removes it. */
	banner(text: string | undefined): void;
	/** Runs the kit's start once (one at a time, enforced here) and returns the URL it printed. */
	runUp(): Promise<UpResult>;
}

export interface FollowTiming {
	/** How often the folder is read when no watch event came (a watch on Windows can miss a rename). */
	tickMs: number;
	/** The URL unanswered for this long, with no fresh `restarting`, is gone. */
	goneMs: number;
	/** A `restarting.since` younger than this counts as a restart under way (the starting server touches it every 2 s). */
	freshMs: number;
	/** How long a moved URL is polled for before the move is given up for this tick, and how often. */
	moveWaitMs: number;
	movePollMs: number;
}
export const DEFAULT_TIMING: FollowTiming = { tickMs: 2000, goneMs: 10_000, freshMs: 10_000, moveWaitMs: 30_000, movePollMs: 250 };

const URL_SHAPE = /^http:\/\/127\.0\.0\.1:(\d+)\/([0-9a-f]{16,})\/$/;
export const parseGuiUrl = (url: string): GuiTarget | undefined => {
	const m = URL_SHAPE.exec(url);
	return m ? { port: Number(m[1]), token: String(m[2]) } : undefined;
};
export const urlOf = (t: GuiTarget) => `http://127.0.0.1:${t.port}/${t.token}/`; // the trailing slash matters
const same = (a: GuiTarget | undefined, b: GuiTarget | undefined) => a?.port === b?.port && a?.token === b?.token;

interface ServerFile { stopped?: boolean; restarting?: { since?: string }; gui?: { port?: number; token?: string; stopped?: boolean } }
interface GuiFile { port?: number; token?: string; stopped?: boolean }

/** Both files are written by rename, so a read never sees half a file; a parse failure or a missing file is simply no information this tick. */
function readJson<T>(file: string): T | undefined {
	try { return JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, "")) as T; } catch { return undefined; }
}

const isTarget = (port: unknown, token: unknown): boolean => Number.isInteger(port) && typeof token === "string" && token.length > 0;

/** A GET of one URL: the status code, or 0 when nothing answered. */
export function probe(url: string, timeoutMs = 3000): Promise<number> {
	return new Promise((done) => {
		let u: URL;
		try { u = new URL(url); } catch { return done(0); }
		if (u.hostname !== "127.0.0.1") return done(0); // never anywhere else
		const req = request({ host: "127.0.0.1", port: Number(u.port), path: u.pathname, method: "GET", agent: false, timeout: timeoutMs }, (res: IncomingMessage) => {
			res.resume();
			done(res.statusCode ?? 0);
		});
		req.on("error", () => done(0));
		req.on("timeout", () => { req.destroy(); done(0); });
		req.end();
	});
}

export class Follower {
	private loaded: GuiTarget | undefined;
	private unansweredSince: number | undefined;
	private shown: string | undefined; // the shell screen or banner showing now
	private running = false;
	private again = false;
	private giveUp = false; // a failed `up` is shown once; only the Start button tries again
	private timer: NodeJS.Timeout | undefined;
	private watcher: FSWatcher | undefined;
	private readonly timing: FollowTiming;
	private readonly dir: string;
	private readonly host: FollowHost;

	// Written without parameter properties so Node can run this file as it is (type stripping), as well as tsc.
	constructor(dir: string, host: FollowHost, loadedUrl: string | undefined, timing: Partial<FollowTiming> = {}) {
		this.dir = dir;
		this.host = host;
		this.timing = { ...DEFAULT_TIMING, ...timing };
		this.loaded = loadedUrl ? parseGuiUrl(loadedUrl) : undefined;
	}

	start() {
		try {
			this.watcher = watch(this.dir, () => this.schedule());
			this.watcher.on("error", (e: Error) => this.host.log("follow-watch-error", { detail: String(e) }));
		} catch (e) {
			this.host.log("follow-watch-failed", { detail: `${String(e)} (reading every ${this.timing.tickMs} ms only)` });
		}
		this.timer = setInterval(() => this.schedule(), this.timing.tickMs);
		this.host.log("follow-start", { detail: this.dir });
		this.schedule();
	}

	stop() {
		if (this.timer) clearInterval(this.timer);
		this.watcher?.close();
		this.timer = undefined;
		this.watcher = undefined;
	}

	/** The Start button of a shell screen: the same run as `gone`, also after a failure. */
	async startFromScreen() {
		this.giveUp = false;
		await this.exclusive(() => this.bringUp("start button"));
	}

	private schedule() {
		void this.exclusive(() => this.tick());
	}

	/** One thing at a time: a watch event during a move or an `up` run asks for one more tick afterwards. */
	private async exclusive(work: () => Promise<void>) {
		if (this.running) { this.again = true; return; }
		this.running = true;
		try {
			await work();
		} catch (e) {
			this.host.log("follow-error", { detail: String(e) });
		} finally {
			this.running = false;
		}
		if (this.again) { this.again = false; this.schedule(); }
	}

	private show(key: string, screen: Screen) {
		if (this.shown === key) return;
		this.shown = key;
		this.loaded = undefined; // the page is gone: whatever target the record names next is a load
		this.host.screen(screen);
		this.host.log("follow-screen", { detail: key });
	}

	private note(text: string | undefined) {
		const key = text === undefined ? undefined : `banner:${text}`;
		if (this.shown === key) return;
		if (this.shown?.startsWith("banner:") || key !== undefined) this.host.banner(text);
		if (key === undefined || key.startsWith("banner:")) this.shown = key;
	}

	/** What the folder says now. */
	private observe() {
		const rec = readJson<ServerFile>(join(this.dir, "server.json"));
		const gui = readJson<GuiFile>(join(this.dir, "gui.json"));
		const since = Date.parse(rec?.restarting?.since ?? "");
		const restarting = Boolean(rec?.restarting) && Number.isFinite(since) && Date.now() - since < this.timing.freshMs;
		const guiStopped = rec?.gui ? rec.gui.stopped === true : gui?.stopped === true;
		let target: GuiTarget | undefined;
		if (rec?.gui && isTarget(rec.gui.port, rec.gui.token)) target = { port: Number(rec.gui.port), token: String(rec.gui.token) };
		else if (gui && isTarget(gui.port, gui.token)) target = { port: Number(gui.port), token: String(gui.token) };
		return { read: rec !== undefined || gui !== undefined, serverStopped: rec?.stopped === true, guiStopped, restarting, target };
	}

	private async tick() {
		const o = this.observe();
		if (o.serverStopped) return this.show("server-stopped", { kind: "server-stopped" });
		if (o.guiStopped) return this.show("gui-stopped", { kind: "gui-stopped" });
		if (o.restarting) { this.unansweredSince = undefined; return this.note("The stack is restarting..."); }
		// moved: the record names a listener other than the one in the window (every new listener draws a new token).
		if (o.target && !same(o.target, this.loaded)) { this.giveUp = false; return this.move(o.target); }
		if (this.shown?.startsWith("banner:")) this.note(undefined);
		if (!this.loaded) return; // a screen is showing and nothing new was recorded: the Start button is the way on
		// live or gone: the URL in the window must answer.
		if ((await probe(urlOf(this.loaded))) === 200) { this.unansweredSince = undefined; return; }
		const now = Date.now();
		this.unansweredSince ??= now;
		if (now - this.unansweredSince < this.timing.goneMs || this.giveUp) return;
		this.host.log("follow-gone", { detail: `URL unanswered for ${now - this.unansweredSince} ms, no fresh restart` });
		await this.bringUp("gone");
	}

	/** moved: GET the new URL every movePollMs until it answers 200 (the old one answers 403 from then on), then load it. */
	private async move(target: GuiTarget) {
		this.note("The address changed, reloading...");
		const url = urlOf(target);
		const deadline = Date.now() + this.timing.moveWaitMs;
		for (;;) {
			if ((await probe(url)) === 200) break;
			if (Date.now() >= deadline) {
				this.host.log("follow-move-timeout", { detail: `port ${target.port} did not answer within ${this.timing.moveWaitMs} ms` });
				return; // the next tick looks again; a listener that never answers ends as gone through the old URL's probe
			}
			await new Promise((r) => setTimeout(r, this.timing.movePollMs));
		}
		await this.host.load(url);
		this.loaded = target;
		this.unansweredSince = undefined;
		this.shown = undefined;
		this.host.banner(undefined);
		this.host.log("follow-moved", { detail: `loaded port ${target.port}` });
	}

	/** gone: run `up` once, then load its URL; a failure shows the exit-code screen and waits for the Start button. */
	private async bringUp(why: string) {
		this.note("Starting the stack...");
		this.host.log("follow-up", { detail: why });
		const r = await this.host.runUp();
		if (!r.ok) {
			this.giveUp = true;
			this.host.banner(undefined);
			this.shown = undefined;
			this.show("failed", { kind: "failed", code: r.code, text: r.text });
			return;
		}
		const target = parseGuiUrl(r.url);
		if (!target) {
			this.giveUp = true;
			this.show("failed", { kind: "failed", code: null, text: "the start printed a URL of an unexpected shape" });
			return;
		}
		await this.host.load(r.url);
		this.loaded = target;
		this.unansweredSince = undefined;
		this.shown = undefined;
		this.host.banner(undefined);
		this.host.log("follow-up-done", { detail: `loaded port ${target.port}` });
	}
}
