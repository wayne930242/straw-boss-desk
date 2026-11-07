import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { createMacProcesses, parseLsofExecutables } from "../src/main/platform/mac.ts";
import { PROCESS_SCRIPT } from "../src/main/platform/win-scripts.ts";
import { createMacLocate } from "../src/main/platform/mac.ts";
import { removeTree } from "../src/main/bootstrap/fsutil.ts";
import { isUnderTools, killOwned, killVerdict, listLeftovers, readRecord, SerialQueue } from "../src/main/runtime/identity.ts";
import { scratchRoot, testLayout } from "./harness/engine-fixture.ts";
import { FakeChild, FakeProcesses, scriptedRun } from "./harness/runtime-fakes.ts";

// The desk kill invariant (spec: Runtime supervisor, Start times; desk spec): the app kills or adopts only by a held handle or a matching recorded start time,
// and the leftover listing goes by the full executable path, never by a command line.

const scratch: string[] = [];
after(() => {
	for (const d of scratch) removeTree(d);
});
const layoutOf = () => {
	const made = scratchRoot("sbd-id-");
	scratch.push(made.base);
	return testLayout(made.root);
};

describe("killVerdict", () => {
	it("allows a pid the app holds a live handle for, with no record at all", async () => {
		const procs = new FakeProcesses();
		const child = new FakeChild(10);
		assert.deepEqual(await killVerdict(procs, { pid: 10, record: null, handle: child }), { may: true, via: "handle" });
		assert.deepEqual(procs.inspectCalls, [], "the handle needs no read of the process table");
	});

	it("does not trust a handle that has exited, or one for another pid", async () => {
		const procs = new FakeProcesses();
		const done = new FakeChild(10);
		done.end(0);
		assert.deepEqual(await killVerdict(procs, { pid: 10, record: null, handle: done }), { may: false, reason: "no-record" });
		assert.deepEqual(await killVerdict(procs, { pid: 11, record: null, handle: new FakeChild(10) }), { may: false, reason: "no-record" });
	});

	it("allows a recorded pid whose current start time equals the record", async () => {
		const procs = new FakeProcesses().add(20, { startTime: "Mon Nov  2 10:00:00 2026", executable: "/x/tools/node" });
		assert.deepEqual(await killVerdict(procs, { pid: 20, record: { pid: 20, startTime: "Mon Nov  2 10:00:00 2026" } }), { may: true, via: "start-time" });
	});

	it("never allows a recorded pid that another process holds now (a dummy process with another start time)", async () => {
		const procs = new FakeProcesses().add(20, { startTime: "Mon Nov  2 11:30:00 2026", executable: "/usr/bin/sleep" });
		assert.deepEqual(await killVerdict(procs, { pid: 20, record: { pid: 20, startTime: "Mon Nov  2 10:00:00 2026" } }), { may: false, reason: "start-time-differs" });
	});

	it("never allows a record without a start time, an empty one, or a record for another pid", async () => {
		const procs = new FakeProcesses().add(20, { startTime: "t", executable: null });
		assert.deepEqual(await killVerdict(procs, { pid: 20, record: { pid: 20, startTime: null } }), { may: false, reason: "no-start-time" });
		assert.deepEqual(await killVerdict(procs, { pid: 20, record: { pid: 20, startTime: "" } }), { may: false, reason: "no-start-time" });
		assert.deepEqual(await killVerdict(procs, { pid: 21, record: { pid: 20, startTime: "t" } }), { may: false, reason: "no-record" });
		assert.deepEqual(await killVerdict(procs, { pid: 20, record: null }), { may: false, reason: "no-record" });
		assert.deepEqual(procs.inspectCalls, [], "a refusal without a start time reads nothing");
	});

	it("never allows a process that is gone or whose start time cannot be read", async () => {
		const procs = new FakeProcesses().add(30, { startTime: null, executable: null });
		assert.equal((await killVerdict(procs, { pid: 30, record: { pid: 30, startTime: "t" } })).may, false);
		assert.equal((await killVerdict(procs, { pid: 31, record: { pid: 31, startTime: "t" } })).may, false);
	});
});

