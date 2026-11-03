import assert from "node:assert/strict";
import { mkdtempSync, renameSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { removeTree } from "../src/main/bootstrap/fsutil.ts";
import type { StartFailure } from "../src/main/runtime/failure.ts";
import { backgroundOf, Follower, parseGuiUrl, readGuiView, urlOf, type BannerKind, type FollowHost, type FollowTiming, type GuiView, type Screen, type ServerIdentity, type UpResult } from "../src/main/runtime/follow.ts";

// The follower (spec: Following the GUI), ported from the kit's headless check (spike/win/proto/test/follow-test.mjs): a fake slot folder and fake GUI listeners, no Electron, no
// sb server. The additions of phase 2 have their own cases: restarts by pid and start time, the `view`, sleep and resume, and the typed failure screen.

const scratch: string[] = [];
const servers: Server[] = [];
after(() => {
	for (const s of servers) {
		s.closeAllConnections?.();
		s.close();
	}
	for (const d of scratch) removeTree(d);
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tok = (n: number) => n.toString(16).padStart(32, "0");
const timing: Partial<FollowTiming> = { tickMs: 40, goneMs: 400, freshMs: 800, moveWaitMs: 1500, movePollMs: 25, resumeGraceMs: 600 };

interface Listener {
	port: number;
	token: string;
	close(): Promise<void>;
}

/** A fake GUI: answers 200 only on its own token's path, 403 on any other (as the real one does after a rotation). */
function listener(token: string, port = 0): Promise<Listener> {
	return new Promise((resolve, reject) => {
		const srv = createServer((req, res) => {
			res.writeHead(req.url === `/${token}/` ? 200 : 403).end("x");
		});
		servers.push(srv);
		srv.once("error", reject);
		srv.listen(port, "127.0.0.1", () => {
			resolve({
				port: (srv.address() as { port: number }).port,
				token,
				close: () =>
					new Promise<void>((done) => {
						srv.close(() => done());
						srv.closeAllConnections?.();
					}),
			});
		});
	});
}

function folder() {
	const dir = mkdtempSync(join(process.env.SBD_TEST_TMP ?? tmpdir(), "follow-"));
	scratch.push(dir);
	const write = (name: string, obj: unknown) => {
		const tmp = join(dir, `${name}.tmp`);
		writeFileSync(tmp, typeof obj === "string" ? obj : JSON.stringify(obj));
		renameSync(tmp, join(dir, name));
	};
	return { dir, write };
}

type Ev = { kind: "load"; url: string } | { kind: "screen"; screen: Screen } | { kind: "banner"; banner: BannerKind | undefined } | { kind: "restarted"; server: ServerIdentity } | { kind: "view"; view: GuiView | undefined } | { kind: "up" } | { kind: "log"; event: string; detail: string };

function fakeHost(nextUp: () => Promise<UpResult> = async () => ({ ok: false, failure: { kind: "other", reason: "no scripted up" } })) {
	const events: Ev[] = [];
	let upCalls = 0;
	const state = { nextUp };
	const host: FollowHost = {
		log: (event, data) => events.push({ kind: "log", event, detail: String(data?.detail ?? "") }),
		load: async (url) => void events.push({ kind: "load", url }),
		screen: (screen) => void events.push({ kind: "screen", screen }),
		banner: (banner) => void events.push({ kind: "banner", banner }),
		runUp: async () => {
			upCalls++;
			events.push({ kind: "up" });
			return state.nextUp();
		},
		restarted: (server) => void events.push({ kind: "restarted", server }),
		view: (view) => void events.push({ kind: "view", view }),
	};
	return {
		host,
		events,
		state,
		get upCalls() {
			return upCalls;
		},
		loads: () => events.filter((e): e is Extract<Ev, { kind: "load" }> => e.kind === "load").map((e) => e.url),
		screens: () => events.filter((e): e is Extract<Ev, { kind: "screen" }> => e.kind === "screen").map((e) => e.screen),
		restarts: () => events.filter((e): e is Extract<Ev, { kind: "restarted" }> => e.kind === "restarted").map((e) => e.server),
		views: () => events.filter((e): e is Extract<Ev, { kind: "view" }> => e.kind === "view").map((e) => e.view),
		banners: () => events.filter((e): e is Extract<Ev, { kind: "banner" }> => e.kind === "banner").map((e) => e.banner),
		logged: (event: string) => events.filter((e) => e.kind === "log" && e.event === event).length,
	};
}

const until = async (what: string, ms: number, condition: () => boolean): Promise<void> => {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (condition()) return;
		await sleep(15);
	}
	throw new Error(`timed out waiting for ${what}`);
};

const failure = (reason = "the sb server did not answer in time"): StartFailure => ({ kind: "start", reason });

describe("the follower (the kit's rules)", () => {
	it("does nothing while the URL answers", async () => {
		const { dir, write } = folder();
		const a = await listener(tok(1));
		write("server.json", { pid: 1, gui: { port: a.port, token: a.token } });
		const h = fakeHost();
		const f = new Follower(dir, h.host, urlOf(a), timing, { pid: 1 });
		f.start();
		await sleep(300);
		f.stop();
		assert.deepEqual(h.loads(), []);
		assert.equal(h.upCalls, 0);
		assert.deepEqual(h.restarts(), []);
	});

	it("moves to a new listener when the record names one, and loads it once", async () => {
		const { dir, write } = folder();
		const a = await listener(tok(1));
		write("server.json", { pid: 1, gui: { port: a.port, token: a.token } });
		const h = fakeHost();
		const f = new Follower(dir, h.host, urlOf(a), timing, { pid: 1 });
		f.start();
		const b = await listener(tok(2));
		write("server.json", { pid: 1, gui: { port: b.port, token: b.token } });
		await until("the move", 3000, () => h.loads().length === 1);
		f.stop();
		assert.deepEqual(h.loads(), [urlOf(b)]);
		assert.ok(h.banners().includes("address-changed"));
		assert.equal(h.banners().at(-1), undefined, "the banner is taken away after the load");
	});

	it("shows the restarting banner for a fresh `restarting` marker and moves when it clears (same port, new token)", async () => {
		const { dir, write } = folder();
		const a = await listener(tok(1));
		write("server.json", { pid: 1, gui: { port: a.port, token: a.token } });
		const h = fakeHost();
		const f = new Follower(dir, h.host, urlOf(a), timing, { pid: 1 });
		f.start();
		await a.close();
		const c = await listener(tok(3), a.port);
		write("server.json", { pid: 1, gui: { port: c.port, token: c.token }, restarting: { since: new Date().toISOString(), reason: "test" } });
		await until("the banner", 2000, () => h.banners().includes("restarting"));
		assert.equal(h.upCalls, 0);
		write("server.json", { pid: 1, gui: { port: c.port, token: c.token } });
		await until("the move", 3000, () => h.loads().length === 1);
		f.stop();
		assert.deepEqual(h.loads(), [urlOf(c)]);
	});

	it("takes an unreadable record as no information", async () => {
		const { dir, write } = folder();
		const a = await listener(tok(1));
		write("server.json", { pid: 1, gui: { port: a.port, token: a.token } });
		const h = fakeHost();
		const f = new Follower(dir, h.host, urlOf(a), timing, { pid: 1 });
		f.start();
		writeFileSync(join(dir, "server.json"), "{ broken");
		writeFileSync(join(dir, "gui.json"), "");
		await sleep(300);
		f.stop();
		assert.equal(h.upCalls, 0);
		assert.deepEqual(h.loads(), []);
		assert.deepEqual(h.restarts(), []);
		assert.deepEqual(h.views(), [], "an unreadable gui.json says nothing about the view");
	});

	it("shows the gui-stopped and server-stopped screens, and the Start button runs `up` once and loads its URL", async () => {
		const { dir, write } = folder();
		const a = await listener(tok(1));
		write("server.json", { pid: 1, gui: { port: a.port, token: a.token } });
		const d = await listener(tok(4));
		const h = fakeHost(async () => {
			write("server.json", { pid: 1, gui: { port: d.port, token: d.token } });
			return { ok: true, url: urlOf(d) };
		});
		const f = new Follower(dir, h.host, urlOf(a), timing, { pid: 1 });
		f.start();
		write("server.json", { pid: 1, gui: { port: a.port, token: a.token, stopped: true } });
		await until("the gui-stopped screen", 2000, () => h.screens().some((s) => s.kind === "gui-stopped"));
		assert.equal(h.upCalls, 0);
		await f.startFromScreen();
		assert.equal(h.upCalls, 1);
		assert.equal(h.loads().at(-1), urlOf(d));
		write("server.json", { pid: 1, stopped: true, gui: { port: d.port, token: d.token } });
		await until("the server-stopped screen", 2000, () => h.screens().some((s) => s.kind === "server-stopped"));
		f.stop();
	});

	it("runs `up` once when the URL stays unanswered with no fresh restart, then loads the URL it printed", async () => {
		const { dir, write } = folder();
		const d = await listener(tok(4));
		write("server.json", { pid: 1, gui: { port: d.port, token: d.token } });
		const e = await listener(tok(5));
		const h = fakeHost(async () => {
			write("server.json", { pid: 1, gui: { port: e.port, token: e.token } });
			return { ok: true, url: urlOf(e) };
		});
		const f = new Follower(dir, h.host, urlOf(d), timing, { pid: 1 });
		f.start();
		await sleep(200);
		await d.close();
		await until("the gone `up`", 4000, () => h.upCalls === 1 && h.loads().length === 1);
		await sleep(300);
		f.stop();
		assert.equal(h.upCalls, 1, "one up for one loss");
		assert.equal(h.loads().at(-1), urlOf(e));
		assert.ok(h.logged("follow-gone") >= 1);
	});

	it("shows the typed failure once when `up` fails, and runs no further `up` until the Start button", async () => {
		const { dir, write } = folder();
		const d = await listener(tok(4));
		write("server.json", { pid: 1, gui: { port: d.port, token: d.token } });
		const failed = failure();
		const h = fakeHost(async () => ({ ok: false, failure: failed }));
		const f = new Follower(dir, h.host, urlOf(d), timing, { pid: 1 });
		f.start();
		await d.close();
		await until("the failed screen", 4000, () => h.screens().some((s) => s.kind === "failed"));
		const ups = h.upCalls;
		assert.equal(ups, 1);
		const screen = h.screens().find((s) => s.kind === "failed");
		assert.deepEqual(screen, { kind: "failed", failure: failed });
		await sleep(700);
		assert.equal(h.upCalls, ups, "no automatic retry after a failure");
		f.stop();
	});

	// T8B-F003. `up` answers `found` with the same address and the page still does not answer: without a budget `up` ran every ~goneMs for ever and the GUI never showed a screen.
	it("stops running `up` when the page stays unanswered after 3 gone-rule starts, shows the restart-budget screen, and the Start button begins a fresh budget", async () => {
		const { dir, write } = folder();
		const dead = await listener(tok(4)); // answers 403 on any other token's path
		const wrong = tok(6);
		write("server.json", { pid: 1, gui: { port: dead.port, token: wrong } });
		const h = fakeHost(async () => ({ ok: true, url: `http://127.0.0.1:${dead.port}/${wrong}/` }));
		const f = new Follower(dir, h.host, `http://127.0.0.1:${dead.port}/${wrong}/`, timing, { pid: 1 });
		f.start();
		try {
			await until("the budget screen", 8000, () => h.screens().some((s) => s.kind === "failed"));
			const screen = h.screens().find((s) => s.kind === "failed");
			assert.equal(screen?.kind === "failed" ? screen.failure.kind : "", "restart-budget");
			assert.equal(h.upCalls, 4, "3 starts are inside the budget; the 4th ends it");
			await sleep(timing.goneMs! * 3);
			assert.equal(h.upCalls, 4, "no automatic `up` after the screen");
			await f.startFromScreen();
			await until("the Start button's `up`", 2000, () => h.upCalls === 5);
		} finally {
			f.stop();
		}
	});

	it("gives up on a target that never answers once, and a Start press during a move is not lost", async () => {
		const { dir, write } = folder();
		const dead = await listener(tok(6));
		const deadPort = dead.port;
		await dead.close();
		const a = await listener(tok(1));
		write("server.json", { pid: 1, gui: { port: a.port, token: a.token } });
		const g = await listener(tok(7));
		const h = fakeHost(async () => {
			write("server.json", { pid: 1, gui: { port: g.port, token: g.token } });
			return { ok: true, url: urlOf(g) };
		});
		const f = new Follower(dir, h.host, urlOf(a), { ...timing, moveWaitMs: 500 }, { pid: 1 });
		f.start();
		write("server.json", { pid: 1, gui: { port: deadPort, token: tok(6) } });
		await until("the move to give up", 3000, () => h.logged("follow-move-timeout") === 1);
		await sleep(1200);
		assert.equal(h.logged("follow-move-timeout"), 1, "a given-up target is not polled again");
		// A press while a move runs waits behind it.
		const dead2 = await listener(tok(8));
		const dead2Port = dead2.port;
		await dead2.close();
		write("server.json", { pid: 1, gui: { port: dead2Port, token: tok(8) } });
		await sleep(150);
		void f.startFromScreen();
		await until("the Start press to run", 4000, () => h.upCalls === 1);
		f.stop();
		assert.equal(h.loads().at(-1), urlOf(g));
	});

	it("starts nothing after stop(), even for a queued Start press", async () => {
		const { dir, write } = folder();
		const a = await listener(tok(1));
		write("server.json", { pid: 1, gui: { port: a.port, token: a.token } });
		let release: () => void = () => undefined;
		const h = fakeHost(
			() =>
				new Promise<UpResult>((resolve) => {
					release = () => resolve({ ok: false, failure: failure("x") });
				}),
		);
		const f = new Follower(dir, h.host, urlOf(a), timing, { pid: 1 });
		const first = f.startFromScreen();
		await sleep(50);
		void f.startFromScreen();
		f.stop();
		release();
		await first;
		await sleep(200);
		assert.equal(h.upCalls, 1);
		await f.startFromScreen();
		assert.equal(h.upCalls, 1, "a stopped follower does not start");
	});

	it("logs no page token", async () => {
		const { dir, write } = folder();
		const a = await listener(tok(1));
		write("server.json", { pid: 1, gui: { port: a.port, token: a.token } });
		const b = await listener(tok(2));
		const h = fakeHost();
		const f = new Follower(dir, h.host, urlOf(a), timing, { pid: 1 });
		f.start();
		write("server.json", { pid: 2, gui: { port: b.port, token: b.token } });
		await until("the move", 3000, () => h.loads().length === 1);
		f.stop();
		for (const e of h.events) if (e.kind === "log") assert.ok(!/[0-9a-f]{32}/.test(e.detail), `a token in a log line: ${e.detail}`);
	});

	it("parses only a GUI address of its own shape", () => {
		assert.deepEqual(parseGuiUrl(`http://127.0.0.1:41234/${tok(1)}/`), { port: 41234, token: tok(1) });
		assert.equal(parseGuiUrl("http://127.0.0.1:1/zz/"), undefined);
		assert.equal(parseGuiUrl(`http://example.com:1/${tok(1)}/`), undefined);
		assert.equal(parseGuiUrl(`http://localhost:1/${tok(1)}/`), undefined);
	});
});

describe("restarts (spec: Following the GUI, Restarts)", () => {
	it("hands the host a new pid once, and a new start time of the same pid too; the same identity says nothing", async () => {
		const { dir, write } = folder();
		const a = await listener(tok(1));
		const gui = { port: a.port, token: a.token };
		write("server.json", { pid: 10, started: "T1", gui });
		const h = fakeHost();
		const f = new Follower(dir, h.host, urlOf(a), timing, { pid: 10, started: "T1" });
		f.start();
		await sleep(200);
		assert.deepEqual(h.restarts(), []);
		write("server.json", { pid: 11, started: "T2", gui });
		await until("the pid change", 2000, () => h.restarts().length === 1);
		await sleep(150);
		assert.deepEqual(h.restarts(), [{ pid: 11, started: "T2" }], "reported once, not at every tick");
		write("server.json", { pid: 11, started: "T3", gui });
		await until("the start-time change", 2000, () => h.restarts().length === 2);
		f.stop();
		assert.deepEqual(h.restarts().at(-1), { pid: 11, started: "T3" });
		assert.ok(h.logged("follow-restart") >= 2, "a change is logged as a restart");
	});

	it("starts from the pid it is given: a record that names the same pid is not a restart, and one that names another is, at the first tick", async () => {
		const { dir, write } = folder();
		const a = await listener(tok(1));
		const gui = { port: a.port, token: a.token };
		write("server.json", { pid: 10, started: "T1", gui });
		const same = fakeHost();
		const f1 = new Follower(dir, same.host, urlOf(a), timing, { pid: 10 });
		f1.start();
		await sleep(200);
		f1.stop();
		assert.deepEqual(same.restarts(), []);
		const other = fakeHost();
		const f2 = new Follower(dir, other.host, urlOf(a), timing, { pid: 9 });
		f2.start();
		await until("the first tick", 2000, () => other.restarts().length === 1);
		f2.stop();
		assert.deepEqual(other.restarts(), [{ pid: 10, started: "T1" }]);
	});

	it("adopt() takes the pid an `up` of the app printed, so the restart it caused is not reported again", async () => {
		const { dir, write } = folder();
		const a = await listener(tok(1));
		const b = await listener(tok(2));
		write("server.json", { pid: 10, gui: { port: a.port, token: a.token } });
		const h = fakeHost();
		const f = new Follower(dir, h.host, urlOf(a), timing, { pid: 10 });
		f.start();
		await sleep(100);
		f.adopt(urlOf(b), { pid: 12 });
		write("server.json", { pid: 12, gui: { port: b.port, token: b.token } });
		await sleep(300);
		f.stop();
		assert.deepEqual(h.restarts(), []);
		assert.deepEqual(h.loads(), [], "the adopted page is the loaded one: nothing to move to");
	});
});

describe("the view (spec: Following the GUI, The view)", () => {
	it("tells the host the view when it first shows and whenever it changes, and a missing view as undefined", async () => {
		const { dir, write } = folder();
		const a = await listener(tok(1));
		const gui = { port: a.port, token: a.token };
		write("server.json", { pid: 1, gui });
		write("gui.json", { ...gui, csrf: "c", view: "geek" });
		const h = fakeHost();
		const f = new Follower(dir, h.host, urlOf(a), timing, { pid: 1 });
		f.start();
		await until("geek", 2000, () => h.views().length === 1);
		write("gui.json", { ...gui, csrf: "c", view: "zen" });
		await until("zen", 2000, () => h.views().length === 2);
		write("gui.json", { ...gui, csrf: "c", view: "mystery" });
		await until("an unknown view reads as none", 2000, () => h.views().length === 3);
		write("gui.json", { ...gui, csrf: "c" });
		await sleep(250);
		f.stop();
		assert.deepEqual(h.views(), ["geek", "zen", undefined], "each change once; an absent view after an unknown one is still none");
	});

	it("does not repeat the view the window was painted with", async () => {
		const { dir, write } = folder();
		const a = await listener(tok(1));
		const gui = { port: a.port, token: a.token };
		write("server.json", { pid: 1, gui });
		write("gui.json", { ...gui, view: "geek" });
		const h = fakeHost();
		const f = new Follower(dir, h.host, urlOf(a), timing, { pid: 1 }, "geek");
		f.start();
		await sleep(250);
		f.stop();
		assert.deepEqual(h.views(), []);
	});

	it("reads the view from gui.json and colours the window: geek black, zen the Zen page's own ground, anything else the page's --bg", () => {
		const { dir, write } = folder();
		assert.equal(readGuiView(dir), undefined);
		write("gui.json", { port: 1, token: "x", view: "zen" });
		assert.equal(readGuiView(dir), "zen");
		write("gui.json", { port: 1, token: "x", view: "nope" });
		assert.equal(readGuiView(dir), undefined);
		assert.equal(backgroundOf("geek"), "#000000");
		assert.equal(backgroundOf("zen"), "#14110e");
		assert.equal(backgroundOf("standard"), "#16161e");
		assert.equal(backgroundOf(undefined), "#16161e");
	});
});

describe("sleep and resume (spec: Crash and sleep)", () => {
	it("reads and probes nothing while paused, and gives the URL a grace period after resume before the gone rule applies", async () => {
		const { dir, write } = folder();
		const a = await listener(tok(1));
		write("server.json", { pid: 1, gui: { port: a.port, token: a.token } });
		const e = await listener(tok(5));
		const h = fakeHost(async () => {
			write("server.json", { pid: 1, gui: { port: e.port, token: e.token } });
			return { ok: true, url: urlOf(e) };
		});
		const f = new Follower(dir, h.host, urlOf(a), timing, { pid: 1 });
		f.start();
		await sleep(150);
		f.pause();
		await a.close();
		await sleep(timing.goneMs! + 400);
		assert.equal(h.upCalls, 0, "a paused follower does not call the sleep's gap an unanswered GUI");
		f.resume();
		await sleep(timing.goneMs! - 100);
		assert.equal(h.upCalls, 0, "inside the grace period the gone rule is off");
		assert.ok(h.logged("follow-pause") === 1 && h.logged("follow-resume") === 1);
		await until("the gone rule after the grace period", 4000, () => h.upCalls === 1);
		f.stop();
	});

	it("runs no `up` when the URL is only briefly down across a suspend and resume", async () => {
		const { dir, write } = folder();
		const a = await listener(tok(1));
		write("server.json", { pid: 1, gui: { port: a.port, token: a.token } });
		const h = fakeHost();
		const f = new Follower(dir, h.host, urlOf(a), timing, { pid: 1 });
		f.start();
		await sleep(150);
		f.pause();
		await a.close();
		await sleep(200);
		f.resume();
		const back = await listener(tok(1), a.port);
		await sleep(timing.resumeGraceMs! + timing.goneMs! + 400);
		f.stop();
		assert.equal(h.upCalls, 0);
		assert.deepEqual(h.screens(), []);
		await back.close();
	});

	// T8B-F002. A tick already waiting for its probe when `suspend` arrives must not go on to the gone rule: the URL was down before the sleep, and the sleep's gap would pass the 10 s.
	it("runs no `up` for a tick whose probe was out when the computer went to sleep", async () => {
		const { dir, write } = folder();
		let mode: "ok" | "refuse" | "hold" = "ok";
		const held: Array<() => void> = [];
		const token = tok(1);
		const srv = createServer((req, res) => {
			if (mode === "ok") return void res.writeHead(200).end("x");
			if (mode === "refuse") return void res.writeHead(403).end("x");
			held.push(() => res.writeHead(403).end("x"));
		});
		servers.push(srv);
		await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
		const port = (srv.address() as { port: number }).port;
		write("server.json", { pid: 1, gui: { port, token } });
		const h = fakeHost();
		const f = new Follower(dir, h.host, `http://127.0.0.1:${port}/${token}/`, timing, { pid: 1 });
		f.start();
		await sleep(150);
		mode = "refuse";
		await sleep(timing.goneMs! - 150); // unanswered for almost goneMs, still short of it
		mode = "hold"; // the next tick's probe is out and silent
		await until("a probe in flight", 2000, () => held.length > 0);
		f.pause();
		await sleep(250); // the gap: unansweredSince is now older than goneMs
		for (const answer of held.splice(0)) answer();
		await sleep(300);
		f.stop();
		assert.equal(h.upCalls, 0, "the probe that finished after suspend started no `up`");
		assert.equal(h.logged("follow-gone"), 0);
		for (const answer of held.splice(0)) answer();
	});

	it("reads the slot folder again at resume: a restart that happened during the sleep is seen", async () => {
		const { dir, write } = folder();
		const a = await listener(tok(1));
		const gui = { port: a.port, token: a.token };
		write("server.json", { pid: 1, gui });
		const h = fakeHost();
		const f = new Follower(dir, h.host, urlOf(a), timing, { pid: 1 });
		f.start();
		await sleep(100);
		f.pause();
		write("server.json", { pid: 2, gui });
		await sleep(250);
		assert.deepEqual(h.restarts(), [], "nothing is read while paused");
		f.resume();
		await until("the restart after resume", 2000, () => h.restarts().length === 1);
		f.stop();
	});
});

describe("banners are kinds, not strings", () => {
	it("says restarting, address-changed and starting as kinds the catalog words", async () => {
		const { dir, write } = folder();
		const a = await listener(tok(1));
		write("server.json", { pid: 1, gui: { port: a.port, token: a.token } });
		const d = await listener(tok(9));
		const h = fakeHost(async () => {
			write("server.json", { pid: 1, gui: { port: d.port, token: d.token } });
			return { ok: true, url: urlOf(d) };
		});
		const f = new Follower(dir, h.host, urlOf(a), timing, { pid: 1 });
		f.start();
		write("server.json", { pid: 1, gui: { port: a.port, token: a.token, stopped: true } });
		await until("the screen", 2000, () => h.screens().length === 1);
		await f.startFromScreen();
		f.stop();
		assert.ok(h.banners().every((b) => b === undefined || ["restarting", "address-changed", "starting"].includes(b)));
		assert.ok(h.banners().includes("starting"));
	});
});
