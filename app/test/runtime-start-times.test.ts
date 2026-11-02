import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { removeTree } from "../src/main/bootstrap/fsutil.ts";
import { fingerprintOf, parseStartRecord, sameFingerprint, StartFile, type StartRecord } from "../src/main/runtime/start-file.ts";
import { StartTimes } from "../src/main/runtime/start-times.ts";
import { scratchRoot, testLayout } from "./harness/engine-fixture.ts";
import { runStop } from "../src/main/runtime/stop.ts";
import { FakeChild, FakeProcesses, fakeClock, scriptedRun } from "./harness/runtime-fakes.ts";

// Start times in state/start.json (spec: Start times: Recording, Re-recording, Adopting).

const scratch: string[] = [];
after(() => {
	for (const d of scratch) removeTree(d);
});

function setup(options: { eager: boolean }) {
	const made = scratchRoot("sbd-st-");
	scratch.push(made.base);
	const layout = testLayout(made.root);
	const file = new StartFile(layout);
	const procs = new FakeProcesses();
	const log: Array<Record<string, unknown>> = [];
	const times = new StartTimes({ layout, processes: procs, startFile: file, log: (f) => log.push(f), eager: options.eager });
	const tool = (name: string) => join(layout.tools.root, name, "1.0.0", name);
	const record = (over: Partial<StartRecord> = {}): StartRecord => ({
		schema: 1,
		fingerprint: fingerprintOf(layout),
		startedAt: "2026-11-02T00:00:00.000Z",
		herdr: { pid: 100, startTime: null },
		sb: { pid: 200, startTime: null, slotDir: join(layout.agent, "straw-boss") },
		base: null,
		guiMs: null,
		...over,
	});
	return { layout, file, procs, log, times, tool, record };
}

describe("state/start.json", () => {
	it("round-trips a record by rename, and reads a missing file as none", async () => {
		const { file, record, layout } = setup({ eager: true });
		assert.equal(file.read(), null);
		await file.update(() => record({ herdr: { pid: 1, startTime: "t" } }));
		assert.deepEqual(file.read()?.herdr, { pid: 1, startTime: "t" });
		assert.deepEqual(JSON.parse(readFileSync(file.path, "utf8")).fingerprint, fingerprintOf(layout));
		await file.update(() => null);
		assert.equal(existsSync(file.path), false);
	});

	it("treats a file this version did not write (an older kit's) and bad JSON as no record, and says why", () => {
		const { file, layout } = setup({ eager: true });
		mkdirSync(layout.state, { recursive: true });
		const why: string[] = [];
		writeFileSync(file.path, JSON.stringify({ serverPid: 5, serverStart: "x" }));
		assert.equal(file.read((w) => why.push(w)), null);
		writeFileSync(file.path, "{ not json");
		assert.equal(file.read((w) => why.push(w)), null);
		assert.equal(why.length, 2);
	});

	it("never takes an empty string for a start time", () => {
		const { record } = setup({ eager: true });
		const parsed = parseStartRecord({ ...record(), herdr: { pid: 3, startTime: "" } });
		assert.deepEqual(parsed?.herdr, { pid: 3, startTime: null });
	});

	it("the fingerprint must match on every field", () => {
		const { layout } = setup({ eager: true });
		const fp = fingerprintOf(layout);
		assert.equal(sameFingerprint(fp, fp), true);
		for (const field of ["root", "socket", "xdg", "agentDir"] as const) assert.equal(sameFingerprint({ ...fp, [field]: "other" }, fp), false, field);
		assert.equal(sameFingerprint(null, fp), false);
	});

	it("serializes changes: two updates never lose one another", async () => {
		const { file, record } = setup({ eager: true });
		await file.update(() => record());
		await Promise.all([
			file.update((r) => (r ? { ...r, guiMs: 5 } : r)),
			file.update((r) => (r ? { ...r, herdr: { pid: 9, startTime: "t" } } : r)),
		]);
		const final = file.read();
		assert.equal(final?.guiMs, 5);
		assert.equal(final?.herdr?.pid, 9);
	});
});