describe("killOwned", () => {
	it("kills through the handle when it holds one, and by pid when the start time matches", async () => {
		const procs = new FakeProcesses().add(40, { startTime: "t", executable: null });
		const child = new FakeChild(41);
		const viaHandle = await killOwned(procs, { pid: 41, record: null, handle: child });
		assert.equal(viaHandle.killed, true);
		assert.deepEqual(child.signals, ["SIGKILL"]);
		assert.deepEqual(procs.killed, [], "the handle did the killing");
		const byTime = await killOwned(procs, { pid: 40, record: { pid: 40, startTime: "t" } });
		assert.equal(byTime.killed, true);
		assert.deepEqual(procs.killed, [40]);
	});

	it("calls kill on nothing when the rule refuses", async () => {
		const procs = new FakeProcesses().add(50, { startTime: "other", executable: null });
		const child = new FakeChild(50);
		child.end(0);
		const refused = await killOwned(procs, { pid: 50, record: { pid: 50, startTime: "recorded" }, handle: child });
		assert.equal(refused.killed, false);
		assert.deepEqual(procs.killed, []);
		assert.deepEqual(child.signals, []);
		assert.equal(procs.has(50), true);
	});
});

describe("isUnderTools and readRecord", () => {
	it("tells the app's executables by their full path under <root>/tools", () => {
		const layout = layoutOf();
		assert.equal(isUnderTools(layout, join(layout.tools.root, "node", "24.0.0", "bin", "node")), true);
		assert.equal(isUnderTools(layout, layout.tools.root), false, "the folder itself is not a program");
		assert.equal(isUnderTools(layout, join(layout.root, "toolsX", "node")), false);
		assert.equal(isUnderTools(layout, "/usr/bin/sleep"), false);
	});

	it("records a pid the app did not start only when its executable lies under the tools folder", async () => {
		const layout = layoutOf();
		const procs = new FakeProcesses()
			.add(60, { startTime: "t60", executable: join(layout.tools.root, "node", "24.0.0", "bin", "node") })
			.add(61, { startTime: "t61", executable: "/usr/bin/python3" })
			.add(62, { startTime: "", executable: join(layout.tools.root, "node", "node") });
		assert.deepEqual((await readRecord(procs, layout, 60, { requireUnderTools: true })).record, { pid: 60, startTime: "t60" });
		const other = await readRecord(procs, layout, 61, { requireUnderTools: true });
		assert.equal(other.record, null);
		assert.equal(other.refused, "outside-tools");
		assert.equal((await readRecord(procs, layout, 61, { requireUnderTools: false })).record?.startTime, "t61", "a process the app started is recorded wherever it runs");
		assert.equal((await readRecord(procs, layout, 62, { requireUnderTools: true })).refused, "unreadable", "an empty start time is no start time");
		assert.equal((await readRecord(procs, layout, 63, { requireUnderTools: true })).refused, "unreadable");
	});
});

describe("listLeftovers", () => {
	it("lists the processes whose executable is under <root>/tools, by pid and file name, and leaves out the app's own pid", async () => {
		const layout = layoutOf();
		const exe = (name: string) => join(layout.tools.root, "node", "24.0.0", "bin", name);
		const procs = new FakeProcesses()
			.add(process.pid, { startTime: "me", executable: exe("node") })
			.add(70, { startTime: "a", executable: exe("node") })
			.add(71, { startTime: "b", executable: join(layout.tools.root, "herdr", "0.9.5", "herdr") })
			.add(72, { startTime: "c", executable: "/usr/bin/sleep" });
		assert.deepEqual(await listLeftovers(procs, layout), [
			{ pid: 70, file: "node" },
			{ pid: 71, file: "herdr" },
		]);
		assert.deepEqual(await listLeftovers(procs, layout, [70]), [{ pid: 71, file: "herdr" }]);
	});
});

