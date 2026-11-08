import { readFileSync, watch, type FSWatcher } from "node:fs";
import { request, type IncomingMessage } from "node:http";
import { join } from "node:path";
import { SERVER_RESTART_MAX, SERVER_RESTART_WINDOW_MS, SlidingBudget } from "./budget.ts";
import type { StartFailure } from "./failure.ts";

// Follows the GUI of the sb server through token rotations, restarts and stops (spec: Runtime supervisor, Following the GUI; desk B7 plan, "The GUI URL and a rotation"). This is the
// kit's `follow.ts` (spike/win/proto/src/follow.ts), run by both prototypes and checked headless against a real server, with the rules unchanged: a folder watch plus a read every 2 s;
// moved, restarting, gui stopped, server stopped, and gone; one `up` at a time; GETs only to 127.0.0.1. The additions of phase 2:
//   - restarts: the server's `pid` and `started` from `server.json` are kept, and a change is logged and handed to the host (the supervisor counts it and records the new pid);
//   - the `view` of `gui.json` (`standard`, `geek` or `zen`) is handed to the host when it appears or changes, so the window's background follows it;
//   - sleep: `pause` stops the ticks, and `resume` reads the folder again and gives the URL a grace period before the gone rule applies;
//   - the host's words are kinds, not strings: banners are kinds and a failed `up` is a typed `StartFailure`, so the shell's screens say them in the catalog's language;
//   - the gone rule has a budget: an `up` it ran whose address, probed right after the load, still did not answer counts, and the fourth within 10 minutes logs `restart-budget` and
//     shows the `restart-budget` screen instead of running `up` every ~12 s for ever (T8B-F003, S53-F003).
// It reads `server.json` for `stopped`, `restarting`, `pid`, `started` and `gui: {port, token, stopped}`, with `gui.json` as the fallback for the GUI's port, token and `stopped`.
// Both files are secrets: nothing here logs them or a URL's token. It never calls `cli.mjs status` (every call costs a PowerShell start on Windows). No Electron import: the window,
// the screens and the `up` run are handed in, so the logic runs under plain Node.

export interface GuiTarget {
	port: number;
	token: string;
}

/** The server's default view (`/boss gui view`), as `gui.json` carries it; absent when none is set. */
export type GuiView = "standard" | "geek" | "zen" | "raven";

export type Screen = { kind: "gui-stopped" } | { kind: "server-stopped" } | { kind: "failed"; failure: StartFailure };

/** A small notice over the page: the stack restarts, the address changed, a start runs. */
export type BannerKind = "restarting" | "address-changed" | "starting";

export type UpResult = { ok: true; url: string } | { ok: false; failure: StartFailure };

/** The sb server process as `server.json` names it. */
export interface ServerIdentity {
	pid: number;
	started?: string;
}

export interface FollowHost {
	log(event: string, data?: Record<string, unknown>): void;
	/** Loads a URL into the window. */
	load(url: string): Promise<void> | void;
	/** Replaces the page with a shell screen (the GUI is not worth showing then). */
	screen(screen: Screen): void;
	/** A small notice over the page; undefined removes it. */
	banner(kind: BannerKind | undefined): void;
	/** Runs `up` once (one at a time, enforced here) and returns the URL it printed, or the typed failure. */
	runUp(): Promise<UpResult>;
	/** The sb server runs under another pid (or another start time) than the one the follower knew. */
	restarted(server: ServerIdentity): void;
	/** The server's default view, when it first shows and whenever it changes (undefined: none set). */
	view(view: GuiView | undefined): void;
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
	/** After `resume`, how long the gone rule stays off, so the sleep's gap is not counted as an unanswered GUI. */
	resumeGraceMs: number;
}
export const DEFAULT_TIMING: FollowTiming = { tickMs: 2000, goneMs: 10_000, freshMs: 10_000, moveWaitMs: 30_000, movePollMs: 250, resumeGraceMs: 20_000 };

const URL_SHAPE = /^http:\/\/127\.0\.0\.1:(\d+)\/([0-9a-f]{16,})\/$/;
export const parseGuiUrl = (url: string): GuiTarget | undefined => {
	const m = URL_SHAPE.exec(url);
	return m ? { port: Number(m[1]), token: String(m[2]) } : undefined;
};
export const urlOf = (t: GuiTarget) => `http://127.0.0.1:${t.port}/${t.token}/`; // the trailing slash matters
const same = (a: GuiTarget | undefined, b: GuiTarget | undefined) => a?.port === b?.port && a?.token === b?.token;

