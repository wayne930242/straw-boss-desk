import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { removeTree } from "../src/main/bootstrap/fsutil.ts";
import { HerdrControl } from "../src/main/runtime/herdr.ts";
import { fingerprintOf, StartFile, type StartRecord } from "../src/main/runtime/start-file.ts";
import { runStop, stopTimeoutsFor, type StopDeps } from "../src/main/runtime/stop.ts";
import { scratchRoot, testLayout } from "./harness/engine-fixture.ts";
import { FakeChild, FakeProcesses, fakeClock, scriptedRun, type Call } from "./harness/runtime-fakes.ts";

// The stop sequence (spec: Stop): cli.mjs stop, wait 10 s for the sb server, herdr server stop, kill what is left only by the rule, then one listing.
// The process table is a Map and the programs are scripted; nothing real runs.

const scratch: string[] = [];
after(() => {
	for (const d of scratch) removeTree(d);
});

const SB_START = "Mon Nov  2 10:00:05 2026";
const HERDR_START = "Mon Nov  2 10:00:01 2026";

interface Options {
	/** What `cli.mjs stop` does: exit code, and whether it ends the sb server. */
	cliStop?: { code: number; endsSb: boolean; stdout?: string; stderr?: string };
	/** Whether `herdr server stop` ends the server. */
	herdrStopEnds?: boolean;
	records?: { herdr?: boolean; sb?: boolean; herdrStart?: string | null; sbStart?: string | null };
	handle?: boolean;
	timeouts?: Partial<StopDeps["timeouts"]>;
}

function world(options: Options = {}) {
	const made = scratchRoot("sbd-stop-");
	scratch.push(made.base);
	const layout = testLayout(made.root);
	const exe = (name: string) => join(layout.tools.root, name, "1.0.0", name);
	const sbCli = join(layout.agent, "npm", "node_modules", "pi-straw-boss", "dist", "server", "cli.mjs");
	mkdirSync(dirname(sbCli), { recursive: true });
	writeFileSync(sbCli, "stub");
	const procs = new FakeProcesses().add(100, { startTime: HERDR_START, executable: exe("herdr") }).add(200, { startTime: SB_START, executable: exe("node") });
	const order: string[] = [];
	let herdrUp = true;
	const cli = { code: 0, endsSb: true, stdout: '{"outcome":"stopped"}\n', stderr: "Stopping the sb server on purpose\n", ...options.cliStop };
	const child = options.handle ? new FakeChild(100) : null;
	const run = scriptedRun([
		{
			match: (c) => c.args[0] === sbCli && c.args[1] === "stop",
			answer: () => {
				order.push("cli.mjs stop");
				if (cli.endsSb) procs.table.delete(200);
				return { code: cli.code, stdout: cli.stdout, stderr: cli.stderr };
			},
		},
		{
			match: (c) => c.args[0] === "server" && c.args[1] === "stop",
			answer: () => {
				order.push("herdr server stop");
				if (options.herdrStopEnds ?? true) {
					herdrUp = false;
					procs.table.delete(100);
					child?.end(0);
				}
				return { code: 0, stdout: "", stderr: "" };
			},
		},
		{ match: (c) => c.args[0] === "workspace" && c.args[1] === "list", answer: () => ({ code: herdrUp ? 0 : 1 }) },
	]);
	procs.onKill = (pid) => order.push(`kill ${pid}`);
	const startFile = new StartFile(layout);
	const rec = options.records ?? { herdr: true, sb: true };
	const record: StartRecord = {
		schema: 1,
		fingerprint: fingerprintOf(layout),
		startedAt: "2026-11-02T00:00:00.000Z",
		herdr: rec.herdr === false ? null : { pid: 100, startTime: rec.herdrStart === undefined ? HERDR_START : rec.herdrStart },
		sb: rec.sb === false ? null : { pid: 200, startTime: rec.sbStart === undefined ? SB_START : rec.sbStart, slotDir: join(layout.agent, "straw-boss") },
		base: null,
		guiMs: null,
	};
	const clock = fakeClock();
	const log: Array<Record<string, unknown>> = [];
	const env = { PI_CODING_AGENT_DIR: layout.agent };
	const herdr = new HerdrControl({ binary: "herdr", env, run, spawn: () => new FakeChild(undefined), clock, log: (f) => log.push(f) });
	const deps: StopDeps = {
		layout,
		processes: procs,
		run,
		startFile,
		herdr,
		env,
		nodePath: "node",
		sbCli,
		sbPackageVerified: true,
		herdrHandle: child,
		clock,
		log: (f) => log.push(f),
		pidAlive: (pid) => procs.has(pid),
		readServerRecord: () => null,
		...(options.timeouts ? { timeouts: options.timeouts } : {}),
	};
	return { layout, procs, run, startFile, record, deps, order, log, clock, child, exe, sbCli, setHerdrUp: (up: boolean) => (herdrUp = up) };
}