describe("SerialQueue", () => {
	it("runs one job at a time in order, and goes on after a job that failed", async () => {
		const queue = new SerialQueue();
		const order: string[] = [];
		let running = 0;
		let most = 0;
		const job = (name: string, ms: number, fail = false) => () => {
			running++;
			most = Math.max(most, running);
			order.push(`start ${name}`);
			return new Promise<string>((resolve, reject) =>
				setTimeout(() => {
					running--;
					order.push(`end ${name}`);
					if (fail) reject(new Error(name));
					else resolve(name);
				}, ms),
			);
		};
		const results = await Promise.allSettled([queue.run(job("a", 20)), queue.run(job("b", 5, true)), queue.run(job("c", 1))]);
		assert.deepEqual(results.map((r) => r.status), ["fulfilled", "rejected", "fulfilled"]);
		assert.equal(most, 1);
		assert.deepEqual(order, ["start a", "end a", "start b", "end b", "start c", "end c"]);
	});
});

describe("the listing and the reads never touch a process command line", () => {
	it("macOS: ps is asked for pid and lstart, lsof for the executable file (txt), and nothing else", async () => {
		const lsof = "/usr/sbin/lsof";
		const ps = "/bin/ps";
		const run = scriptedRun([
			{ match: (c) => c.file === lsof && c.args.includes("-p"), answer: { stdout: "p100\nn/r/tools/node/bin/node\n" } },
			{ match: (c) => c.file === lsof, answer: { stdout: "p100\nn/r/tools/node/bin/node\nn/usr/lib/dyld\np200\nn/usr/bin/sleep\n" } },
			{ match: (c) => c.file === ps, answer: { stdout: "  100 Mon Nov  2 10:00:00 2026\n" } },
		]);
		const processes = createMacProcesses(run, createMacLocate());
		await processes.inspect([100]);
		await processes.listUnder("/r/tools");
		assert.ok(run.calls.length >= 4);
		for (const call of run.calls) {
			assert.ok(call.file === ps || call.file === lsof, call.file);
			const text = call.args.join(" ");
			if (call.file === ps) {
				assert.equal(text, "-o pid=,lstart= -p 100");
				assert.equal(call.options?.env?.LC_ALL, "C", "the date format does not depend on the PM's language");
				assert.equal(call.options?.env?.TZ, "UTC0", "lstart is local time, so a time zone change must not change a recorded start time (T8A-F010)");
			} else {
				assert.match(text, /^(-a -p 100 )?-d txt -Fpn$/);
				assert.equal(call.options?.env?.LC_ALL, "en_US.UTF-8", "lsof prints a non-ASCII path raw, whatever the app's locale");
			}
			assert.ok(!/\bargs\b|\bcommand\b|\bcomm\b|-ww|-E\b/.test(text), `no command line asked for in: ${text}`);
		}
		assert.deepEqual([...parseLsofExecutables("p100\nn/r/tools/node/bin/node\nn/usr/lib/dyld\n")], [[100, "/r/tools/node/bin/node"]], "the first n line is the program, the rest are libraries");
	});

	it("Windows: the one call reads ProcessId, ExecutablePath and CreationDate and never the command line", () => {
		assert.match(PROCESS_SCRIPT, /SELECT ProcessId,ExecutablePath,CreationDate FROM Win32_Process/);
		assert.ok(!/CommandLine/i.test(PROCESS_SCRIPT));
	});

	it("no source file of the platform layer or the runtime asks for a command line", () => {
		const roots = [join(import.meta.dirname, "..", "src", "main", "platform"), join(import.meta.dirname, "..", "src", "main", "runtime")];
		const files = roots.flatMap((root) => readdirSync(root).filter((n) => n.endsWith(".ts")).map((n) => join(root, n)));
		assert.ok(files.length > 5);
		for (const file of files) {
			assert.ok(statSync(file).isFile());
			// Comments say the rule in words ("command line"); code would name a column or a property.
			const code = readFileSync(file, "utf8").split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
			assert.ok(!/CommandLine|\bargs=|\bcommand=|\bcomm=|"-o",\s*"args|\bps -ww|\/proc\/\d*\/?cmdline/.test(code), `${file} reads a process command line`);
		}
	});
});
