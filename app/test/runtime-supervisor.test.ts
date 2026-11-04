import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { removeTree } from "../src/main/bootstrap/fsutil.ts";
import { herdrBinary } from "../src/main/paths.ts";
import { StartFailureError, type StartFailure } from "../src/main/runtime/failure.ts";
import { fingerprintOf, type StartRecord } from "../src/main/runtime/start-file.ts";
import { Supervisor, StackBusyError, type SupervisorDeps, type SupervisorEvent } from "../src/main/runtime/supervisor.ts";
import { scratchRoot, testLayout } from "./harness/engine-fixture.ts";
import { FakeChild, FakeProcesses, fakeClock, installFake, scriptedRun, type Call } from "./harness/runtime-fakes.ts";

// The supervisor's start, stop, and restart with every program scripted (spec: Start, Stop, Start times; the 8a unit tests). No real Herdr, sb server, or pi is
// started and the real process table is never read.

const scratch: string[] = [];
const listeners: Server[] = [];
after(() => {
	for (const l of listeners) {
		l.closeAllConnections?.();
		l.close();
	}
	for (const d of scratch) removeTree(d);
});

const TOKEN = "0123456789abcdef0123456789abcdef";
const URL = `http://127.0.0.1:41234/${TOKEN}/`;

interface WorldOptions {
	install?: boolean;
	eager?: boolean;
	checkPane?: SupervisorDeps["checkPane"];
	resolveProxy?: SupervisorDeps["resolveProxy"];
	herdrUp?: boolean;
	timeouts?: SupervisorDeps["timeouts"];
	stopTimeouts?: SupervisorDeps["stopTimeouts"];
	/** Turns the follower on, with this timing (the supervisor's follower cases). */
	follow?: SupervisorDeps["follow"];
	forges?: Array<{ kind: "github" | "gitlab"; host: string }>;
	/** Runs when Herdr is spawned / when `up` runs (before it answers): a test changes the world in the middle of a start. */
	onSpawn?: () => void;
	onUp?: () => void;
}

function world(options: WorldOptions = {}) {
	const made = scratchRoot("sbd-sup-");
	scratch.push(made.base);
	const layout = testLayout(made.root);
	const installed = options.install === false ? null : installFake(layout);
	const herdrBin = installed?.herdr ?? "herdr";
	const exe = (name: string) => join(layout.tools.root, name, "1.0.0", name);
	const procs = new FakeProcesses();
	const clock = fakeClock();
	const events: SupervisorEvent[] = [];
	const log: Array<Record<string, unknown>> = [];
	const children: FakeChild[] = [];
	const spawnOptions: Array<{ file: string; args: readonly string[]; options: Record<string, unknown>; env: Record<string, string> }> = [];
	let herdrUp = options.herdrUp ?? false;
	let nextHerdrPid = 100;
	let sbPid = 200;
	const upQueue: Array<Partial<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }>> = [];
	const sb = {
		get pid() {
			return sbPid;
		},
		set pid(value: number) {
			sbPid = value;
		},
	};
	const upOk = (over: Record<string, unknown> = {}) => ({
		code: 0,
		stdout: `${JSON.stringify({ url: URL, pid: sbPid, started: "x", log: join(layout.agent, "straw-boss", "server.log"), desk: true, server: "started", version: "0.51.0", workspace: "w1", pane: "p1", tower: "t1", created: true, integration: "installed", warnings: [], ...over })}\n`,
	});
	const order: string[] = [];
	const run = scriptedRun([
		{ match: (c) => c.file === herdrBin && c.args[0] === "workspace", answer: () => ({ code: herdrUp ? 0 : 1 }) },
		{
			match: (c) => c.file === herdrBin && c.args[0] === "server" && c.args[1] === "stop",
			answer: () => {
				order.push("herdr server stop");
				herdrUp = false;
				for (const child of children) if (child.exitCode === null) child.end(0);
				return { code: 0 };
			},
		},
		{
			match: (c) => c.args[1] === "up",
			answer: () => {
				order.push("up");
				options.onUp?.();
				const next = upQueue.shift() ?? upOk();
				if (next.code === 0 || next.code === undefined) {
					if (!procs.has(sbPid)) procs.add(sbPid, { startTime: `S${sbPid}`, executable: exe("node") });
				}
				return next;
			},
		},
		{
			match: (c) => c.args[1] === "stop",
			answer: () => {
				order.push("cli stop");
				procs.table.delete(sbPid);
				return { code: 0, stdout: '{"outcome":"stopped"}\n', stderr: "Stopping the sb server on purpose\n" };
			},
		},
		{ match: (c) => c.args[1] === "restart" || c.args[1] === "logs", answer: { code: 0 } },
	]);
	const spawn: SupervisorDeps["spawn"] = (file, args, spawnOpts) => {
		const child = new FakeChild(nextHerdrPid++);
		children.push(child);
		spawnOptions.push({ file, args, options: { detached: spawnOpts.detached, stdio: spawnOpts.stdio, windowsHide: spawnOpts.windowsHide }, env: { ...(spawnOpts.env as Record<string, string>) } });
		procs.add(child.pid as number, { startTime: `H${child.pid}`, executable: herdrBin });
		order.push(`spawn herdr ${child.pid}`);
		herdrUp = true;
		options.onSpawn?.();
		child.onKill = () => {
			procs.table.delete(child.pid as number);
			herdrUp = false;
		};
		child.once("exit", () => {
			procs.table.delete(child.pid as number);
			herdrUp = false;
		});
		return child;
	};
	const workFolder = join(made.base, "work 測試");
	const syncExits: Array<{ file: string; args: readonly string[]; timeoutMs: number }> = [];
	const deps: SupervisorDeps = {
		layout,
		home: made.base,
		platform: { processes: procs, locate: { system: () => "unused", onPath: () => null } },
		run,
		spawn,
		appEnv: { HOME: made.base, PATH: "/usr/bin", SSH_AUTH_SOCK: "/tmp/agent.sock", GH_TOKEN: "ghp_leak", PI_SUBAGENT_ID: "x", HERDR_PANE_ID: "p9" },
		config: () => ({ workFolder, homeBaseLabel: "Straw Boss", forges: options.forges ?? [], optionalTools: [] }),
		log: (f) => log.push(f),
		clock,
		eagerStartTimes: options.eager ?? true,
		timeouts: { ...options.timeouts },
		pidAlive: (pid) => procs.has(pid),
		isOurEngine: () => false,
		runSync: (file, args, o) => {
			syncExits.push({ file, args, timeoutMs: o.timeoutMs });
			return { code: 0 };
		},
		...(options.stopTimeouts ? { stopTimeouts: options.stopTimeouts } : {}),
		...(options.follow ? { follow: options.follow } : {}),
		...(options.checkPane ? { checkPane: options.checkPane } : {}),
		...(options.resolveProxy ? { resolveProxy: options.resolveProxy } : {}),
	};
	const supervisor = new Supervisor(deps);
	supervisor.on((e) => events.push(e));
	const startRecord = (): StartRecord | null => supervisor.startFile.read();
	const callsOf = (arg: string): Call[] => run.calls.filter((c) => c.args.includes(arg));
	return { layout, procs, clock, events, log, children, spawnOptions, supervisor, run, upQueue, upOk, sb, order, workFolder, startRecord, callsOf, installed, exe, herdrBin, deps, syncExits, setHerdrUp: (v: boolean) => (herdrUp = v) };
}

const failureOf = async (p: Promise<unknown>): Promise<StartFailure> => {
	try {
		await p;
	} catch (error) {
		assert.ok(error instanceof StartFailureError, String(error));
		return error.failure;
	}
	throw new Error("expected the start to fail");
};

const record = (status: string, extra: Record<string, unknown> = {}) => ({ status, version: "1.0.0", evidence: "", at: "t", hashes: {}, dependsOn: {}, ...extra });
const stack = { "pkg:pi-straw-boss": record("ok"), "pkg:pi-intercom": record("ok") };