const callsTo = (calls: Call[], arg: string) => calls.filter((c) => c.args.includes(arg));

describe("the stop sequence", () => {
	it("stops the sb server through its CLI, then Herdr, and kills nothing when both leave; start.json goes", async () => {
		const w = world();
		await w.startFile.update(() => w.record);
		const report = await runStop(w.deps);
		assert.equal(report.ok, true, report.notes.join("; "));
		assert.deepEqual(w.order, ["cli.mjs stop", "herdr server stop"]);
		assert.deepEqual(w.procs.killed, []);
		assert.deepEqual(report.leftovers, []);
		assert.equal(report.herdrAnswers, false);
		assert.equal(existsSync(w.startFile.path), false, "nothing is left, so the record goes");
		assert.equal(report.cliStop.exit, 0);
		assert.equal(report.cliStop.outcome, "stopped");
	});

	it("runs cli.mjs stop with the constructed environment and nothing else, and the limits of the platform (120 s Windows, 45 s macOS)", async () => {
		const w = world();
		await w.startFile.update(() => w.record);
		await runStop(w.deps);
		const call = w.run.calls.find((c) => c.args[1] === "stop" && c.args[0] === w.sbCli);
		assert.equal(call?.options?.replaceEnv, true);
		assert.deepEqual(call?.options?.env, { PI_CODING_AGENT_DIR: w.layout.agent });
		assert.equal(call?.options?.timeoutMs, stopTimeoutsFor(w.layout.platform).cliStopMs);
		assert.deepEqual([stopTimeoutsFor("win32").cliStopMs, stopTimeoutsFor("darwin").cliStopMs], [120_000, 45_000]);
	});

	it("a test stop whose cli.mjs stop leaves the sb server running reports it by pid when it may not kill it", async () => {
		const w = world({ cliStop: { code: 1, endsSb: false, stderr: "Stopping the sb server on purpose\nexit-timeout: the server was asked and did not exit\n", stdout: "" }, records: { herdr: true, sb: true, sbStart: null } });
		await w.startFile.update(() => w.record);
		const report = await runStop(w.deps);
		assert.equal(report.ok, false);
		assert.deepEqual(w.procs.killed, [], "no start time recorded for the sb server, so nothing is killed");
		assert.deepEqual(report.leftovers, [{ pid: 200, file: "node" }]);
		assert.ok(report.refused.some((r) => r.what === "sb-server" && r.pid === 200 && r.reason === "no-start-time"));
		assert.ok(report.notes.some((n) => n.includes("pid 200") && n.includes("node")), report.notes.join("; "));
		assert.match(report.cliStop.detail, /exit-timeout/);
		assert.ok(w.log.some((l) => l.event === "stop-end" && JSON.stringify(l.leftovers) === '[{"pid":200,"file":"node"}]'), "logged for logs/start.jsonl");
		assert.equal(existsSync(w.startFile.path), true, "the record stays so a second stop can finish the job");
	});

	it("waits 10 s for the sb server, then kills it by pid only while the recorded start time matches, before Herdr stops", async () => {
		const w = world({ cliStop: { code: 1, endsSb: false, stderr: "x\nexit-timeout\n", stdout: "" } });
		await w.startFile.update(() => w.record);
		const report = await runStop(w.deps);
		assert.deepEqual(w.procs.killed, [200]);
		assert.deepEqual(w.order, ["cli.mjs stop", "kill 200", "herdr server stop"], "the server goes before Herdr stops");
		assert.ok(w.clock.slept.filter((ms) => ms === 250).length >= 39, "it waited about 10 s in quarter seconds");
		assert.equal(report.ok, true);
		assert.deepEqual(report.killed.map((k) => k.pid), [200]);
	});

	it("never kills a recorded pid that another process holds now (another start time)", async () => {
		const w = world({ cliStop: { code: 1, endsSb: false, stderr: "x\nexit-timeout\n", stdout: "" } });
		w.procs.add(200, { startTime: "Mon Nov  2 11:59:59 2026", executable: join(w.layout.tools.root, "node", "1.0.0", "node") });
		await w.startFile.update(() => w.record);
		const report = await runStop(w.deps);
		assert.deepEqual(w.procs.killed, []);
		assert.ok(report.refused.some((r) => r.pid === 200 && r.reason === "start-time-differs"));
		assert.equal(report.ok, false);
	});

	it("with the start times removed from start.json, kills nothing and reports whatever is left", async () => {
		const w = world({ cliStop: { code: 1, endsSb: false, stderr: "x\nexit-timeout\n", stdout: "" }, herdrStopEnds: false, records: { herdr: true, sb: true, herdrStart: null, sbStart: null } });
		await w.startFile.update(() => w.record);
		const report = await runStop(w.deps);
		assert.deepEqual(w.procs.killed, []);
		assert.deepEqual(report.leftovers.map((l) => l.pid), [100, 200]);
		assert.equal(report.herdrAnswers, true, "Herdr still answers, and that is reported");
		assert.ok(report.notes.some((n) => /Herdr server still answers/.test(n)));
		assert.equal(report.ok, false);
	});

	it("kills a Herdr that ignored `herdr server stop` through the handle the app holds, with no record", async () => {
		const w = world({ herdrStopEnds: false, handle: true, records: { herdr: false, sb: true } });
		await w.startFile.update(() => ({ ...w.record, herdr: null }));
		// The kill ends the process in the table as well.
		w.child!.onKill = () => {
			w.procs.table.delete(100);
			w.setHerdrUp(false);
		};
		const report = await runStop(w.deps);
		assert.deepEqual(w.child?.signals, ["SIGKILL"]);
		assert.deepEqual(w.procs.killed, [], "the handle did the killing, not a kill by pid");
		assert.equal(report.ok, true, report.notes.join("; "));
	});

	it("kills a Herdr that ignored `herdr server stop` by pid when its recorded start time matches", async () => {
		const w = world({ herdrStopEnds: false });
		await w.startFile.update(() => w.record);
		w.procs.onKill = (pid) => {
			if (pid === 100) w.setHerdrUp(false);
		};
		const report = await runStop(w.deps);
		assert.deepEqual(w.procs.killed, [100]);
		assert.equal(report.ok, true, report.notes.join("; "));
	});

	it("never kills a serve server (exit 5), whatever the record says, and reports it", async () => {
		const w = world({ cliStop: { code: 5, endsSb: false, stderr: "refused: this is a serve server\n", stdout: "" } });
		await w.startFile.update(() => w.record);
		const report = await runStop(w.deps);
		assert.deepEqual(w.procs.killed.filter((p) => p === 200), []);
		assert.ok(report.notes.some((n) => /serve server/.test(n)));
		assert.deepEqual(report.leftovers.map((l) => l.pid), [200]);
	});

	it("reports an acl refusal and a failed cli.mjs stop, and goes on with Herdr", async () => {
		const acl = world({ cliStop: { code: 3, endsSb: true, stderr: "acl: the state folder belongs to another account\n", stdout: "" } });
		await acl.startFile.update(() => acl.record);
		const report = await runStop(acl.deps);
		assert.ok(report.notes.some((n) => /refused \(acl\)/.test(n)));
		assert.deepEqual(acl.order, ["cli.mjs stop", "herdr server stop"]);
	});

	it("stops the CLIs even with nothing recorded, and then looks for what runs", async () => {
		const w = world({ records: { herdr: false, sb: false } });
		const report = await runStop(w.deps);
		assert.equal(w.order[0], "cli.mjs stop");
		assert.ok(w.order.includes("herdr server stop"));
		assert.deepEqual(w.procs.killed, []);
		assert.equal(report.ok, true);
	});

	it("follows the sb server to a new pid in server.json, but only through the recording that checks its executable", async () => {
		const w = world({ cliStop: { code: 1, endsSb: false, stderr: "x\nexit-timeout\n", stdout: "" } });
		await w.startFile.update(() => w.record);
		w.procs.add(300, { startTime: "S300", executable: join(w.layout.tools.root, "node", "1.0.0", "node") });
		const synced: number[] = [];
		w.deps.readServerRecord = () => ({ pid: 300, stopped: false });
		w.deps.syncSbRecord = async (pid) => {
			synced.push(pid);
			await w.startFile.update((r) => (r ? { ...r, sb: { pid, startTime: "S300", slotDir: r.sb?.slotDir ?? "" } } : r));
		};
		w.procs.table.delete(200);
		const report = await runStop(w.deps);
		assert.deepEqual(synced, [300]);
		assert.deepEqual(w.procs.killed, [300]);
		assert.equal(report.ok, true);
	});

	it("does not follow a server.json that says stopped, or one that names the recorded pid", async () => {
		for (const current of [{ pid: 999, stopped: true }, { pid: 200, stopped: false }]) {
			const w = world();
			await w.startFile.update(() => w.record);
			const synced: number[] = [];
			w.deps.syncSbRecord = async (pid) => void synced.push(pid);
			w.deps.readServerRecord = () => current;
			await runStop(w.deps);
			assert.deepEqual(synced, [], JSON.stringify(current));
		}
	});
});