describe("Recording (macOS: at once)", () => {
	it("records the Herdr the app started and the sb server `up` started, each with the start time read now", async () => {
		const { file, procs, times, tool, record } = setup({ eager: true });
		procs.add(100, { startTime: "H1", executable: tool("herdr") }).add(200, { startTime: "S1", executable: tool("node") });
		await file.update(() => record());
		await times.herdrReady("started", new FakeChild(100));
		await times.sbReady(false);
		const got = file.read();
		assert.deepEqual(got?.herdr, { pid: 100, startTime: "H1" });
		assert.equal(got?.sb?.startTime, "S1");
	});

	it("does not record a started sb server whose executable is not the app's", async () => {
		const { file, procs, times, record, log } = setup({ eager: true });
		procs.add(200, { startTime: "S1", executable: "/usr/bin/python3" });
		await file.update(() => record());
		await times.sbReady(false);
		assert.equal(file.read()?.sb?.startTime, null);
		assert.ok(log.some((l) => l.event === "start-time-refused" && l.pid === 200));
	});

	it("records the Herdr the app started even when its executable cannot be read (the handle covers it), but not when the start time cannot be read", async () => {
		const { file, procs, times, record, log } = setup({ eager: true });
		procs.add(100, { startTime: "H1", executable: null });
		await file.update(() => record());
		const child = new FakeChild(100);
		await times.herdrReady("started", child);
		assert.equal(file.read()?.herdr?.startTime, "H1");
		procs.add(100, { startTime: null, executable: null });
		await times.herdrReady("started", child);
		assert.equal(file.read()?.herdr?.startTime, null);
		assert.ok(log.some((l) => l.event === "start-time-unreadable"));
	});
});

describe("Adopting", () => {
	it("keeps a record whose start time still matches and drops one that does not, for Herdr and for a found sb server", async () => {
		const { file, procs, times, tool, record } = setup({ eager: true });
		await file.update(() => record({ herdr: { pid: 100, startTime: "H1" }, sb: { pid: 200, startTime: "S1", slotDir: "/slot" } }));
		procs.add(100, { startTime: "H1", executable: tool("herdr") }).add(200, { startTime: "S1", executable: tool("node") });
		await times.herdrReady("reused");
		await times.sbReady(true);
		assert.equal(file.read()?.herdr?.startTime, "H1");
		assert.equal(file.read()?.sb?.startTime, "S1");

		// Both pids are now other processes (the machine rebooted and the numbers were reused).
		procs.add(100, { startTime: "H2", executable: "/usr/bin/sleep" }).add(200, { startTime: "S2", executable: "/usr/bin/sleep" });
		await times.herdrReady("reused");
		await times.sbReady(true);
		assert.equal(file.read()?.herdr?.startTime, null, "no kill fallback for a Herdr whose start time differs");
		assert.equal(file.read()?.sb?.startTime, null);
	});

	it("gives no kill fallback to a found sb server whose record has no start time", async () => {
		const { file, procs, times, tool, record } = setup({ eager: true });
		procs.add(300, { startTime: "S3", executable: tool("node") });
		await file.update(() => record({ sb: { pid: 300, startTime: null, slotDir: "/slot" } }));
		await times.sbReady(true);
		assert.equal(file.read()?.sb?.startTime, null, "found, same pid, no record: nothing is recorded on top of a record that was never trusted");
	});

	it("records a found sb server under a pid the record did not name (a pi session restarted it), with the executable check (T8A-F013)", async () => {
		const { file, procs, times, tool, record, log } = setup({ eager: true });
		// `up` answered `found` with pid 201; the record named 200, so the supervisor wrote 201 with no start time and adoption does not apply.
		procs.add(201, { startTime: "S2", executable: tool("node") });
		await file.update(() => record({ sb: { pid: 201, startTime: null, slotDir: "/slot" } }));
		await times.sbReady(false);
		assert.deepEqual(file.read()?.sb, { pid: 201, startTime: "S2", slotDir: "/slot" });
		// A pid that another program holds is never recorded, found or not.
		procs.add(202, { startTime: "X", executable: "/usr/bin/python3" });
		await file.update(() => record({ sb: { pid: 202, startTime: null, slotDir: "/slot" } }));
		await times.sbReady(false);
		assert.equal(file.read()?.sb?.startTime, null);
		assert.ok(log.some((l) => l.event === "start-time-refused" && l.pid === 202));
	});
});

