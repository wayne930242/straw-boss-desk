import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
after(() => {
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
	forges?: Array<{ kind: "github" | "gitlab"; host: string }>;
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
		timeouts: { pollMs: 0, ...options.timeouts },
		pidAlive: (pid) => procs.has(pid),
		runSync: (file, args, o) => {
			syncExits.push({ file, args, timeoutMs: o.timeoutMs });
			return { code: 0 };
		},
		...(options.stopTimeouts ? { stopTimeouts: options.stopTimeouts } : {}),
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
const stack = { "pkg:pi-straw-boss": record("ok") };

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
		for (const stages of [{ "pkg:pi-straw-boss": record("failed") }, { "pkg:pi-straw-boss": record("absent") }, { "pkg:pi-straw-boss": record("pending") }, {}]) {
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

	it("never starts blind on a bootstrap.json it cannot read or that the engine quarantined (R7-F007)", async () => {
		for (const text of ["{ truncated", "[]", JSON.stringify({ schema: 1, stages: [] }), JSON.stringify({ schema: 1, stages: { "pkg:pi-straw-boss": "weird" } })]) {
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
		assert.equal(fresh.startRecord()?.sb?.startTime, null, "found with no record: no kill fallback this run");
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

	it("is not restarted while the stack is being stopped", async () => {
		const w = world();
		await w.supervisor.start();
		await w.supervisor.stop();
		assert.equal(w.children.length, 1);
		assert.equal(w.supervisor.state, "idle");
	});
});

describe("the sb server's pid", () => {
	it("a new pid in server.json is re-recorded; one that belongs to another program is not recorded; a stopped one is ignored", async () => {
		const w = world();
		await w.supervisor.start();
		const slot = join(w.layout.agent, "straw-boss");
		mkdirSync(slot, { recursive: true });
		const write = (rec: Record<string, unknown>) => writeFileSync(join(slot, "server.json"), JSON.stringify(rec));

		write({ pid: 200 });
		const before = w.procs.inspectCalls.length;
		await w.supervisor.pollServerRecord();
		assert.equal(w.procs.inspectCalls.length, before, "the pid the server had at the start reads nothing");

		w.procs.add(201, { startTime: "S201", executable: w.exe("node") });
		write({ pid: 201 });
		await w.supervisor.pollServerRecord();
		assert.deepEqual(w.startRecord()?.sb, { pid: 201, startTime: "S201", slotDir: slot });
		assert.ok(!JSON.stringify(w.startRecord()).includes("S200"), "the old record is gone");

		w.procs.add(900, { startTime: "X", executable: "/usr/bin/python3" });
		write({ pid: 900 });
		await w.supervisor.pollServerRecord();
		assert.deepEqual(w.startRecord()?.sb, { pid: 900, startTime: null, slotDir: slot }, "a server.json pid that is another program's is never recorded");

		w.procs.add(901, { startTime: "Y", executable: w.exe("node") });
		write({ pid: 901, stopped: true });
		await w.supervisor.pollServerRecord();
		assert.equal(w.startRecord()?.sb?.pid, 900);
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

	it("starts the stack again when the work throws, and does not start one that was not running", async () => {
		const running = world();
		await running.supervisor.start();
		await assert.rejects(running.supervisor.withStackStopped(async () => Promise.reject(new Error("npm failed"))), /npm failed/);
		assert.equal(running.supervisor.state, "running");

		const idle = world();
		await idle.supervisor.withStackStopped(async () => "x");
		assert.equal(idle.children.length, 0);
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