interface ServerFile {
	pid?: number;
	started?: string;
	stopped?: boolean;
	restarting?: { since?: string };
	gui?: { port?: number; token?: string; stopped?: boolean };
}
interface GuiFile {
	port?: number;
	token?: string;
	stopped?: boolean;
	view?: string;
}

/** Both files are written by rename, so a read never sees half a file; a parse failure or a missing file is simply no information this tick. */
function readJson<T>(file: string): T | undefined {
	try {
		return JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, "")) as T;
	} catch {
		return undefined;
	}
}

const isTarget = (port: unknown, token: unknown): boolean => Number.isInteger(port) && typeof token === "string" && token.length > 0;

const VIEWS: readonly string[] = ["standard", "geek", "zen", "raven"];
const viewOf = (value: unknown): GuiView | undefined => (typeof value === "string" && VIEWS.includes(value) ? (value as GuiView) : undefined);

/** The default view `gui.json` in `slotDir` carries, or undefined (no default set, a missing file, or a value this build does not know). */
export const readGuiView = (slotDir: string): GuiView | undefined => viewOf(readJson<GuiFile>(join(slotDir, "gui.json"))?.view);

/**
 * The window's background for a view, set before the page loads and whenever the view changes: `geek` is black and `zen` is the Zen page's own ground (`html[data-view=zen] body`
 * in pi-straw-boss 0.52.0's stylesheet, `#14110e`), `raven` is Raven Keep's `--bg` (`gui/themes/raven/raven.css` of 0.64.0, `#0d0a10`); anything else is the page's `--bg` (`#16161e`).
 * The shell's own screens use the same dark palette.
 */
export function backgroundOf(view: GuiView | undefined): string {
	if (view === "geek") return "#000000";
	if (view === "zen") return "#14110e";
	if (view === "raven") return "#0d0a10";
	return "#16161e";
}