describe("a pi-straw-boss that is not verified (R8A-F001)", () => {
	it("does not run cli.mjs stop when no sb server of the record runs, and the stop goes on with Herdr", async () => {
		const w = world({ records: { herdr: true, sb: false } });
		w.procs.table.delete(200);
		await w.startFile.update(() => w.record);
		w.deps.sbPackageVerified = false;
		const report = await runStop(w.deps);
		assert.deepEqual(w.order, ["herdr server stop"]);
		assert.equal(report.cliStop.ran, false);
		assert.equal(report.ok, true, report.notes.join("; "));
	});

	it("reports an sb server that no record names instead of stopping or killing it", async () => {
		const w = world({ records: { herdr: true, sb: false } });
		await w.startFile.update(() => w.record);
		w.deps.sbPackageVerified = false;
		w.deps.readServerRecord = () => ({ pid: 200, stopped: false });
		const report = await runStop(w.deps);
		assert.equal(w.order.includes("cli.mjs stop"), false);
		assert.deepEqual(w.procs.killed, []);
		assert.equal(report.unverifiedSb, 200);
		assert.equal(report.ok, false);
		assert.ok(w.log.some((l) => l.event === "sb-server-unverified" && l.pid === 200));
	});

	// T8C-F001. `cli.mjs stop` is a new process: it loads the package's files from disk now. A recorded server running does not make those files trusted, so no CLI runs, and
	// the server is ended by the kill rule alone, before Herdr stops.
	it("runs no cli.mjs stop for a recorded sb server that runs, and ends it by its recorded start time (T8C-F001)", async () => {
		const w = world();
		await w.startFile.update(() => w.record);
		w.deps.sbPackageVerified = false;
		const report = await runStop(w.deps);
		assert.equal(report.cliStop.ran, false);
		assert.equal(w.run.calls.some((c) => c.args[0] === w.sbCli), false, "the unverified package's cli.mjs did not start");
		assert.deepEqual(w.order, ["kill 200", "herdr server stop"]);
		assert.deepEqual(w.procs.killed, [200]);
		assert.equal(report.unverifiedSb, null);
		assert.equal(report.ok, true, report.notes.join("; "));
	});

	it("reports a recorded sb server of an unverified package whose start time differs or is missing, and kills nothing (T8C-F001)", async () => {
		for (const sbStart of ["Mon Nov  2 11:11:11 2026", null]) {
			const w = world({ records: { herdr: true, sb: true, sbStart } });
			await w.startFile.update(() => w.record);
			w.deps.sbPackageVerified = false;
			const report = await runStop(w.deps);
			assert.equal(w.run.calls.some((c) => c.args[0] === w.sbCli), false);
			assert.deepEqual(w.procs.killed, [], String(sbStart));
			assert.equal(report.unverifiedSb, 200, String(sbStart));
			assert.equal(report.ok, false);
			assert.ok(w.log.some((l) => l.event === "sb-server-unverified" && l.pid === 200));
		}
	});
});