describe("Recording (Windows: nothing before the GUI shows, then one call)", () => {
	it("reads nothing until flush, then reads Herdr and the sb server in a single call", async () => {
		const { file, procs, times, tool, record } = setup({ eager: false });
		procs.add(100, { startTime: "H1", executable: tool("herdr") }).add(200, { startTime: "S1", executable: tool("node") });
		await file.update(() => record());
		await times.herdrReady("started", new FakeChild(100));
		await times.sbReady(false);
		assert.deepEqual(procs.inspectCalls, [], "nothing is read before the GUI shows");
		assert.deepEqual(file.read()?.herdr, { pid: 100, startTime: null });
		await times.flush();
		assert.deepEqual(procs.inspectCalls, [[100, 200]]);
		assert.equal(file.read()?.herdr?.startTime, "H1");
		assert.equal(file.read()?.sb?.startTime, "S1");
		await times.flush();
		assert.equal(procs.inspectCalls.length, 1, "a second flush has nothing left to do");
	});

	it("compares an adopted Herdr's and sb server's start times in that one deferred call", async () => {
		const { file, procs, times, tool, record } = setup({ eager: false });
		procs.add(100, { startTime: "H1", executable: tool("herdr") }).add(200, { startTime: "S9", executable: tool("node") });
		await file.update(() => record({ herdr: { pid: 100, startTime: "H1" }, sb: { pid: 200, startTime: "S1", slotDir: "/slot" } }));
		await times.herdrReady("reused");
		await times.sbReady(true);
		assert.deepEqual(procs.inspectCalls, []);
		await times.flush();
		assert.equal(procs.inspectCalls.length, 1);
		assert.equal(file.read()?.herdr?.startTime, "H1", "matches: kept");
		assert.equal(file.read()?.sb?.startTime, null, "differs: dropped");
	});
});

describe("Re-recording", () => {
	it("drops the old record first, then records the new pid's start time with the same read", async () => {
		const { file, procs, times, tool, record } = setup({ eager: true });
		await file.update(() => record({ herdr: { pid: 100, startTime: "H1" }, sb: { pid: 200, startTime: "S1", slotDir: "/slot" } }));
		procs.add(201, { startTime: "S2", executable: tool("node") });
		await times.rerecord("sb", 201, {});
		const got = file.read();
		assert.deepEqual(got?.sb, { pid: 201, startTime: "S2", slotDir: "/slot" });
		assert.deepEqual(got?.herdr, { pid: 100, startTime: "H1" }, "the other process keeps its record");
		assert.ok(!JSON.stringify(got).includes("S1"), "the old start time is gone");
	});

	it("records a new Herdr the app started by its handle, with no executable check", async () => {
		const { file, procs, times, record } = setup({ eager: true });
		await file.update(() => record());
		procs.add(101, { startTime: "H2", executable: null });
		await times.rerecord("herdr", 101, { handle: new FakeChild(101) });
		assert.deepEqual(file.read()?.herdr, { pid: 101, startTime: "H2" });
	});

	it("never records a server.json pid that another program holds now (an executable outside <root>/tools)", async () => {
		const { file, procs, times, record, log } = setup({ eager: true });
		await file.update(() => record({ sb: { pid: 200, startTime: "S1", slotDir: "/slot" } }));
		procs.add(555, { startTime: "X", executable: "/usr/bin/python3" });
		await times.rerecord("sb", 555, {});
		assert.deepEqual(file.read()?.sb, { pid: 555, startTime: null, slotDir: "/slot" });
		assert.ok(log.some((l) => l.event === "start-time-refused" && l.pid === 555));
	});

	it("queues reads so two never overlap", async () => {
		const { file, procs, times, tool, record } = setup({ eager: true });
		await file.update(() => record());
		procs.inspectDelayMs = 15;
		procs.add(301, { startTime: "a", executable: tool("node") }).add(302, { startTime: "b", executable: tool("node") }).add(303, { startTime: "c", executable: tool("herdr") });
		await Promise.all([times.rerecord("sb", 301, {}), times.rerecord("sb", 302, {}), times.rerecord("herdr", 303, { handle: new FakeChild(303) })]);
		assert.equal(procs.maxConcurrentInspect, 1);
		assert.equal(file.read()?.sb?.pid, 302, "the later restart wins");
		assert.equal(file.read()?.sb?.startTime, "b");
		assert.deepEqual(file.read()?.herdr, { pid: 303, startTime: "c" });
	});

	it("leaves nothing when the record is gone", async () => {
		const { file, procs, times, tool } = setup({ eager: true });
		procs.add(1, { startTime: "t", executable: tool("node") });
		await times.rerecord("sb", 1, {});
		assert.equal(file.read(), null);
	});
});