const until = async (condition: () => boolean, what: string): Promise<void> => {
	for (let i = 0; i < 400; i++) {
		if (condition()) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error(`timed out waiting for ${what}`);
};

const urlEvents = (events: SupervisorEvent[]) => events.filter((e): e is Extract<SupervisorEvent, { type: "gui-url" }> => e.type === "gui-url");

describe("a start that cannot begin", () => {
	it("says the install is not finished, runs and spawns nothing, and offers Repair", async () => {
		const w = world({ install: false });
		const failure = await failureOf(w.supervisor.start());
		assert.equal(failure.kind, "tool-missing");
		assert.equal(failure.offerRepair, true);
		assert.deepEqual(w.run.calls, []);
		assert.deepEqual(w.children, []);
		assert.equal(w.supervisor.state, "failed");
		assert.ok(w.events.some((e) => e.type === "failure" && e.failure.kind === "tool-missing"));
	});

	it("refuses to start while a stage record carries a startBlock (T7-F002), shows its sentence, and runs nothing", async () => {
		const w = world();
		const sentence = "The package @acme/skills could not be removed and may still load. Run Repair.";
		writeFileSync(join(w.layout.state, "bootstrap.json"), JSON.stringify({ schema: 1, stages: { ...stack, "team-pkg:@acme/skills": { status: "failed", version: "1.0.0", evidence: "", at: "t", hashes: {}, dependsOn: {}, startBlock: { kind: "package-may-load", package: "@acme/skills", sentence } } } }));
		const failure = await failureOf(w.supervisor.start());
		assert.equal(failure.kind, "package-unsafe");
		assert.equal(failure.reason, sentence);
		assert.equal(failure.offerRepair, true);
		assert.deepEqual(w.run.calls, []);
		assert.deepEqual(w.children, []);
		// The next successful run of the stage writes a record without it, and the start goes on.
		writeFileSync(join(w.layout.state, "bootstrap.json"), JSON.stringify({ schema: 1, stages: { ...stack, "team-pkg:@acme/skills": { status: "ok", version: "1.0.0", evidence: "", at: "t", hashes: {}, dependsOn: {} } } }));
		assert.equal((await w.supervisor.start()).url, URL);
	});

	it("refuses to start for a package stage left `running` when no engine owns it (R7-F001), and not while an engine holds the lock", async () => {
		for (const stage of ["profile", "pkg:pi-lens", "team-pkg:@acme/skills"]) {
			const w = world();
			writeFileSync(join(w.layout.state, "bootstrap.json"), JSON.stringify({ schema: 1, stages: { ...stack, [stage]: record("running") } }));
			const failure = await failureOf(w.supervisor.start());
			assert.equal(failure.kind, "install-interrupted", stage);
			assert.equal(failure.reason, stage);
			assert.equal(failure.offerRepair, true);
			assert.deepEqual(w.run.calls, []);
			assert.deepEqual(w.children, []);
		}
		// A tool stage that is `running` is not an in-place package write, and the engine's own lock wins: the start says an engine is running.
		const tool = world();
		writeFileSync(join(tool.layout.state, "bootstrap.json"), JSON.stringify({ schema: 1, stages: { ...stack, node: record("running") } }));
		assert.equal((await tool.supervisor.start()).url, URL);
		const held = world();
		writeFileSync(join(held.layout.state, "bootstrap.json"), JSON.stringify({ schema: 1, stages: { ...stack, "pkg:pi-lens": record("running") } }));
		writeFileSync(join(held.layout.state, "engine.lock"), `${JSON.stringify({ pid: 777, startTime: "T", token: "t" })}\n`);
		held.procs.add(777, { startTime: "T", executable: "/usr/bin/sleep" });
		assert.equal((await failureOf(held.supervisor.start())).kind, "engine-locked");
	});

	it("does not run the stack package's cli.mjs unless its stage is ok (R7-F002): failed, absent, running, or no record", async () => {
		for (const stages of [{ ...stack, "pkg:pi-straw-boss": record("failed") }, { ...stack, "pkg:pi-straw-boss": record("absent") }, { ...stack, "pkg:pi-straw-boss": record("pending") }, { "pkg:pi-intercom": record("ok") }]) {
			const w = world();
			writeFileSync(join(w.layout.state, "bootstrap.json"), JSON.stringify({ schema: 1, stages }));
			const failure = await failureOf(w.supervisor.start());
			assert.equal(failure.kind, "package-unsafe", JSON.stringify(stages));
			assert.match(failure.reason, /pi-straw-boss is not installed and verified/);
			assert.equal(failure.offerRepair, true);
			assert.deepEqual(w.run.calls, [], "cli.mjs was not run");
			assert.deepEqual(w.children, []);
		}
	});

	it("does not run pi-intercom's code unless its stage is ok either (T8A-F003): the sb server loads it from node_modules without pi", async () => {
		for (const intercom of [record("failed", { lastFailure: { category: "integrity" } }), record("absent"), record("running"), record("pending"), undefined]) {
			const w = world();
			// The unaccepted tarball's files are in place, as after a failed lock check with a failed `pi remove`.
			mkdirSync(join(w.layout.agent, "npm", "node_modules", "pi-intercom", "broker"), { recursive: true });
			writeFileSync(join(w.layout.agent, "npm", "node_modules", "pi-intercom", "broker", "client.ts"), "// unaccepted tarball");
			writeFileSync(join(w.layout.state, "bootstrap.json"), JSON.stringify({ schema: 1, stages: { "pkg:pi-straw-boss": record("ok"), ...(intercom ? { "pkg:pi-intercom": intercom } : {}) } }));
			const failure = await failureOf(w.supervisor.start());
			// a `running` record is also an interrupted package install, which the gate names first
			assert.match(failure.kind, /^(package-unsafe|install-interrupted)$/, JSON.stringify(intercom));
			if (failure.kind === "package-unsafe") assert.match(failure.reason, /pi-intercom is not installed and verified/);
			assert.equal(failure.offerRepair, true);
			assert.deepEqual(w.run.calls, [], "cli.mjs was not run");
			assert.deepEqual(w.children, [], "no Herdr, so no pane starts pi");
		}
		// Both direct packages are named when both are unverified.
		const both = world();
		writeFileSync(join(both.layout.state, "bootstrap.json"), JSON.stringify({ schema: 1, stages: { "pkg:pi-straw-boss": record("failed"), "pkg:pi-intercom": record("failed") } }));
		const failure = await failureOf(both.supervisor.start());
		assert.match(failure.reason, /pi-straw-boss is not installed and verified.*pi-intercom is not installed and verified/);
	});

	it("sees a start block or an unreadable file that an engine writes while the engine lock is checked (T8A-F002)", async () => {
		const block = { kind: "package-may-load", package: "foo", sentence: "foo may still load" };
		const writes: Array<[string, (w: ReturnType<typeof world>) => void, RegExp]> = [
			["a start block", (w) => writeFileSync(join(w.layout.state, "bootstrap.json"), JSON.stringify({ schema: 1, stages: { ...stack, "team-pkg:foo": record("failed", { startBlock: block }) } })), /^package-unsafe$/],
			["a file that cannot be read", (w) => writeFileSync(join(w.layout.state, "bootstrap.json"), "{ truncated"), /^state-unreadable$/],
		];
		for (const [what, write, kind] of writes) {
			const w = world();
			// At the first look an engine is still running (team-pkg:foo `running`, its lock held by pid 4242). While the lock's owner is looked up the engine finishes: it writes
			// `what`, releases the lock, and exits.
			writeFileSync(join(w.layout.state, "bootstrap.json"), JSON.stringify({ schema: 1, stages: { ...stack, "team-pkg:foo": record("running") } }));
			writeFileSync(join(w.layout.state, "engine.lock"), `${JSON.stringify({ pid: 4242, startTime: "E1", token: "t" })}\n`);
			const inspect = w.procs.inspect.bind(w.procs);
			w.procs.inspect = async (pids) => {
				if (pids.includes(4242)) {
					write(w);
					rmSync(join(w.layout.state, "engine.lock"));
				}
				return inspect(pids);
			};
			const failure = await failureOf(w.supervisor.start());
			assert.match(failure.kind, kind, what);
			assert.equal(failure.offerRepair, true, what);
			assert.deepEqual(w.children, [], `${what}: Herdr was not started`);
			assert.deepEqual(w.run.calls, [], `${what}: nothing ran`);
		}
	});

	it("checks again right before Herdr starts and right before `up`: a block written while a start sets up stops it (T8A-F002)", async () => {
		const block = { kind: "package-may-load", package: "foo", sentence: "foo may still load" };
		const withBlock = (w: { layout: { state: string } }) => writeFileSync(join(w.layout.state, "bootstrap.json"), JSON.stringify({ schema: 1, stages: { ...stack, "team-pkg:foo": record("failed", { startBlock: block }) } }));
		// While Herdr is spawned (after the gate before it): `up` must not run.
		let during: ReturnType<typeof world> | undefined;
		const spawned = world({ onSpawn: () => during && withBlock(during) });
		during = spawned;
		const failure = await failureOf(spawned.supervisor.start());
		assert.equal(failure.kind, "package-unsafe");
		assert.equal(failure.reason, "foo may still load");
		assert.equal(spawned.callsOf("up").length, 0, "cli.mjs up did not run");
		assert.deepEqual(spawned.order, ["spawn herdr 100"]);
		// Before Herdr is started: the block lands while the OS proxy is resolved.
		let early: ReturnType<typeof world> | undefined;
		const proxied = world({ resolveProxy: async () => { if (early) withBlock(early); return "DIRECT"; } });
		early = proxied;
		assert.equal((await failureOf(proxied.supervisor.start())).kind, "package-unsafe");
		assert.deepEqual(proxied.children, [], "no Herdr, so no pane starts pi");
		assert.deepEqual(proxied.order, []);
	});

	it("refuses `upOnce` and the Herdr restart while a block stands, and `up` and a new Herdr do not run (T8A-F002)", async () => {
		const block = { kind: "package-may-load", package: "foo", sentence: "foo may still load" };
		const withBlock = (w: { layout: { state: string } }) => writeFileSync(join(w.layout.state, "bootstrap.json"), JSON.stringify({ schema: 1, stages: { ...stack, "team-pkg:foo": record("failed", { startBlock: block }) } }));
		const once = world();
		await once.supervisor.start();
		withBlock(once);
		const before = once.order.length;
		assert.equal((await failureOf(once.supervisor.upOnce())).kind, "package-unsafe");
		assert.equal(once.order.length, before, "upOnce ran no `up`");

		const restart = world();
		await restart.supervisor.start();
		withBlock(restart);
		restart.children[0]?.end(137);
		await until(() => restart.supervisor.state === "failed", "the restart to be refused");
		assert.equal(restart.children.length, 1, "no second Herdr");
		assert.ok(restart.events.some((e) => e.type === "failure" && e.failure.kind === "package-unsafe"));
		assert.deepEqual(restart.order, ["spawn herdr 100", "up"]);
	});

	it("checks before it stops and starts its own Herdr again for a silent one, and says why (T8A-F002)", async () => {
		const block = { kind: "package-may-load", package: "foo", sentence: "foo may still load" };
		let w: ReturnType<typeof world> | undefined;
		w = world({
			onUp: () => {
				if (!w) return;
				// `up` finds Herdr silent: the socket stops answering, and a block has landed.
				w.setHerdrUp(false);
				writeFileSync(join(w.layout.state, "bootstrap.json"), JSON.stringify({ schema: 1, stages: { ...stack, "team-pkg:foo": record("failed", { startBlock: block }) } }));
			},
		});
		w.upQueue.push({ code: 1, stderr: `${JSON.stringify({ step: "herdr", reason: "no answer on the socket" })}\n` });
		const failure = await failureOf(w.supervisor.start());
		assert.equal(failure.kind, "package-unsafe", "the block is the reason, not 'herdr'");
		assert.equal(w.children.length, 1, "no second Herdr");
		assert.deepEqual(w.children[0]?.signals, [], "the running one was not killed for a restart that is refused");
	});

	it("never starts blind on a bootstrap.json it cannot read or that the engine quarantined (R7-F007)", async () => {
		for (const text of ["{ truncated", "[]", JSON.stringify({ schema: 1, stages: [] }), JSON.stringify({ schema: 1, stages: { ...stack, "pkg:pi-straw-boss": "weird" } })]) {
			const w = world();
			writeFileSync(join(w.layout.state, "bootstrap.json"), text);
			const failure = await failureOf(w.supervisor.start());
			assert.equal(failure.kind, "state-unreadable", text);
			assert.equal(failure.offerRepair, true);
			assert.deepEqual(w.run.calls, []);
		}
		const quarantined = world();
		rmSync(join(quarantined.layout.state, "bootstrap.json"));
		writeFileSync(join(quarantined.layout.state, "bootstrap.json.corrupt-1"), "{ was damaged");
		assert.equal((await failureOf(quarantined.supervisor.start())).kind, "state-unreadable");
	});

	it("reports an engine lock it cannot take in one plain sentence and offers Repair, which removes a lock whose owner is not an engine of this root", async () => {
		const w = world();
		mkdirSync(w.layout.state, { recursive: true });
		const lock = join(w.layout.state, "engine.lock");
		// A lock written while the engine could not read its own start time, now held by any process that has that pid.
		writeFileSync(lock, `${JSON.stringify({ pid: 777, startTime: null, token: "t" })}\n`);
		w.procs.add(777, { startTime: "whatever", executable: "/usr/bin/sleep" });
		const failure = await failureOf(w.supervisor.start());
		assert.equal(failure.kind, "engine-locked");
		assert.equal(failure.offerRepair, true);
		assert.match(failure.reason, /Run Repair/);
		assert.deepEqual(w.children, []);

		// An engine this app holds keeps its lock.
		const holding = new Supervisor({ ...w.deps, isOurEngine: (pid) => pid === 777 });
		assert.deepEqual(holding.repairLock(), { result: "engine-running", pid: 777 });
		assert.equal(existsSync(lock), true);

		assert.deepEqual(w.supervisor.repairLock(), { result: "removed", owner: 777 });
		assert.equal(existsSync(lock), false);
		assert.deepEqual(w.supervisor.repairLock(), { result: "none" });
		const started = await w.supervisor.start();
		assert.equal(started.url, URL);
	});

	it("does not stop a start for a stale lock whose owner is gone", async () => {
		const w = world();
		mkdirSync(w.layout.state, { recursive: true });
		writeFileSync(join(w.layout.state, "engine.lock"), `${JSON.stringify({ pid: 778, startTime: "T1", token: "t" })}\n`);
		w.procs.add(778, { startTime: "T2", executable: "/usr/bin/sleep" });
		assert.equal((await w.supervisor.start()).url, URL);
	});

	it("makes the work folder and the home base before `up --dir`, and fails plainly when it cannot", async () => {
		const w = world();
		await w.supervisor.start();
		assert.ok(existsSync(join(w.workFolder, "Straw Boss")));
		const w2 = world();
		mkdirSync(dirname(w2.workFolder), { recursive: true });
		writeFileSync(w2.workFolder, "a file where the work folder should be");
		assert.equal((await failureOf(w2.supervisor.start())).kind, "work-folder");
	});
});

describe("a start from nothing", () => {
	it("starts Herdr detached and hidden with the constructed environment, then runs `up`, then answers with the GUI's address", async () => {
		const w = world();
		const result = await w.supervisor.start();
		assert.equal(result.url, URL);
		assert.equal(result.server, "started");
		assert.equal(result.herdrReused, false);
		assert.deepEqual(w.order, ["spawn herdr 100", "up"]);

		const spawned = w.spawnOptions[0];
		assert.equal(spawned?.file, w.herdrBin);
		assert.deepEqual(spawned?.args, ["server"]);
		assert.deepEqual(spawned?.options, { detached: true, stdio: "ignore", windowsHide: true });
		assert.equal(w.children[0]?.unrefs, 1, "the app's exit does not wait for the server");

		// The constructed environment: the app's own SSH agent, token, and pane ids never reach a child.
		const env = spawned?.env ?? {};
		assert.equal(env.STRAW_BOSS_DESK, "1");
		assert.equal(env.PI_CODING_AGENT_DIR, w.layout.agent);
		assert.equal(env.HERDR_SOCKET_PATH, w.layout.herdrSocket);
		assert.equal(env.XDG_CONFIG_HOME, w.layout.configHome);
		for (const name of ["SSH_AUTH_SOCK", "GH_TOKEN", "PI_SUBAGENT_ID", "HERDR_PANE_ID"]) assert.equal(name in env, false, name);
		const up = w.callsOf("up")[0];
		assert.deepEqual(up?.args.slice(1), ["up", "--dir", join(w.workFolder, "Straw Boss"), "--label", "Straw Boss", "--timeout", "120", "--exact"]);
		assert.equal(up?.options?.replaceEnv, true);
		assert.deepEqual(up?.options?.env, env, "Herdr and `up` get one environment");
		assert.equal(up?.options?.timeoutMs, 150_000);
	});

	it("records the Herdr pid at once and both start times (macOS reads them right away)", async () => {
		const w = world();
		await w.supervisor.start();
		const rec = w.startRecord();
		assert.deepEqual(rec?.fingerprint, fingerprintOf(w.layout));
		assert.deepEqual(rec?.herdr, { pid: 100, startTime: "H100" });
		assert.deepEqual(rec?.sb, { pid: 200, startTime: "S200", slotDir: join(w.layout.agent, "straw-boss") });
		assert.equal(rec?.base?.workspace, "w1");
		assert.equal(rec?.base?.dir, join(w.workFolder, "Straw Boss"));
		assert.equal(typeof rec?.guiMs, "number");
		assert.equal(readFileSync(join(w.layout.state, "start.json"), "utf8").includes(TOKEN), false, "the page token is never written");
		assert.equal(JSON.stringify(w.log).includes(TOKEN), false, "nor logged");
		assert.deepEqual(urlEvents(w.events).map((e) => e.reason), ["start"]);
	});

	it("Windows order: no start time is read before the GUI shows; then one call reads both", async () => {
		const w = world({ eager: false });
		await w.supervisor.start();
		const lockProbeCalls = w.procs.inspectCalls.length;
		assert.equal(lockProbeCalls, 0, "a start with no engine lock reads nothing");
		assert.deepEqual(w.startRecord()?.herdr, { pid: 100, startTime: null });
		assert.equal(w.startRecord()?.sb?.startTime, null);
		w.supervisor.guiShown();
		await w.supervisor.settled();
		assert.deepEqual(w.procs.inspectCalls, [[100, 200]]);
		assert.equal(w.startRecord()?.herdr?.startTime, "H100");
		assert.equal(w.startRecord()?.sb?.startTime, "S200");
	});

	it("shows a failure and records nothing of the sb server when `up` fails; the Herdr it started stays recorded", async () => {
		const w = world();
		w.upQueue.push({ code: 1, stderr: `${JSON.stringify({ step: "gui", reason: `the GUI at ${URL} did not start` })}\n` });
		const failure = await failureOf(w.supervisor.start());
		assert.equal(failure.kind, "gui");
		assert.equal(JSON.stringify(failure).includes(TOKEN), false);
		assert.equal(w.supervisor.state, "failed");
		assert.ok(w.startRecord()?.herdr);
		assert.equal(w.startRecord()?.sb, null);
		assert.deepEqual(urlEvents(w.events), []);
	});

	it("fails with herdr-silent, killing through its handle, when the server never answers; the record of it is dropped", async () => {
		const w = world({ timeouts: { herdrStartMs: 3_000 } });
		w.deps.spawn = () => {
			const child = new FakeChild(101);
			w.children.push(child);
			return child;
		};
		const supervisor = new Supervisor(w.deps);
		const failure = await failureOf(supervisor.start());
		assert.equal(failure.kind, "herdr-silent");
		assert.deepEqual(w.children[0]?.signals, ["SIGKILL"]);
		assert.equal(supervisor.startFile.read()?.herdr ?? null, null);
		assert.ok(w.run.calls.filter((c) => c.args[0] === "workspace").length > 1, "it asked more than once");
	});

	it("fails with herdr-silent when the server exits before it answers, and when it cannot be spawned", async () => {
		const exits = world();
		exits.deps.spawn = () => {
			const child = new FakeChild(102);
			setTimeout(() => child.end(1), 0);
			return child;
		};
		assert.equal((await failureOf(new Supervisor(exits.deps).start())).kind, "herdr-silent");
		const missing = world();
		missing.deps.spawn = () => new FakeChild(undefined);
		assert.equal((await failureOf(new Supervisor(missing.deps).start())).kind, "herdr-silent");
	});
});

describe("Adopting a stack that is already running", () => {
	const seeded = async (w: ReturnType<typeof world>, over: Partial<StartRecord> = {}) => {
		w.setHerdrUp(true);
		w.procs.add(100, { startTime: "H0", executable: w.herdrBin }).add(200, { startTime: "S0", executable: w.exe("node") });
		await w.supervisor.startFile.update(() => ({
			schema: 1,
			fingerprint: fingerprintOf(w.layout),
			startedAt: "2026-11-02T00:00:00.000Z",
			herdr: { pid: 100, startTime: "H0" },
			sb: { pid: 200, startTime: "S0", slotDir: join(w.layout.agent, "straw-boss") },
			base: null,
			guiMs: null,
			...over,
		}));
	};

	it("reuses a Herdr that answers under the same fingerprint, starts none, and keeps the kill fallback while the start times match", async () => {
		const w = world();
		await seeded(w);
		w.upQueue.push(w.upOk({ server: "found" }));
		const result = await w.supervisor.start();
		assert.equal(result.herdrReused, true);
		assert.deepEqual(w.children, [], "no second Herdr");
		assert.deepEqual(w.order, ["up"]);
		assert.deepEqual(w.startRecord()?.herdr, { pid: 100, startTime: "H0" });
		assert.deepEqual(w.startRecord()?.sb, { pid: 200, startTime: "S0", slotDir: join(w.layout.agent, "straw-boss") });
	});

	it("drops the kill fallback of a process whose start time differs now, and of one with no record", async () => {
		const w = world();
		await seeded(w);
		w.procs.add(100, { startTime: "H-other", executable: "/usr/bin/sleep" }).add(200, { startTime: "S-other", executable: w.exe("node") });
		w.upQueue.push(w.upOk({ server: "found" }));
		await w.supervisor.start();
		assert.equal(w.startRecord()?.herdr?.startTime, null);
		assert.equal(w.startRecord()?.sb?.startTime, null);

		const fresh = world();
		await seeded(fresh, { herdr: { pid: 100, startTime: null }, sb: null });
		fresh.upQueue.push(fresh.upOk({ server: "found" }));
		await fresh.supervisor.start();
		assert.equal(fresh.startRecord()?.sb?.startTime, "S0", "found with no record: recorded now, because its executable is the app's (T8A-F013)");
		const stranger = world();
		await seeded(stranger, { sb: null });
		stranger.procs.add(200, { startTime: "S0", executable: "/usr/bin/python3" });
		stranger.upQueue.push(stranger.upOk({ server: "found" }));
		await stranger.supervisor.start();
		assert.equal(stranger.startRecord()?.sb?.startTime, null, "found, but another program holds the pid: never recorded");
	});

	it("records a found sb server that a pi session restarted since the last run (a new pid), with the executable check (T8A-F013)", async () => {
		const w = world();
		await seeded(w);
		w.sb.pid = 201;
		w.upQueue.push(w.upOk({ server: "found" }));
		await w.supervisor.start();
		assert.deepEqual(w.startRecord()?.sb, { pid: 201, startTime: "S201", slotDir: join(w.layout.agent, "straw-boss") });
	});

	it("reads no start time for a recorded Herdr whose pid is gone, as after a restart of the computer (T8A-F013)", async () => {
		const w = world();
		w.sb.pid = 200;
		await w.supervisor.startFile.update(() => ({
			schema: 1,
			fingerprint: fingerprintOf(w.layout),
			startedAt: "2026-11-02T00:00:00.000Z",
			herdr: { pid: 999, startTime: "H-old" },
			sb: null,
			base: null,
			guiMs: null,
		}));
		await w.supervisor.start();
		assert.ok(!w.procs.inspectCalls.some((call) => call.includes(999)), "the gone pid was not looked up (on Windows each lookup is a PowerShell start before the GUI shows)");
		assert.deepEqual(w.order.slice(0, 2), ["spawn herdr 100", "up"]);
		// A recorded pid that is alive is still looked up, to give a Herdr that is starting its time.
		const alive = world();
		alive.procs.add(999, { startTime: "H-old", executable: alive.herdrBin });
		await alive.supervisor.startFile.update(() => ({ schema: 1, fingerprint: fingerprintOf(alive.layout), startedAt: "2026-11-02T00:00:00.000Z", herdr: { pid: 999, startTime: "H-old" }, sb: null, base: null, guiMs: null }));
		alive.setHerdrUp(false);
		await alive.supervisor.start().catch(() => undefined);
		assert.ok(alive.procs.inspectCalls.some((call) => call.includes(999)));
	});

	it("stops a recorded Herdr that starts answering after the wait under another fingerprint, before it starts a new one (T8A-F011)", async () => {
		const w = world({ timeouts: { herdrStartMs: 3_000 } });
		w.procs.add(999, { startTime: "H-old", executable: w.herdrBin });
		await w.supervisor.startFile.update(() => ({
			schema: 1,
			fingerprint: { ...fingerprintOf(w.layout), agentDir: "/somewhere/else" },
			startedAt: "2026-11-02T00:00:00.000Z",
			herdr: { pid: 999, startTime: "H-old" },
			sb: null,
			base: null,
			guiMs: null,
		}));
		// The recorded server is alive and silent when it is looked up, and answers right after.
		const inspect = w.procs.inspect.bind(w.procs);
		w.procs.inspect = async (pids) => {
			if (pids.includes(999)) w.setHerdrUp(true);
			return inspect(pids);
		};
		const result = await w.supervisor.start();
		assert.equal(result.herdrReused, false);
		assert.deepEqual(w.order.slice(0, 2), ["herdr server stop", "spawn herdr 100"], "the old server is stopped through its CLI first, so its answer is never taken for the new one's");
		assert.ok(w.log.some((l) => l.event === "herdr-foreign" && l.why === "another fingerprint"));
	});

	it("stops a Herdr that answers under another fingerprint, or under none, and starts anew", async () => {
		for (const record of ["other", "none"] as const) {
			const w = world();
			w.setHerdrUp(true);
			w.procs.add(100, { startTime: "H0", executable: w.herdrBin });
			if (record === "other") await seeded(w, { fingerprint: { ...fingerprintOf(w.layout), agentDir: "/somewhere/else" } });
			const result = await w.supervisor.start();
			assert.equal(result.herdrReused, false, record);
			assert.deepEqual(w.order.slice(0, 2), ["herdr server stop", "spawn herdr 100"], record);
		}
	});

	it("fails with foreign-stack when a Herdr under another environment will not stop", async () => {
		const w = world({ herdrUp: true });
		w.deps.run = scriptedRun([
			{ match: (c) => c.args[0] === "workspace", answer: { code: 0 } },
			{ match: (c) => c.args[0] === "server", answer: { code: 0 } },
		]);
		const failure = await failureOf(new Supervisor(w.deps).start());
		assert.equal(failure.kind, "foreign-stack");
	});
});

describe("the OS proxy", () => {
	it("is resolved before Herdr starts and reaches Herdr's environment", async () => {
		const w = world({ resolveProxy: async (url) => (url.includes("registry.npmjs.org") || url.includes("github.com") ? "PROXY proxy.corp.example:8080; DIRECT" : "DIRECT"), forges: [{ kind: "github", host: "github.com" }] });
		await w.supervisor.start();
		const env = w.spawnOptions[0]?.env ?? {};
		assert.equal(env.HTTPS_PROXY, "http://proxy.corp.example:8080");
		assert.equal(env.HTTP_PROXY, "http://proxy.corp.example:8080");
		assert.match(env.NO_PROXY ?? "", /127\.0\.0\.1,localhost,::1/);
		const proxyAt = w.log.findIndex((l) => l.event === "proxy");
		const spawnAt = w.log.findIndex((l) => l.event === "herdr-started");
		assert.ok(proxyAt >= 0 && proxyAt < spawnAt, "the proxy was resolved first");
		assert.equal(w.callsOf("up")[0]?.options?.env?.HTTPS_PROXY, "http://proxy.corp.example:8080");
	});

	it("gives the engine the same variables on request, and none when the registry is DIRECT", async () => {
		const proxied = world({ resolveProxy: async () => "PROXY p.example:3128" });
		assert.equal((await proxied.supervisor.engineProxyEnv(["gitlab.example.com"])).HTTPS_PROXY, "http://p.example:3128");
		const direct = world({ resolveProxy: async () => "DIRECT" });
		assert.deepEqual(await direct.supervisor.engineProxyEnv([]), {});
		assert.deepEqual(await world().supervisor.engineProxyEnv([]), {});
	});
});

describe("the WSL check", () => {
	it("shows a notice at the start when a pane's bash would be WSL's, and none otherwise", async () => {
		const wsl = world({ checkPane: async () => ({ firstBash: "C:\\Windows\\System32\\bash.exe", wslBash: true, machinePi: null, machineBun: null, machineBunx: null }) });
		await wsl.supervisor.start();
		const notice = wsl.events.find((e) => e.type === "notice" && e.kind === "wsl-bash");
		assert.ok(notice && notice.type === "notice" && /Windows Subsystem for Linux/.test(notice.sentence) && notice.path === "C:\\Windows\\System32\\bash.exe");
		const clean = world({ checkPane: async () => ({ firstBash: "C:\\Git\\bin\\bash.exe", wslBash: false, machinePi: null, machineBun: null, machineBunx: null }) });
		await clean.supervisor.start();
		assert.equal(clean.events.some((e) => e.type === "notice"), false);
		const broken = world({
			checkPane: async () => {
				throw new Error("reg.exe not found");
			},
		});
		await broken.supervisor.start();
		assert.ok(broken.log.some((l) => l.event === "pane-path-unreadable"), "a check that fails never fails the start");
	});

	it("runs again at every start", async () => {
		let runs = 0;
		const w = world({
			checkPane: async () => {
				runs++;
				return { firstBash: null, wslBash: false, machinePi: null, machineBun: null, machineBunx: null };
			},
		});
		await w.supervisor.start();
		await w.supervisor.start();
		assert.equal(runs, 2);
	});
});

describe("a Herdr server that ends on its own", () => {
	it("is started again, then `up` runs, and start.json holds the new pid and its start time with the old record gone", async () => {
		const w = world();
		await w.supervisor.start();
		w.supervisor.guiShown();
		await w.supervisor.settled();
		assert.deepEqual(w.startRecord()?.herdr, { pid: 100, startTime: "H100" });
		w.children[0]?.end(137);
		await until(() => urlEvents(w.events).length === 2, "the second gui-url");
		await w.supervisor.settled();
		await w.supervisor.times.idle();
		assert.equal(w.children.length, 2);
		assert.deepEqual(w.startRecord()?.herdr, { pid: 101, startTime: "H101" });
		assert.ok(!JSON.stringify(w.startRecord()).includes("H100"), "the old record is gone");
		assert.deepEqual(urlEvents(w.events).map((e) => e.reason), ["start", "restart"]);
		assert.deepEqual(w.order, ["spawn herdr 100", "up", "spawn herdr 101", "up"]);
		assert.equal(w.supervisor.state, "running");
	});

	it("stops restarting after more than 3 restarts in 10 minutes and shows a failure", async () => {
		const w = world();
		await w.supervisor.start();
		for (let i = 0; i < 4; i++) {
			const child = w.children[i];
			assert.ok(child, `child ${i}`);
			child.end(1);
			if (i < 3) await until(() => w.children.length === i + 2 && w.supervisor.state === "running", `restart ${i + 1}`);
			w.clock.advance(1000);
		}
		await until(() => w.events.some((e) => e.type === "failure" && /more than 3 times in 10 minutes/.test(e.failure.reason)), "the budget failure");
		assert.equal(w.supervisor.state, "failed");
		assert.equal(w.children.length, 4, "no fifth Herdr");
	});

	it("counts an `up` that started another sb server as a restart of it: the fourth within 10 minutes fails, and an `up` that only found the server counts for nothing", async () => {
		const w = world();
		await w.supervisor.start();
		for (let i = 0; i < 6; i++) {
			w.upQueue.push(w.upOk({ server: "found" }));
			await w.supervisor.upOnce();
		}
		assert.ok(!w.events.some((e) => e.type === "failure"), "finding the server again is no restart");
		for (let i = 0; i < 3; i++) {
			w.upQueue.push(w.upOk({ server: "restarted" }));
			await w.supervisor.upOnce();
			w.clock.advance(1000);
		}
		assert.equal(w.supervisor.state, "running", "three restarts are inside the budget");
		assert.ok(!w.events.some((e) => e.type === "failure"));
		w.upQueue.push(w.upOk({ server: "started" }));
		await w.supervisor.upOnce();
		const failure = w.events.find((e): e is Extract<SupervisorEvent, { type: "failure" }> => e.type === "failure")?.failure;
		assert.equal(failure?.kind, "restart-budget");
		assert.match(failure?.reason ?? "", /sb server restarted more than 3 times in 10 minutes/);
		assert.equal(w.supervisor.state, "failed");
	});

	it("is not restarted while the stack is being stopped", async () => {
		const w = world();
		await w.supervisor.start();
		await w.supervisor.stop();
		assert.equal(w.children.length, 1);
		assert.equal(w.supervisor.state, "idle");
	});
});

describe("the sb server's pid", () => {
	it("a new pid is re-recorded; one that belongs to another program is not recorded", async () => {
		const w = world();
		await w.supervisor.start();
		const slot = join(w.layout.agent, "straw-boss");

		w.procs.add(201, { startTime: "S201", executable: w.exe("node") });
		await w.supervisor.noteSbServer(201);
		assert.deepEqual(w.startRecord()?.sb, { pid: 201, startTime: "S201", slotDir: slot });
		assert.ok(!JSON.stringify(w.startRecord()).includes("S200"), "the old record is gone");

		w.procs.add(900, { startTime: "X", executable: "/usr/bin/python3" });
		await w.supervisor.noteSbServer(900);
		assert.deepEqual(w.startRecord()?.sb, { pid: 900, startTime: null, slotDir: slot }, "a server.json pid that is another program's is never recorded");
	});
});

/** A fake GUI listener: 200 on its own token's path, 403 elsewhere. */
function guiListener(token: string, port = 0): Promise<{ port: number; url: string; close(): Promise<void> }> {
	return new Promise((resolve, reject) => {
		const srv = createServer((req, res) => void res.writeHead(req.url === `/${token}/` ? 200 : 403).end("x"));
		listeners.push(srv);
		srv.once("error", reject);
		srv.listen(port, "127.0.0.1", () => {
			const bound = (srv.address() as { port: number }).port;
			resolve({
				port: bound,
				url: `http://127.0.0.1:${bound}/${token}/`,
				close: () =>
					new Promise<void>((done) => {
						srv.close(() => done());
						srv.closeAllConnections?.();
					}),
			});
		});
	});
}

describe("the follower inside the supervisor (task 8b)", () => {
	const FOLLOW = { timing: { tickMs: 25, goneMs: 300, freshMs: 500, moveWaitMs: 800, movePollMs: 20, resumeGraceMs: 400 } };
	const slotOf = (w: { layout: { agent: string } }) => join(w.layout.agent, "straw-boss");
	const writeServer = (w: { layout: { agent: string } }, rec: Record<string, unknown>) => {
		const slot = slotOf(w);
		mkdirSync(slot, { recursive: true });
		writeFileSync(join(slot, "server.json.tmp"), JSON.stringify(rec));
		renameSync(join(slot, "server.json.tmp"), join(slot, "server.json"));
	};
	const restarts = (n: number) => `restart ${n}`;

	it("records the new pid of a restart the follower sees, and the fourth within 10 minutes shows the failure screen and stops following; Retry starts again with a fresh budget", async () => {
		const w = world({ follow: FOLLOW });
		const gui = await guiListener(TOKEN);
		w.upQueue.push(w.upOk({ url: gui.url }));
		writeServer(w, { pid: 200, gui: { port: gui.port, token: TOKEN } });
		await w.supervisor.start();
		for (const pid of [201, 202, 203]) {
			w.procs.add(pid, { startTime: `S${pid}`, executable: w.exe("node") });
			writeServer(w, { pid, gui: { port: gui.port, token: TOKEN } });
			await until(() => w.startRecord()?.sb?.pid === pid && w.startRecord()?.sb?.startTime === `S${pid}`, restarts(pid));
		}
		assert.equal(w.supervisor.state, "running", "three restarts are inside the budget");
		assert.ok(!w.events.some((e) => e.type === "failure"));
		w.procs.add(204, { startTime: "S204", executable: w.exe("node") });
		writeServer(w, { pid: 204, gui: { port: gui.port, token: TOKEN } });
		await until(() => w.events.some((e) => e.type === "failure"), "the budget failure");
		const failure = w.events.find((e): e is Extract<SupervisorEvent, { type: "failure" }> => e.type === "failure")?.failure;
		assert.equal(failure?.kind, "restart-budget");
		assert.match(failure?.reason ?? "", /more than 3 times in 10 minutes/);
		assert.equal(w.supervisor.state, "failed");
		// The follower gave up: a fifth pid is not looked at.
		w.procs.add(205, { startTime: "S205", executable: w.exe("node") });
		writeServer(w, { pid: 205, gui: { port: gui.port, token: TOKEN } });
		await new Promise((r) => setTimeout(r, 200));
		assert.equal(w.startRecord()?.sb?.pid, 204);
		// Retry is a whole start with a fresh budget; `up` finds the server that runs now.
		w.sb.pid = 205;
		w.upQueue.push(w.upOk({ url: gui.url, server: "found" }));
		await w.supervisor.retry();
		assert.equal(w.supervisor.state, "running");
		for (const pid of [206, 207, 208]) {
			w.procs.add(pid, { startTime: `S${pid}`, executable: w.exe("node") });
			writeServer(w, { pid, gui: { port: gui.port, token: TOKEN } });
			await until(() => w.startRecord()?.sb?.pid === pid, restarts(pid));
		}
		assert.equal(w.supervisor.state, "running", "the budget began again");
		await w.supervisor.stop();
	});

	it("runs `up` once when the GUI is gone and announces the new address as `moved`; an `up` that started another server counts as a restart", async () => {
		const w = world({ follow: FOLLOW });
		const a = await guiListener(TOKEN);
		const tokenB = "fedcba9876543210fedcba9876543210";
		const b = await guiListener(tokenB);
		w.upQueue.push(w.upOk({ url: a.url }), w.upOk({ url: b.url, server: "restarted" }));
		writeServer(w, { pid: 200, gui: { port: a.port, token: TOKEN } });
		await w.supervisor.start();
		assert.equal(w.order.filter((o) => o === "up").length, 1);
		await a.close();
		await until(() => urlEvents(w.events).some((e) => e.reason === "moved"), "the moved address");
		assert.equal(w.order.filter((o) => o === "up").length, 2);
		assert.equal(urlEvents(w.events).at(-1)?.url, b.url);
		assert.equal(w.supervisor.state, "running");
		await w.supervisor.stop();
	});

	it("shows the typed failure when the gone rule's `up` fails, and Retry (the Start button) runs it again", async () => {
		const w = world({ follow: FOLLOW });
		const a = await guiListener(TOKEN);
		w.upQueue.push(w.upOk({ url: a.url }), { code: 1, stderr: `${JSON.stringify({ step: "gui", reason: "the page did not start" })}\n` });
		writeServer(w, { pid: 200, gui: { port: a.port, token: TOKEN } });
		await w.supervisor.start();
		await a.close();
		await until(() => w.events.some((e) => e.type === "screen"), "the failed screen");
		const screen = w.events.find((e): e is Extract<SupervisorEvent, { type: "screen" }> => e.type === "screen")?.screen;
		assert.equal(screen?.kind, "failed");
		assert.equal(screen?.kind === "failed" ? screen.failure.kind : "", "gui");
		const b = await guiListener("0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f");
		w.upQueue.push(w.upOk({ url: b.url }));
		await w.supervisor.retry();
		assert.equal(urlEvents(w.events).at(-1)?.url, b.url);
		await w.supervisor.stop();
	});

	it("tells the window the server's default view before the first address, and again when it changes", async () => {
		const w = world({ follow: FOLLOW });
		const a = await guiListener(TOKEN);
		w.upQueue.push(w.upOk({ url: a.url }));
		writeServer(w, { pid: 200, gui: { port: a.port, token: TOKEN } });
		writeFileSync(join(slotOf(w), "gui.json"), JSON.stringify({ port: a.port, token: TOKEN, view: "zen" }));
		await w.supervisor.start();
		const kinds = w.events.map((e) => e.type);
		assert.ok(kinds.indexOf("view") >= 0 && kinds.indexOf("view") < kinds.indexOf("gui-url"), kinds.join(","));
		assert.deepEqual(w.events.filter((e) => e.type === "view").map((e) => (e as { view?: string }).view), ["zen"]);
		writeFileSync(join(slotOf(w), "gui.json"), JSON.stringify({ port: a.port, token: TOKEN, view: "geek" }));
		await until(() => w.events.filter((e) => e.type === "view").length === 2, "the changed view");
		assert.equal((w.events.filter((e) => e.type === "view").at(-1) as { view?: string }).view, "geek");
		await w.supervisor.stop();
	});

	it("pauses the follower at suspend and resumes it with a grace period, so a URL that was down across the sleep runs no `up`", async () => {
		const w = world({ follow: FOLLOW });
		const a = await guiListener(TOKEN);
		w.upQueue.push(w.upOk({ url: a.url }));
		writeServer(w, { pid: 200, gui: { port: a.port, token: TOKEN } });
		await w.supervisor.start();
		const ups = w.order.filter((o) => o === "up").length;
		w.supervisor.suspend();
		await a.close();
		await new Promise((r) => setTimeout(r, 700));
		w.supervisor.resume();
		const back = await guiListener(TOKEN, a.port);
		await new Promise((r) => setTimeout(r, 900));
		assert.equal(w.order.filter((o) => o === "up").length, ups, "no `up` for a gap the sleep made");
		assert.ok(w.log.some((l) => l.event === "follow-pause") && w.log.some((l) => l.event === "follow-resume"));
		await back.close();
		await w.supervisor.stop();
	});

	// T8B-F005. The state is `failed` after a Herdr restart that did not come back; a follower that stayed could run `up` and put a GUI over the failure screen.
	it("stops following when the Herdr restart fails: the gone rule runs no `up` under the failure screen", async () => {
		let failSpawn = false;
		const w = world({
			follow: FOLLOW,
			onSpawn: () => {
				if (failSpawn) throw new Error("herdr could not be started again");
			},
		});
		const a = await guiListener(TOKEN);
		w.upQueue.push(w.upOk({ url: a.url }));
		writeServer(w, { pid: 200, gui: { port: a.port, token: TOKEN } });
		await w.supervisor.start();
		failSpawn = true;
		w.children[0]?.end(137);
		await until(() => w.supervisor.state === "failed", "the failed state");
		assert.ok(w.events.some((e) => e.type === "failure"));
		const ups = w.order.filter((o) => o === "up").length;
		const urls = urlEvents(w.events).length;
		await a.close(); // the GUI is gone: the gone rule would call `up`
		await new Promise((r) => setTimeout(r, FOLLOW.timing.goneMs * 3));
		try {
			assert.equal(w.order.filter((o) => o === "up").length, ups, "no `up` after the failure");
			assert.equal(urlEvents(w.events).length, urls, "no GUI replaced the failure screen");
			assert.equal(w.supervisor.state, "failed");
		} finally {
			await w.supervisor.stop(); // ends a follower that a failing assertion left running
		}
	});

	it("stops following when the stack stops: a pid that changes afterwards is not looked at", async () => {
		const w = world({ follow: FOLLOW });
		const a = await guiListener(TOKEN);
		w.upQueue.push(w.upOk({ url: a.url }));
		writeServer(w, { pid: 200, gui: { port: a.port, token: TOKEN } });
		await w.supervisor.start();
		await w.supervisor.stop();
		const before = w.procs.inspectCalls.length;
		w.procs.add(300, { startTime: "S300", executable: w.exe("node") });
		writeServer(w, { pid: 300, gui: { port: a.port, token: TOKEN } });
		await new Promise((r) => setTimeout(r, 250));
		assert.equal(w.procs.inspectCalls.length, before);
		assert.ok(!w.log.some((l) => l.event === "sb-server-restarted" && l.pid === 300));
	});
});

describe("stop", () => {
	it("runs the stop sequence for the stack it started, goes idle, and emits the report", async () => {
		const w = world();
		await w.supervisor.start();
		const report = await w.supervisor.stop();
		assert.equal(report.ok, true, report.notes.join("; "));
		assert.deepEqual(w.order, ["spawn herdr 100", "up", "cli stop", "herdr server stop"]);
		assert.equal(w.supervisor.state, "idle");
		assert.ok(w.events.some((e) => e.type === "stopped" && e.report.ok));
		assert.equal(existsSync(join(w.layout.state, "start.json")), false);
	});

	it("rebuilds its environment from the state files for a stack an earlier run of the app started (a crash, then --stop-stack)", async () => {
		const first = world();
		await first.supervisor.start();
		// The app that started the stack crashed: its handle and its listeners are gone, and the next run knows only the files.
		for (const child of first.children) child.forget();
		const second = new Supervisor({ ...first.deps });
		const report = await second.stop();
		assert.equal(report.ok, true, report.notes.join("; "));
		const stopCall = first.callsOf("stop")[0];
		assert.equal(stopCall?.options?.env?.PI_CODING_AGENT_DIR, first.layout.agent);
	});

	it("shows what still runs by pid on the failure screen and in the log, when the stop leaves the sb server up and has no start time for it", async () => {
		const w = world();
		await w.supervisor.start();
		await w.supervisor.startFile.update((r) => (r && r.sb ? { ...r, sb: { ...r.sb, startTime: null } } : r));
		w.deps.run = scriptedRun([
			{ match: (c) => c.file === w.herdrBin && c.args[0] === "workspace", answer: () => ({ code: 1 }) },
			{ match: (c) => c.file === w.herdrBin, answer: { code: 0 } },
			{ match: (c) => c.args[1] === "stop", answer: { code: 1, stderr: "exit-timeout\n" } },
		]);
		const stopping = new Supervisor({ ...w.deps, stopTimeouts: { sbWaitMs: 0 } });
		stopping.on((e) => w.events.push(e));
		const report = await stopping.stop();
		assert.equal(report.ok, false);
		assert.deepEqual(w.procs.killed.filter((p) => p === 200), []);
		const failure = w.events.find((e): e is Extract<SupervisorEvent, { type: "failure" }> => e.type === "failure");
		assert.deepEqual(failure?.failure.leftovers?.map((l) => l.pid).sort(), [200]);
		assert.ok(w.log.some((l) => l.event === "stop-end" && JSON.stringify(l.leftovers).includes('"pid":200')));
		assert.equal(stopping.state, "failed");
	});

	it("does nothing when nothing is installed", async () => {
		const w = world({ install: false });
		const report = await w.supervisor.stop();
		assert.equal(report.ok, true);
		assert.deepEqual(w.run.calls, []);
	});

	it("session-end runs cli.mjs stop for 10 s and nothing else", async () => {
		const w = world();
		await w.supervisor.start();
		w.supervisor.stopForSessionEnd();
		assert.equal(w.syncExits.length, 1);
		assert.deepEqual(w.syncExits[0]?.args, [w.installed?.sbCli, "stop"]);
		assert.equal(w.syncExits[0]?.timeoutMs, 10_000);
		assert.equal(w.callsOf("stop").length, 0, "the async runner was not used");
	});
});

describe("stop with a pi-straw-boss that is not verified (R8A-F001)", () => {
	const unverify = (w: { layout: { state: string } }, status = "failed") => writeFileSync(join(w.layout.state, "bootstrap.json"), JSON.stringify({ schema: 1, stages: { ...stack, "pkg:pi-straw-boss": record(status) } }));

	it("runs no cli.mjs at the quit after a start refused for the package, and the stop is clean when nothing runs", async () => {
		for (const status of ["failed", "absent", "running"]) {
			const w = world();
			unverify(w, status);
			await failureOf(w.supervisor.start());
			const report = await w.supervisor.stop();
			assert.deepEqual(w.run.calls.filter((c) => c.args.includes("stop") && c.args[0] === w.installed?.sbCli), [], `${status}: the unverified CLI did not run`);
			assert.equal(report.cliStop.ran, false);
			assert.equal(report.ok, true, report.notes.join("; "));
			assert.ok(w.log.some((l) => l.event === "sb-cli-stop-skipped"));
		}
	});

	it("reports a running sb server that no record names, and neither runs the CLI nor kills it", async () => {
		const w = world();
		unverify(w);
		await failureOf(w.supervisor.start());
		// An sb server of the unverified package, started by a pi session: server.json names it and start.json does not.
		const slot = join(w.layout.agent, "straw-boss");
		mkdirSync(slot, { recursive: true });
		writeFileSync(join(slot, "server.json"), JSON.stringify({ pid: 300 }));
		w.procs.add(300, { startTime: "S300", executable: w.exe("node") });
		const report = await w.supervisor.stop();
		assert.deepEqual(w.callsOf("stop").filter((c) => c.args[0] === w.installed?.sbCli), []);
		assert.deepEqual(w.procs.killed, []);
		assert.equal(w.procs.has(300), true);
		assert.equal(report.unverifiedSb, 300);
		assert.equal(report.ok, false);
		assert.ok(w.log.some((l) => l.event === "sb-server-unverified" && l.pid === 300), "logged");
		assert.ok(report.notes.some((n) => /pid 300/.test(n) && /not verified/.test(n)), report.notes.join("; "));
		assert.equal(w.supervisor.state, "failed");
	});

	// T8C-F001. A new `cli.mjs` process loads the package's files from disk now, so a stage that went bad while a recorded server runs still keeps the CLI from starting.
	it("runs no cli.mjs for a recorded sb server that runs once the stage is no longer ok, and ends it by its start time (T8C-F001)", async () => {
		const w = world();
		await w.supervisor.start();
		unverify(w);
		const report = await w.supervisor.stop();
		assert.deepEqual(w.callsOf("stop").filter((c) => c.args[0] === w.installed?.sbCli), [], "the unverified CLI did not run");
		assert.equal(w.order.includes("cli stop"), false);
		assert.equal(w.order.at(-1), "herdr server stop");
		assert.equal(w.procs.killed.includes(200), true, "the recorded sb server was ended by the kill rule");
		assert.equal(report.unverifiedSb, null);
		assert.equal(report.ok, true, report.notes.join("; "));
	});

	it("reports a recorded sb server of an unverified package that the rule does not allow to kill, as sb-unverified with its pid (T8C-F002)", async () => {
		const w = world();
		await w.supervisor.start();
		// The record's start time no longer matches the process: it is not proved ours.
		await w.supervisor.startFile.update((r) => (r && r.sb ? { ...r, sb: { ...r.sb, startTime: "someone else's" } } : r));
		unverify(w);
		const report = await w.supervisor.stop();
		assert.equal(report.unverifiedSb, 200);
		assert.equal(report.ok, false);
		assert.deepEqual(w.procs.killed.filter((pid) => pid === 200), []);
		const failure = w.events.filter((e): e is Extract<SupervisorEvent, { type: "failure" }> => e.type === "failure").at(-1)?.failure;
		assert.equal(failure?.kind, "sb-unverified");
		assert.equal(failure?.unverifiedSb, 200);
		assert.equal(failure?.offerRepair, true);
	});

	it("session-end runs no cli.mjs for an unverified package, with or without a server of the record running (T8C-F001)", async () => {
		const none = world();
		unverify(none);
		await failureOf(none.supervisor.start());
		none.supervisor.stopForSessionEnd();
		assert.deepEqual(none.syncExits, []);
		assert.ok(none.log.some((l) => l.event === "session-end-stop-skipped"));

		const live = world();
		await live.supervisor.start();
		unverify(live);
		live.supervisor.stopForSessionEnd();
		assert.deepEqual(live.syncExits, [], "a recorded server running does not make the package's files trusted");
		assert.ok(live.log.some((l) => l.event === "session-end-stop-skipped"));

		const ok = world();
		await ok.supervisor.start();
		ok.supervisor.stopForSessionEnd();
		assert.equal(ok.syncExits.length, 1, "a verified package still runs it");
	});
});

describe("maintenance: the npm stages do not run beside a live stack (T6-F006, T7-F007)", () => {
	it("stops the stack, runs the work, and starts the stack again", async () => {
		const w = world();
		await w.supervisor.start();
		const seen: string[] = [];
		const result = await w.supervisor.withStackStopped(async () => {
			seen.push(...w.order);
			assert.equal(w.supervisor.state, "idle");
			assert.equal(w.procs.has(200), false, "the sb server was stopped");
			return "worked";
		});
		assert.equal(result, "worked");
		assert.deepEqual(seen, ["spawn herdr 100", "up", "cli stop", "herdr server stop"]);
		assert.deepEqual(w.order.slice(-2), ["spawn herdr 101", "up"]);
		assert.equal(w.supervisor.state, "running");
		assert.equal(urlEvents(w.events).length, 2, "the GUI is told its address again");
	});

	it("does not start the stack again after the work when the app is quitting (T9-F002)", async () => {
		const w = world();
		await w.supervisor.start();
		const result = await w.supervisor.withStackStopped(async () => {
			w.supervisor.beginQuit();
			return "worked";
		});
		assert.equal(result, "worked");
		assert.equal(w.supervisor.state, "idle", "the quit stops next; a start would only be stopped again");
		assert.deepEqual(w.order.slice(-2), ["cli stop", "herdr server stop"]);
	});

	it("starts the stack again after the work once the quit is cancelled (the installer of an update could not start)", async () => {
		const w = world();
		await w.supervisor.start();
		w.supervisor.beginQuit();
		w.supervisor.cancelQuit();
		await w.supervisor.withStackStopped(async () => "worked");
		assert.equal(w.supervisor.state, "running");
	});

	it("starts the stack again when the work throws, and does not start one that was not running", async () => {
		const running = world();
		await running.supervisor.start();
		await assert.rejects(running.supervisor.withStackStopped(async () => Promise.reject(new Error("npm failed"))), /npm failed/);
		assert.equal(running.supervisor.state, "running");

		const idle = world();
		await idle.supervisor.withStackStopped(async () => "x");
		assert.equal(idle.children.length, 0);
	});

	it("reports the work's own error when the restart after it fails too, and shows the restart's failure (T8A-F008)", async () => {
		const w = world();
		await w.supervisor.start();
		// The restart's `up` fails: a GUI that does not start.
		w.upQueue.push({ code: 1, stderr: `${JSON.stringify({ step: "gui", reason: "the GUI did not start" })}\n` });
		await assert.rejects(w.supervisor.withStackStopped(async () => Promise.reject(new Error("npm failed"))), /npm failed/);
		assert.ok(w.events.some((e) => e.type === "failure" && e.failure.kind === "gui"), "the restart's failure is shown");
		assert.ok(w.log.some((l) => l.event === "restart-after-work-failed"));
		assert.equal(w.supervisor.state, "failed");
		// After a good run the restart's failure is the caller's.
		const good = world();
		await good.supervisor.start();
		good.upQueue.push({ code: 1, stderr: `${JSON.stringify({ step: "gui", reason: "the GUI did not start" })}\n` });
		const failure = await failureOf(good.supervisor.withStackStopped(async () => "worked"));
		assert.equal(failure.kind, "gui");
	});

	it("keeps a start, an upOnce and a Herdr restart out of the gap between the stop and the work (T8A-F008)", async () => {
		const w = world();
		await w.supervisor.start();
		const during: string[] = [];
		let queued: Promise<unknown>[] = [];
		const maintenance = w.supervisor.withStackStopped(async () => {
			// Asked while the work runs: none of them may run before the work is done.
			queued = [w.supervisor.start().catch(() => undefined), w.supervisor.upOnce().catch(() => undefined)];
			await new Promise((resolve) => setTimeout(resolve, 30));
			during.push(...w.order);
			return "worked";
		}).catch(() => undefined);
		// The work above asks for a start and an upOnce of the same queue, which would wait for the job they are inside of: the job must not wait for them.
		await Promise.race([maintenance, new Promise((resolve) => setTimeout(resolve, 2000))]);
		assert.deepEqual(during, ["spawn herdr 100", "up", "cli stop", "herdr server stop"], "no Herdr and no `up` between the stop and the end of the work");
		await maintenance;
		await Promise.all(queued);
	});

	it("counts a start that is still under way as running, and restarts the stack after the work (T8A-F008)", async () => {
		let stateAtCall: string | null = null;
		let result: Promise<string> | null = null;
		let w: ReturnType<typeof world> | undefined;
		w = world({
			// Asked while the first start spawns Herdr, so the supervisor is `starting`.
			onSpawn: () => {
				if (result !== null || !w) return;
				stateAtCall = w.supervisor.state;
				result = w.supervisor.withStackStopped(async () => {
					assert.equal(w?.supervisor.state, "idle", "the started stack was stopped for the work");
					return "worked";
				});
			},
		});
		await w.supervisor.start();
		assert.equal(stateAtCall, "starting");
		assert.equal(await result, "worked");
		assert.equal(w.supervisor.state, "running", "the stack runs again");
		assert.deepEqual(w.order, ["spawn herdr 100", "up", "cli stop", "herdr server stop", "spawn herdr 101", "up"]);
	});

	it("runs the main process's prune as a job of the queue, so a restart or upOnce waits for it instead of meeting its lock (R8A-F002)", async () => {
		const w = world();
		writeFileSync(join(w.layout.state, "current.json"), JSON.stringify({ schema: 1, versions: { node: "24.0.0", git: "2.0.0", herdr: "0.9.5" }, previous: { node: "23.0.0" } }));
		await w.supervisor.start();
		let release: () => void = () => {};
		const held = new Promise<void>((resolve) => (release = resolve));
		let entered = false;
		const job = w.supervisor.withStackStopped(async () => {
			entered = true;
			await held;
		});
		await until(() => entered, "the work to begin");
		w.supervisor.guiShown();
		await new Promise((resolve) => setTimeout(resolve, 60));
		assert.equal(w.log.some((l) => l.event === "prune"), false, "the prune waits behind the queued job");
		release();
		await job;
		await w.supervisor.settled();
		assert.ok(w.log.some((l) => l.event === "prune" && l.tool === "node"), "and runs after it");
	});

	it("R11-F001: an engine job waits for a start under way, and a start asked during the job waits for it", async () => {
		let result: Promise<string> | null = null;
		let during: string[] = [];
		let startAsked: Promise<unknown> | null = null;
		let w: ReturnType<typeof world> | undefined;
		w = world({
			// Asked while the first start spawns Herdr, so the job is behind a start under way.
			onSpawn: () => {
				if (result !== null || !w) return;
				const mine = w;
				result = mine.supervisor.withEngineJob(async () => {
					during = [...mine.order];
					startAsked = mine.supervisor.start().catch(() => undefined);
					await new Promise((resolve) => setTimeout(resolve, 30));
					assert.deepEqual(mine.order, during, "no second start ran while the job ran");
					return "worked";
				});
			},
		});
		await w.supervisor.start();
		assert.equal(await result, "worked");
		assert.deepEqual(during, ["spawn herdr 100", "up"], "the job began after the start had finished");
		assert.equal(w.supervisor.state, "running", "the job left the stack as it was");
		await startAsked;
		assert.ok(!w.order.includes("cli stop"), "an engine job does not stop the stack");
	});

	it("R11-F002: restart waits for a program of the tools folder that is still ending, and withStackStopped without the wait refuses", async () => {
		for (const [name, waits] of [["restart", true], ["no wait", false]] as const) {
			const w = world();
			await w.supervisor.start();
			w.procs.add(300, { startTime: "B300", executable: w.exe("node") });
			const sleep = w.clock.sleep;
			// The supervisor holds this clock object, so the helper ends 3 s into the sleeps the stop makes.
			(w.clock as { sleep: (ms: number) => Promise<void> }).sleep = async (ms) => {
				await sleep(ms);
				if (w.clock.slept.reduce((x, y) => x + y, 0) >= 3_000) w.procs.table.delete(300);
			};
			w.deps.stopTimeouts = { leftoversPollMs: 1_000 };
			const sup = w.supervisor;
			if (waits) {
				await sup.restart();
				assert.equal(sup.state, "running", `${name}: the stack runs again`);
			} else {
				await assert.rejects(sup.withStackStopped(async () => undefined), (e: unknown) => e instanceof StackBusyError && e.report.leftovers.some((l) => l.pid === 300), name);
			}
		}
	});

	it("does not run the work when a program still runs from the tools folder", async () => {
		const w = world();
		await w.supervisor.start();
		await w.supervisor.startFile.update((r) => (r && r.sb ? { ...r, sb: { ...r.sb, startTime: null } } : r));
		w.deps.run = scriptedRun([
			{ match: (c) => c.file === w.herdrBin && c.args[0] === "workspace", answer: () => ({ code: 1 }) },
			{ match: (c) => c.file === w.herdrBin, answer: { code: 0 } },
			{ match: (c) => c.args[1] === "stop", answer: { code: 1, stderr: "exit-timeout\n" } },
		]);
		const busy = new Supervisor({ ...w.deps, stopTimeouts: { sbWaitMs: 0 } });
		let ran = false;
		await assert.rejects(busy.withStackStopped(async () => void (ran = true)), (e: unknown) => e instanceof StackBusyError && e.report.leftovers.some((l) => l.pid === 200));
		assert.equal(ran, false);
	});
});

describe("upOnce", () => {
	it("runs `up` again on the running stack and emits the address", async () => {
		const w = world();
		await w.supervisor.start();
		w.upQueue.push(w.upOk({ server: "found" }));
		const up = await w.supervisor.upOnce();
		assert.equal(up.server, "found");
		assert.deepEqual(urlEvents(w.events).map((e) => e.reason), ["start", "restart"]);
	});
});