/** A GET of one URL: the status code, or 0 when nothing answered. */
export function probe(url: string, timeoutMs = 3000): Promise<number> {
	return new Promise((done) => {
		let u: URL;
		try {
			u = new URL(url);
		} catch {
			return done(0);
		}
		if (u.hostname !== "127.0.0.1") return done(0); // never anywhere else
		const req = request({ host: "127.0.0.1", port: Number(u.port), path: u.pathname, method: "GET", agent: false, timeout: timeoutMs }, (res: IncomingMessage) => {
			res.resume();
			done(res.statusCode ?? 0);
		});
		req.on("error", () => done(0));
		req.on("timeout", () => {
			req.destroy();
			done(0);
		});
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
	private failedTarget: GuiTarget | undefined; // a target move() gave up on: skipped until the record names another one
	private stopped = false; // stop() was called: no further tick, move or run starts, so a quit never overlaps a new start with the stop
	private paused = false; // the computer sleeps: no tick reads or probes anything
	private graceUntil = 0; // after a resume, the gone rule stays off until this time
	private pendingStart = false; // the Start button was pressed while a run was going: the next exclusive run starts the stack
	private server: ServerIdentity | undefined; // the sb server as last seen; a change is a restart
	private readonly goneBudget = new SlidingBudget(SERVER_RESTART_MAX, SERVER_RESTART_WINDOW_MS); // gone-rule `up` runs; reset by the Start button and by a new follower
	private view: GuiView | undefined;
	private viewSeen = false;
	private timer: NodeJS.Timeout | undefined;
	private watcher: FSWatcher | undefined;
	private readonly timing: FollowTiming;
	private readonly dir: string;
	private readonly host: FollowHost;

	// Written without parameter properties so Node can run this file as it is (type stripping), as well as tsc.
	constructor(dir: string, host: FollowHost, loadedUrl: string | undefined, timing: Partial<FollowTiming> = {}, server?: ServerIdentity, view?: GuiView) {
		this.dir = dir;
		this.host = host;
		this.timing = { ...DEFAULT_TIMING, ...timing };
		this.loaded = loadedUrl ? parseGuiUrl(loadedUrl) : undefined;
		this.server = server;
		// The view the window was painted with: the host hears of a change only.
		this.view = view;
		this.viewSeen = view !== undefined;
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
		this.stopped = true;
		if (this.timer) clearInterval(this.timer);
		this.watcher?.close();
		this.timer = undefined;
		this.watcher = undefined;
	}

	/** The computer goes to sleep (`powerMonitor` `suspend`): nothing is read or probed until `resume`. */
	pause() {
		if (this.paused) return;
		this.paused = true;
		this.host.log("follow-pause");
	}

	/** The computer woke (`powerMonitor` `resume`): the folder is read again at once, and the gone rule stays off for `resumeGraceMs`. */
	resume() {
		if (!this.paused) return;
		this.paused = false;
		this.unansweredSince = undefined;
		this.graceUntil = Date.now() + this.timing.resumeGraceMs;
		this.host.log("follow-resume", { detail: `the gone rule waits ${this.timing.resumeGraceMs} ms` });
		this.schedule();
	}

	/** The window now shows `url` (the supervisor's own `up`, or a start): it is the loaded page, and the sb server it names is the one running. */
	adopt(url: string, server?: ServerIdentity) {
		const target = parseGuiUrl(url);
		if (!target) return;
		this.loaded = target;
		this.unansweredSince = undefined;
		this.giveUp = false;
		this.failedTarget = undefined;
		this.shown = undefined;
		if (server) this.server = server;
	}

	/** The Start button of a shell screen: the same run as `gone`, also after a failure. */
	async startFromScreen() {
		this.giveUp = false;
		this.goneBudget.reset();
		this.failedTarget = undefined;
		this.pendingStart = true;
		await this.exclusive(() => this.tick());
	}

	private schedule() {
		void this.exclusive(() => this.tick());
	}

	/** One thing at a time: a watch event during a move or an `up` run asks for one more tick afterwards. */
	private async exclusive(work: () => Promise<void>) {
		if (this.stopped) return;
		if (this.paused && !this.pendingStart) return;
		if (this.running) {
			this.again = true;
			return;
		}
		this.running = true;
		try {
			// A Start press waits behind a running move or tick and then replaces the next run, so it is never lost to the tick.
			if (this.pendingStart) {
				this.pendingStart = false;
				await this.bringUp("start button");
			} else await work();
		} catch (e) {
			this.host.log("follow-error", { detail: String(e) });
		} finally {
			this.running = false;
		}
		if (this.again) {
			this.again = false;
			this.schedule();
		}
	}

	private show(key: string, screen: Screen) {
		if (this.shown === key) return;
		this.shown = key;
		this.loaded = undefined; // the page is gone: whatever target the record names next is a load
		this.host.screen(screen);
		this.host.log("follow-screen", { detail: key });
	}

	private note(kind: BannerKind | undefined) {
		const key = kind === undefined ? undefined : `banner:${kind}`;
		if (this.shown === key) return;
		if (this.shown?.startsWith("banner:") || key !== undefined) this.host.banner(kind);
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
		const server: ServerIdentity | undefined = rec !== undefined && Number.isInteger(rec.pid) && (rec.pid as number) > 0 ? { pid: rec.pid as number, ...(typeof rec.started === "string" && rec.started !== "" ? { started: rec.started } : {}) } : undefined;
		return { read: rec !== undefined || gui !== undefined, serverStopped: rec?.stopped === true, guiStopped, restarting, target, server, gui, view: viewOf(gui?.view) };
	}

	/** A pid, or a start time, other than the one known is a restart (`cli.mjs restart`, a pi session's own restart, a crash and a new start). */
	private noteServer(seen: ServerIdentity | undefined) {
		if (seen === undefined) return;
		const known = this.server;
		if (known === undefined) {
			this.server = seen; // first sight: nothing to compare with
			return;
		}
		const sameProcess = known.pid === seen.pid && (known.started === undefined || seen.started === undefined || known.started === seen.started);
		if (sameProcess) {
			if (known.started === undefined && seen.started !== undefined) this.server = { pid: known.pid, started: seen.started };
			return;
		}
		this.server = seen;
		this.host.log("follow-restart", { detail: `the sb server runs as pid ${seen.pid} (was ${known.pid})` });
		this.host.restarted(seen);
	}

	private noteView(gui: GuiFile | undefined, view: GuiView | undefined) {
		if (gui === undefined) return; // gui.json could not be read this tick: no information
		if (this.viewSeen && view === this.view) return;
		this.viewSeen = true;
		this.view = view;
		this.host.log("follow-view", { detail: view ?? "none" });
		this.host.view(view);
	}

	private async tick() {
		if (this.paused) return;
		const o = this.observe();
		this.noteServer(o.server);
		this.noteView(o.gui, o.view);
		if (this.stopped) return; // the host stopped the follower while it handled the restart
		if (o.serverStopped) return this.show("server-stopped", { kind: "server-stopped" });
		if (o.guiStopped) return this.show("gui-stopped", { kind: "gui-stopped" });
		if (o.restarting) {
			this.unansweredSince = undefined;
			return this.note("restarting");
		}
		// moved: the record names a listener other than the one in the window (every new listener draws a new token).
		if (this.failedTarget && !same(o.target, this.failedTarget)) this.failedTarget = undefined; // the record changed
		if (o.target && !same(o.target, this.loaded)) {
			if (same(o.target, this.failedTarget)) this.note(undefined); // given up on this one already: no new 30 s poll, the Start button is the way on
			else {
				this.giveUp = false;
				return this.move(o.target);
			}
		}
		if (this.shown?.startsWith("banner:")) this.note(undefined);
		if (!this.loaded) return; // a screen is showing and nothing new was recorded: the Start button is the way on
		// live or gone: the URL in the window must answer.
		const answer = await probe(urlOf(this.loaded));
		// A suspend that arrived while the probe was out: its answer (or its silence) says nothing about the GUI, and the gone rule must not run `up` for the sleep's gap (T8B-F002).
		if (this.paused || this.stopped) return;
		if (answer === 200) {
			this.unansweredSince = undefined;
			return;
		}
		const now = Date.now();
		this.unansweredSince ??= now;
		if (now - this.unansweredSince < this.timing.goneMs || this.giveUp) return;
		if (now < this.graceUntil) return; // just woke from sleep: the gap is not an unanswered GUI
		this.host.log("follow-gone", { detail: `URL unanswered for ${now - this.unansweredSince} ms, no fresh restart` });
		await this.bringUp("gone");
	}

	/** moved: GET the new URL every movePollMs until it answers 200 (the old one answers 403 from then on), then load it. */
	private async move(target: GuiTarget) {
		this.note("address-changed");
		const url = urlOf(target);
		const deadline = Date.now() + this.timing.moveWaitMs;
		for (;;) {
			if (this.stopped || this.paused) return;
			if ((await probe(url)) === 200) break;
			if (Date.now() >= deadline) {
				this.host.log("follow-move-timeout", { detail: `port ${target.port} did not answer within ${this.timing.moveWaitMs} ms` });
				this.failedTarget = target;
				return; // the next tick looks again; a listener that never answers ends as gone through the old URL's probe
			}
			await new Promise((r) => setTimeout(r, this.timing.movePollMs));
		}
		await this.host.load(url);
		this.loaded = target;
		this.failedTarget = undefined;
		this.unansweredSince = undefined;
		this.shown = undefined;
		this.host.banner(undefined);
		this.host.log("follow-moved", { detail: `loaded port ${target.port}` });
	}

	/** gone: run `up` once, then load its URL; a failure shows the failure screen and waits for the Start button. */
	private async bringUp(why: string) {
		if (this.stopped) return;
		if (this.paused && why === "gone") return; // only the Start button runs `up` through a sleep
		this.note("starting");
		this.host.log("follow-up", { detail: why });
		const r = await this.host.runUp();
		if (this.stopped) return;
		if (!r.ok) {
			this.giveUp = true;
			this.host.banner(undefined);
			this.shown = undefined;
			this.show("failed", { kind: "failed", failure: r.failure });
			return;
		}
		const target = parseGuiUrl(r.url);
		if (!target) {
			this.giveUp = true;
			this.show("failed", { kind: "failed", failure: { kind: "no-url", reason: "the start printed a URL of an unexpected shape" } });
			return;
		}
		await this.host.load(r.url);
		this.loaded = target;
		this.unansweredSince = undefined;
		this.shown = undefined;
		this.host.banner(undefined);
		this.host.log("follow-up-done", { detail: `loaded port ${target.port}` });
		// An `up` that answers `found` with an address that still does not answer would run again every goneMs + a tick: more than 3 such runs in 10 minutes end the loop with the screen and
		// the Start button. Only a run whose loaded address is probed and does not answer 200 counts (S53-F003): a gone page that came back is a recovery, however often it happens.
		if (why !== "gone") return;
		const answered = (await probe(r.url)) === 200;
		if (!answered && !this.stopped && !this.paused && this.goneBudget.hit(Date.now())) {
			this.giveUp = true;
			this.host.log("restart-budget", { which: "gone" });
			this.show("failed", { kind: "failed", failure: { kind: "restart-budget", reason: `the page did not answer after more than ${SERVER_RESTART_MAX} starts in 10 minutes` } });
		}
	}
}