describe("a recorded sb server of an unverified package that leaves while the stop looks at it (T8B-F004)", () => {
	it("is not reported as unverified when it exited between the verdict and the kill", async () => {
		const w = world();
		await w.startFile.update(() => w.record);
		w.deps.sbPackageVerified = false;
		// The verdict reads the process (it is there, its start time is the record's), and the process leaves before `kill` runs.
		const inspect = w.procs.inspect.bind(w.procs);
		w.procs.inspect = async (pids) => {
			const answer = await inspect(pids);
			w.procs.table.delete(200);
			return answer;
		};
		const report = await runStop(w.deps);
		assert.equal(report.unverifiedSb, null);
		assert.equal(report.ok, true, report.notes.join("; "));
		assert.ok(!w.log.some((l) => l.event === "sb-server-unverified"));
	});

	it("is still reported when the kill failed and the process runs on", async () => {
		const w = world();
		await w.startFile.update(() => w.record);
		w.deps.sbPackageVerified = false;
		w.procs.kill = (pid) => {
			w.procs.killed.push(pid);
			return false; // refused by the OS: the process stays
		};
		const report = await runStop(w.deps);
		assert.equal(report.unverifiedSb, 200);
		assert.equal(report.ok, false);
	});
});

describe("the intercom broker", () => {
	const brokerFile = (layout: ReturnType<typeof testLayout>) => join(layout.agent, "intercom", "broker.pid");

	it("is killed when broker.pid names a program of this app and its start time is unchanged", async () => {
		const w = world();
		await w.startFile.update(() => w.record);
		mkdirSync(dirname(brokerFile(w.layout)), { recursive: true });
		writeFileSync(brokerFile(w.layout), "400\n");
		w.procs.add(400, { startTime: "B1", executable: w.exe("node") });
		const report = await runStop(w.deps);
		assert.deepEqual(w.procs.killed, [400]);
		assert.deepEqual(report.killed.map((k) => k.pid), [400]);
		assert.equal(report.ok, true);
	});

	it("is left alone when broker.pid names a program that is not the app's (a stale pid another program holds now)", async () => {
		const w = world();
		await w.startFile.update(() => w.record);
		mkdirSync(dirname(brokerFile(w.layout)), { recursive: true });
		writeFileSync(brokerFile(w.layout), "401");
		w.procs.add(401, { startTime: "B1", executable: "/usr/bin/python3" });
		const report = await runStop(w.deps);
		assert.deepEqual(w.procs.killed, []);
		assert.ok(report.notes.some((n) => n.includes("401") && /not a program of this app/.test(n)));
		assert.equal(w.procs.has(401), true);
	});

	it("is not killed when the pid changed hands between the snapshot and the kill", async () => {
		const w = world();
		await w.startFile.update(() => w.record);
		mkdirSync(dirname(brokerFile(w.layout)), { recursive: true });
		writeFileSync(brokerFile(w.layout), "402");
		w.procs.add(402, { startTime: "B1", executable: w.exe("node") });
		// After `herdr server stop` the broker's pid is taken by an unrelated process with the same executable path but another start time.
		w.procs.onKill = () => {};
		const real = w.deps.herdr.stopServer.bind(w.deps.herdr);
		w.deps.herdr.stopServer = async (ms) => {
			w.procs.add(402, { startTime: "B2", executable: w.exe("node") });
			return real(ms);
		};
		const report = await runStop(w.deps);
		assert.deepEqual(w.procs.killed, []);
		assert.ok(report.refused.some((r) => r.what === "intercom-broker" && r.reason === "start-time-differs"));
	});
});

describe("a fast stop (Windows session-end)", () => {
	it("runs cli.mjs stop with the limit it is given and nothing else", async () => {
		const w = world();
		await w.startFile.update(() => w.record);
		w.deps.onlyCliStopMs = 10_000;
		const report = await runStop(w.deps);
		assert.deepEqual(w.order, ["cli.mjs stop"]);
		assert.equal(callsTo(w.run.calls, "stop")[0]?.options?.timeoutMs, 10_000);
		assert.equal(w.procs.inspectCalls.length, 0 + (existsSync(join(w.layout.agent, "intercom", "broker.pid")) ? 1 : 0));
		assert.equal(report.cliStop.exit, 0);
	});
});