describe("a start time is recorded only for a process that is the app's through the whole read (T8A-F001)", () => {
	// A stop whose CLIs do nothing and whose Herdr never answers: only the kill step decides.
	async function stopWith(w: ReturnType<typeof setup>, handle: FakeChild | null) {
		const run = scriptedRun([{ match: () => true, answer: { code: 0 } }]);
		return runStop({
			layout: w.layout,
			processes: w.procs,
			run,
			startFile: w.file,
			herdr: { stopServer: async () => ({ code: 1, text: "no server" }), answers: async () => false } as never,
			env: {},
			nodePath: "node",
			sbCli: join(w.layout.agent, "npm", "node_modules", "pi-straw-boss", "dist", "server", "cli.mjs"),
			herdrHandle: handle,
			clock: fakeClock(),
			log: (f) => w.log.push(f),
			pidAlive: (pid) => w.procs.has(pid),
		});
	}

	it("records nothing when the Herdr the app started ended during the read and its pid went to a program under <root>/tools, and a stop then kills nothing", async () => {
		const w = setup({ eager: false });
		w.procs.add(100, { startTime: "H1", executable: w.tool("herdr") });
		await w.file.update(() => w.record({ sb: null }));
		const child = new FakeChild(100);
		await w.times.herdrReady("started", child);
		// Windows: the read is a PowerShell call after the GUI shows. Herdr ends while it runs and another program of the app (a node under tools) gets the pid; the read
		// returns that program's start time and executable, which pass the executable check, so only the handle can tell.
		const read = w.procs.inspect.bind(w.procs);
		w.procs.inspect = async (pids) => {
			child.end(1);
			w.procs.table.set(100, { startTime: "STRANGER", executable: w.tool("node") });
			return read(pids);
		};
		await w.times.flush();
		assert.equal(w.file.read()?.herdr?.startTime, null, "the stranger's start time is not Herdr's");
		assert.ok(w.log.some((l) => l.event === "start-time-refused" && l.pid === 100));
		assert.ok(!w.log.some((l) => l.event === "start-time-recorded"));
		const report = await stopWith(w, child);
		assert.deepEqual(w.procs.killed, [], "the program that holds the pid now is never killed");
		assert.deepEqual(report.refused.map((r) => [r.what, r.pid, r.reason]), [["herdr", 100, "no-start-time"]]);
	});

	it("records nothing when the handle had already ended before the read ran", async () => {
		const w = setup({ eager: false });
		w.procs.add(100, { startTime: "H1", executable: w.tool("herdr") });
		await w.file.update(() => w.record({ sb: null }));
		const child = new FakeChild(100);
		await w.times.herdrReady("started", child);
		child.end(1);
		await w.times.flush();
		assert.equal(w.file.read()?.herdr?.startTime, null);
	});

	it("records nothing for a restarted Herdr whose handle ended during the read, and keeps recording one whose handle is still held", async () => {
		const w = setup({ eager: false });
		await w.file.update(() => w.record());
		const gone = new FakeChild(101);
		w.procs.add(101, { startTime: "H2", executable: w.tool("herdr") });
		const read = w.procs.inspect.bind(w.procs);
		w.procs.inspect = async (pids) => {
			gone.end(1);
			return read(pids);
		};
		await w.times.rerecord("herdr", 101, { handle: gone });
		assert.deepEqual(w.file.read()?.herdr, { pid: 101, startTime: null }, "the old record is gone and no new one was written");
		w.procs.inspect = read;
		w.procs.add(102, { startTime: "H3", executable: w.tool("herdr") });
		await w.times.rerecord("herdr", 102, { handle: new FakeChild(102) });
		assert.deepEqual(w.file.read()?.herdr, { pid: 102, startTime: "H3" });
	});

	it("never trusts a restarted Herdr given without a handle: the executable check applies", async () => {
		const w = setup({ eager: false });
		await w.file.update(() => w.record());
		w.procs.add(103, { startTime: "H4", executable: "/usr/bin/python3" });
		await w.times.rerecord("herdr", 103, {});
		assert.equal(w.file.read()?.herdr?.startTime, null);
	});

	it("refuses a start time whose executable is outside <root>/tools even while the handle is held, and still records one whose executable cannot be read", async () => {
		const w = setup({ eager: true });
		await w.file.update(() => w.record({ sb: null }));
		w.procs.add(100, { startTime: "H1", executable: "/usr/bin/python3" });
		const child = new FakeChild(100);
		await w.times.herdrReady("started", child);
		assert.equal(w.file.read()?.herdr?.startTime, null);
		assert.ok(w.log.some((l) => l.event === "start-time-refused" && /not under/.test(String(l.why))));
		w.procs.add(100, { startTime: "H1", executable: null });
		await w.times.herdrReady("started", child);
		assert.equal(w.file.read()?.herdr?.startTime, "H1", "an unreadable executable is covered by the handle alone");
	});
});
