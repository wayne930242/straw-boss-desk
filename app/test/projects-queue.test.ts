import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { removeTree } from "../src/main/bootstrap/fsutil.ts";
import { ProjectGit } from "../src/main/projects/git.ts";
import { ProjectRecordStore } from "../src/main/projects/record.ts";
import { ProjectsRunner, type ProjectsDeps, type RepoSpec } from "../src/main/projects/runner.ts";
import { SerialQueue } from "../src/main/runtime/identity.ts";

// R12-F002: a row's Git runs as a job of the supervisor's queue (`gitJob`), beside Repair, a stack update, Apply and the Linear restart. A `SerialQueue` stands in for the supervisor's queue, whose
// `withEngineJob` and `withStackStopped` are both `#queue.run(...)`; Git is a fake that clones into the staging folder the runner names.

const scratch: string[] = [];
after(() => {
	for (const d of scratch) removeTree(d);
});

const spec = (name: string): RepoSpec => ({ url: `https://git.fixture.test/${name}.git`, folder: name, label: name });
const tick = (ms = 20): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (done: () => boolean): Promise<void> => {
	for (let i = 0; i < 200 && !done(); i++) await tick(10);
	assert.ok(done(), "the condition was not reached");
};

function rig() {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "sbd-queue-")));
	scratch.push(root);
	const work = join(root, "work");
	mkdirSync(join(root, "state"), { recursive: true });
	const queue = new SerialQueue();
	const hold: { open?: () => Promise<void> } = {};
	const events: string[] = [];
	const gates = new Map<string, () => void>();
	/** A clone that ends when its gate is opened. */
	const clones: string[] = [];
	const git = new ProjectGit(
		async (args) => {
			events.push(`git ${args[0]}`);
			if (args[0] === "clone") {
				const staging = String(args[args.length - 1]);
				clones.push(staging);
				await new Promise<void>((resolve) => gates.set(`clone:${clones.length}`, resolve));
				mkdirSync(staging, { recursive: true });
			}
			return { code: 0, stdout: "", stderr: "" };
		},
		() => undefined,
	);
	const deps: ProjectsDeps = {
		platform: "darwin",
		workFolder: () => work,
		git,
		gitJob: (job) => queue.run(job),
		openBase: async () => {
			events.push("open");
			await hold.open?.();
			return { ok: true };
		},
		record: new ProjectRecordStore({ state: join(root, "state") }),
		redact: (t) => t,
		log: () => undefined,
	};
	const runner = new ProjectsRunner(deps);
	return { runner, deps, queue, hold, events, gates, clones, rows: () => Object.fromEntries(runner.view().rows.map((r) => [r.folder, r])) };
}

