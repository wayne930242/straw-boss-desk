import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { removeTree } from "../src/main/bootstrap/fsutil.ts";
import { fingerprintOf, parseStartRecord, sameFingerprint, StartFile, type StartRecord } from "../src/main/runtime/start-file.ts";
import { StartTimes } from "../src/main/runtime/start-times.ts";
import { scratchRoot, testLayout } from "./harness/engine-fixture.ts";
import { FakeProcesses } from "./harness/runtime-fakes.ts";

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
		await times.herdrReady("started");
		await times.sbReady(200, "started");
		const got = file.read();
		assert.deepEqual(got?.herdr, { pid: 100, startTime: "H1" });
		assert.equal(got?.sb?.startTime, "S1");
	});

	it("does not record a started sb server whose executable is not the app's", async () => {
		const { file, procs, times, record, log } = setup({ eager: true });
		procs.add(200, { startTime: "S1", executable: "/usr/bin/python3" });
		await file.update(() => record());
		await times.sbReady(200, "started");
		assert.equal(file.read()?.sb?.startTime, null);
		assert.ok(log.some((l) => l.event === "start-time-refused" && l.pid === 200));
	});

	it("records the Herdr the app started even when its executable cannot be read (the handle covers it), but not when the start time cannot be read", async () => {
		const { file, procs, times, record, log } = setup({ eager: true });
		procs.add(100, { startTime: "H1", executable: null });
		await file.update(() => record());
		await times.herdrReady("started");
		assert.equal(file.read()?.herdr?.startTime, "H1");
		procs.add(100, { startTime: null, executable: null });
		await times.herdrReady("started");
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
		await times.sbReady(200, "found");
		assert.equal(file.read()?.herdr?.startTime, "H1");
		assert.equal(file.read()?.sb?.startTime, "S1");

		// Both pids are now other processes (the machine rebooted and the numbers were reused).
		procs.add(100, { startTime: "H2", executable: "/usr/bin/sleep" }).add(200, { startTime: "S2", executable: "/usr/bin/sleep" });
		await times.herdrReady("reused");
		await times.sbReady(200, "found");
		assert.equal(file.read()?.herdr?.startTime, null, "no kill fallback for a Herdr whose start time differs");
		assert.equal(file.read()?.sb?.startTime, null);
	});

	it("gives no kill fallback to a found sb server it has no record for, or whose pid is not the recorded one", async () => {
		const { file, procs, times, tool, record } = setup({ eager: true });
		procs.add(200, { startTime: "S1", executable: tool("node") }).add(300, { startTime: "S3", executable: tool("node") });
		await file.update(() => record({ sb: { pid: 300, startTime: null, slotDir: "/slot" } }));
		await times.sbReady(300, "found");
		assert.equal(file.read()?.sb?.startTime, null, "found, with no record: nothing recorded");
		await file.update(() => record({ sb: { pid: 300, startTime: "S3", slotDir: "/slot" } }));
		await times.sbReady(200, "found");
		assert.equal(file.read()?.sb?.pid, 300, "a record is for a pid; `up` named another, which this module leaves to the supervisor's write");
	});
});

describe("Recording (Windows: nothing before the GUI shows, then one call)", () => {
	it("reads nothing until flush, then reads Herdr and the sb server in a single call", async () => {
		const { file, procs, times, tool, record } = setup({ eager: false });
		procs.add(100, { startTime: "H1", executable: tool("herdr") }).add(200, { startTime: "S1", executable: tool("node") });
		await file.update(() => record());
		await times.herdrReady("started");
		await times.sbReady(200, "started");
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
		await times.sbReady(200, "found");
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
		await times.rerecord("sb", 201, { byApp: false });
		const got = file.read();
		assert.deepEqual(got?.sb, { pid: 201, startTime: "S2", slotDir: "/slot" });
		assert.deepEqual(got?.herdr, { pid: 100, startTime: "H1" }, "the other process keeps its record");
		assert.ok(!JSON.stringify(got).includes("S1"), "the old start time is gone");
	});

	it("records a new Herdr the app started by its handle, with no executable check", async () => {
		const { file, procs, times, record } = setup({ eager: true });
		await file.update(() => record());
		procs.add(101, { startTime: "H2", executable: null });
		await times.rerecord("herdr", 101, { byApp: true });
		assert.deepEqual(file.read()?.herdr, { pid: 101, startTime: "H2" });
	});

	it("never records a server.json pid that another program holds now (an executable outside <root>/tools)", async () => {
		const { file, procs, times, record, log } = setup({ eager: true });
		await file.update(() => record({ sb: { pid: 200, startTime: "S1", slotDir: "/slot" } }));
		procs.add(555, { startTime: "X", executable: "/usr/bin/python3" });
		await times.rerecord("sb", 555, { byApp: false });
		assert.deepEqual(file.read()?.sb, { pid: 555, startTime: null, slotDir: "/slot" });
		assert.ok(log.some((l) => l.event === "start-time-refused" && l.pid === 555));
	});

	it("queues reads so two never overlap", async () => {
		const { file, procs, times, tool, record } = setup({ eager: true });
		await file.update(() => record());
		procs.inspectDelayMs = 15;
		procs.add(301, { startTime: "a", executable: tool("node") }).add(302, { startTime: "b", executable: tool("node") }).add(303, { startTime: "c", executable: tool("herdr") });
		await Promise.all([times.rerecord("sb", 301, { byApp: false }), times.rerecord("sb", 302, { byApp: false }), times.rerecord("herdr", 303, { byApp: true })]);
		assert.equal(procs.maxConcurrentInspect, 1);
		assert.equal(file.read()?.sb?.pid, 302, "the later restart wins");
		assert.equal(file.read()?.sb?.startTime, "b");
		assert.deepEqual(file.read()?.herdr, { pid: 303, startTime: "c" });
	});

	it("leaves nothing when the record is gone", async () => {
		const { file, procs, times, tool } = setup({ eager: true });
		procs.add(1, { startTime: "t", executable: tool("node") });
		await times.rerecord("sb", 1, { byApp: false });
		assert.equal(file.read(), null);
	});
});