describe("the projects runner and the supervisor's queue (R12-F002)", () => {
	it("a row waits for an install that holds the queue: no Git runs, the row says it is queued, and it goes on when the install ends", async () => {
		const r = rig();
		let endInstall: () => void = () => undefined;
		const install = r.queue.run(() => new Promise<void>((resolve) => (endInstall = resolve)));
		const done = r.runner.begin([spec("web")]);
		await tick(100);
		assert.deepEqual(r.events, [], "no Git while the install runs");
		assert.equal(r.rows().web?.phase, "working");
		assert.equal(r.rows().web?.step, "queued");
		endInstall();
		await install;
		await until(() => r.gates.has("clone:1"));
		assert.equal(r.rows().web?.step, "cloning");
		r.gates.get("clone:1")?.();
		await done;
		assert.equal(r.rows().web?.phase, "done");
		assert.deepEqual(r.events, ["git clone", "open"]);
	});

	it("an engine job asked while a clone runs waits for the clone and then runs; it is not refused", async () => {
		const r = rig();
		const done = r.runner.begin([spec("web")]);
		await until(() => r.gates.has("clone:1"));
		let ran = false;
		const update = r.queue.run(async () => {
			ran = true;
			return "updated";
		});
		await tick(100);
		assert.equal(ran, false, "the update waits while the clone holds the tools folder");
		r.gates.get("clone:1")?.();
		assert.equal(await update, "updated");
		await done;
		assert.equal(r.rows().web?.phase, "done");
	});

	it("the open is outside the job: a held open (a trust question) does not keep an engine job waiting", async () => {
		const r = rig();
		let release: () => void = () => undefined;
		r.hold.open = () => new Promise<void>((resolve) => (release = resolve));
		const done = r.runner.begin([spec("web")]);
		await until(() => r.gates.has("clone:1"));
		r.gates.get("clone:1")?.();
		await until(() => r.events.includes("open"));
		let ran = false;
		await r.queue.run(async () => void (ran = true));
		assert.equal(ran, true, "an engine job runs while the open waits for the PM");
		release();
		await done;
		assert.equal(r.rows().web?.phase, "done");
	});

	it("a stack job asked during a copy stops the stack as the open starts: the open waits for the queue, then opens once more under the same id (R12B-F002)", async () => {
		const r = rig();
		let stackUp = true;
		const ids: string[] = [];
		const opened: string[] = [];
		r.deps.openBase = async (input) => {
			r.events.push("open");
			ids.push(input.deploy);
			await tick(30);
			if (!stackUp) return { ok: false, cause: "gui-unavailable", reason: "connection refused" };
			opened.push(input.dir);
			return { ok: true };
		};
		const done = r.runner.begin([spec("web")]);
		await until(() => r.gates.has("clone:1"));
		// Apply asks for the stack to stop; it waits behind the clone, and its job stops the stack, works for a while and starts it again.
		const apply = r.queue.run(async () => {
			stackUp = false;
			await tick(80);
			stackUp = true;
		});
		r.gates.get("clone:1")?.();
		await apply;
		await done;
		assert.equal(r.rows().web?.phase, "done", JSON.stringify(r.rows().web));
		assert.equal(r.rows().web?.opened, true);
		assert.deepEqual(r.events, ["git clone", "open", "open"]);
		assert.equal(ids.length, 2);
		assert.equal(ids[0], ids[1], "the same id both times");
		assert.equal(opened.length, 1);
	});

	describe("a pi that did not start or join in time (CIN-F002)", () => {
		const lateJoin = { ok: false, cause: "refused", reason: "The pi in pane 3 did not join the net within 60 s", step: "join" } as const;

		it("is opened once more after the queue has drained, under the same id, and the row ends done", async () => {
			const r = rig();
			const logs: Array<Record<string, unknown>> = [];
			r.deps.log = (fields) => void logs.push(fields as Record<string, unknown>);
			const ids: string[] = [];
			let endJob: () => void = () => undefined;
			let job: Promise<void> | undefined;
			r.deps.openBase = async (input) => {
				r.events.push("open");
				ids.push(input.deploy);
				if (ids.length > 1) return { ok: true };
				// A job asked meanwhile (Apply, Repair) holds the queue when the first open fails.
				job = r.queue.run(() => new Promise<void>((resolve) => (endJob = resolve)));
				return lateJoin;
			};
			const done = r.runner.begin([spec("web")]);
			await until(() => r.gates.has("clone:1"));
			r.gates.get("clone:1")?.();
			await until(() => r.events.includes("open"));
			await tick(100);
			assert.deepEqual(r.events, ["git clone", "open"], "the repeat waits for the queue");
			endJob();
			await job;
			await done;
			assert.equal(r.rows().web?.phase, "done", JSON.stringify(r.rows().web));
			assert.equal(r.rows().web?.opened, true);
			assert.deepEqual(r.events, ["git clone", "open", "open"]);
			assert.equal(ids[0], ids[1], "the same id both times");
			assert.deepEqual(logs.filter((l) => l.event === "project-open-repeat"), [{ event: "project-open-repeat", folder: "web", cause: "refused", step: "join", detail: lateJoin.reason }]);
		});

		it("is repeated for the start step too, and at most once: a second failure is the row's, with the server's reason in Details and in the log", async () => {
			const r = rig();
			const logs: Array<Record<string, unknown>> = [];
			r.deps.log = (fields) => void logs.push(fields as Record<string, unknown>);
			r.deps.redact = (t) => t.replace("pane 3", "pane N");
			let calls = 0;
			r.deps.openBase = async () => (calls++, r.events.push("open"), { ok: false, cause: "refused", reason: "The pi in pane 3 did not start", step: calls === 1 ? "start" : "join" });
			const done = r.runner.begin([spec("web")]);
			await until(() => r.gates.has("clone:1"));
			r.gates.get("clone:1")?.();
			await done;
			assert.deepEqual(r.events, ["git clone", "open", "open"]);
			const row = r.rows().web;
			assert.equal(row?.phase, "failed");
			assert.deepEqual(row?.failure, { kind: "open", cause: "refused" });
			assert.equal(row?.detail, "The pi in pane N did not start");
			assert.deepEqual(logs.filter((l) => l.event === "project-failed"), [{ event: "project-failed", folder: "web", failure: "open", cause: "refused", step: "join", detail: "The pi in pane N did not start" }]);
		});

		it("is not repeated for any other step, none named, or a quit", async () => {
			for (const outcome of [{ ...lateJoin, step: "create" }, { ...lateJoin, step: "deliver" }, { ...lateJoin, step: "trust" }, { ok: false, cause: "refused", reason: "the GUI answered 502" }] as const) {
				const r = rig();
				r.deps.openBase = async () => (r.events.push("open"), outcome);
				const done = r.runner.begin([spec("web")]);
				await until(() => r.gates.has("clone:1"));
				r.gates.get("clone:1")?.();
				await done;
				assert.deepEqual(r.events, ["git clone", "open"], JSON.stringify(outcome));
			}
			const r = rig();
			r.deps.openBase = async () => (r.events.push("open"), r.runner.dispose(), lateJoin);
			const done = r.runner.begin([spec("web")]);
			await until(() => r.gates.has("clone:1"));
			r.gates.get("clone:1")?.();
			await done;
			assert.deepEqual(r.events, ["git clone", "open"], "a quit ends the row, it does not open again");
			assert.deepEqual(r.rows().web?.failure, { kind: "interrupted" });
		});
	});

	it("an open that fails for any other reason is not made a second time", async () => {
		const r = rig();
		r.deps.openBase = async () => (r.events.push("open"), { ok: false, cause: "settings-unsafe", reason: "no" });
		const done = r.runner.begin([spec("web")]);
		await until(() => r.gates.has("clone:1"));
		r.gates.get("clone:1")?.();
		await done;
		assert.deepEqual(r.events, ["git clone", "open"]);
	});

	it("rows are separate jobs: an engine job asked between two clones runs between them", async () => {
		const r = rig();
		const done = r.runner.begin([spec("web"), spec("plain")]);
		await until(() => r.gates.has("clone:1"));
		const order: string[] = [];
		const between = r.queue.run(async () => void order.push("engine"));
		r.gates.get("clone:1")?.();
		await between;
		order.push("after engine");
		await until(() => r.gates.has("clone:2"));
		r.gates.get("clone:2")?.();
		await done;
		assert.deepEqual(order, ["engine", "after engine"]);
		assert.deepEqual(r.events, ["git clone", "open", "git clone", "open"]);
	});

	it("a row that waited in the queue while the app quit does not start Git", async () => {
		const r = rig();
		let endInstall: () => void = () => undefined;
		const install = r.queue.run(() => new Promise<void>((resolve) => (endInstall = resolve)));
		const done = r.runner.begin([spec("web")]);
		await tick(50);
		r.runner.dispose();
		endInstall();
		await install;
		await done;
		assert.deepEqual(r.events, []);
		assert.deepEqual(r.rows().web?.failure, { kind: "interrupted" });
	});

	it("the app hands the runner the supervisor's engine job queue", () => {
		const text = readFileSync(join(import.meta.dirname, "..", "src", "main", "index.ts"), "utf8");
		assert.match(text, /gitJob: \(work\) => supervisor\.withEngineJob\(work\)/);
		assert.match(text, /probe: hostProbe\(netFetch\(\)\)/, "and the host probe of the projects step (R12-F004)");
	});
});
