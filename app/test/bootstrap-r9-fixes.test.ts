import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { StageError, TOOLS_RUNNING_SENTENCE, failureSentence } from "../src/main/bootstrap/errors.ts";
import { Logger, Redactor } from "../src/main/bootstrap/log.ts";
import type { Stage, StageContext } from "../src/main/bootstrap/stage.ts";
import { ToolsQuiet } from "../src/main/bootstrap/tools-quiet.ts";
import { readStartGate } from "../src/main/runtime/readiness.ts";
import { makeStack, scratchRoot, secretPatterns, testEngine, testLayout, testPlatform } from "./harness/engine-fixture.ts";
import { removeTree } from "../src/main/bootstrap/fsutil.ts";
import type { Platform } from "../src/main/platform/index.ts";

// Round 2 of task 9's review (R9-F001, R9-F002, R9-F004 a and b): what a quit or a cancel leaves behind, and what the next start and the next package stage do about it.

const scratch: string[] = [];
after(() => {
	for (const d of scratch) removeTree(d);
});

const waitFor = async (what: string, probe: () => boolean, ms = 10_000): Promise<void> => {
	const deadline = Date.now() + ms;
	while (!probe()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
};

interface Interrupted {
	/** Called by the stage once it is running, so the test can cancel. */
	started: boolean;
}

/** A package stage that, once running, waits for the engine's cancel and then throws what `after` says. */
function cancellable(options: { name?: string; touch: boolean; afterCancel?: () => Error }, seen: Interrupted): Stage {
	return {
		name: options.name ?? "pkg:repro",
		needs: [],
		lane: "npm",
		plannedVersion: () => "1.0.0",
		detect: async () => null,
		async install(ctx: StageContext) {
			if (options.touch) ctx.markInPlace();
			seen.started = true;
			await new Promise<void>((resolve) => ctx.signal.addEventListener("abort", () => resolve(), { once: true }));
			throw options.afterCancel?.() ?? new Error("the child was killed");
		},
		verify: async () => ({ text: "x", version: "1.0.0", files: [] }),
		activate: async () => undefined,
	};
}

async function cancelRun(stage: Stage, seen: Interrupted, force = false): Promise<{ root: string; outcome: string | undefined; record: { status: string; startBlock?: { kind: string; package: string } } | undefined; gate: ReturnType<typeof readStartGate> }> {
	const made = scratchRoot("sbd-r9-");
	scratch.push(made.base);
	const t = testEngine(made.root, () => [stage]);
	const running = t.engine.handle({ type: "run", config: { root: made.root, stack: makeStack({}), secretPatterns, ...(force ? { force: true } : {}) } });
	await waitFor("the stage to start", () => seen.started);
	await t.engine.handle({ type: "cancel" });
	await running;
	const done = t.events.find((e) => e.type === "done");
	assert.ok(done?.type === "done", JSON.stringify(t.events.find((e) => e.type === "error")));
	const layout = testLayout(made.root);
	const record = (JSON.parse(readFileSync(join(layout.state, "bootstrap.json"), "utf8")) as { stages: Record<string, { status: string; startBlock?: { kind: string; package: string } }> }).stages[stage.name];
	return { root: made.root, outcome: done.outcomes.find((o) => o.stage === stage.name)?.failure?.detail, record, gate: readStartGate(layout) };
}

describe("R9-F002: a cancel after a package stage changed its prefix in place keeps the start blocked", () => {
	it("leaves the record `running`, which the start gate reads as an interrupted install", async () => {
		const seen = { started: false };
		const out = await cancelRun(cancellable({ touch: true }, seen), seen);
		assert.equal(out.outcome, "cancelled");
		assert.equal(out.record?.status, "running");
		assert.deepEqual(out.gate.interrupted, ["pkg:repro"]);
	});

	it("does the same for a Repair that is stopped (a forced run) over a stage that was ok", async () => {
		const made = scratchRoot("sbd-r9-repair-");
		scratch.push(made.base);
		const layout = testLayout(made.root);
		// The first run installs the stage; the second, forced like Repair, is cancelled after it touched the prefix.
		let phase: "install" | "repair" = "install";
		const seen = { started: false };
		const stage: Stage = {
			name: "pkg:repro",
			needs: [],
			lane: "npm",
			plannedVersion: () => "1.0.0",
			detect: async () => null,
			async install(ctx) {
				ctx.markInPlace();
				if (phase === "install") return;
				seen.started = true;
				await new Promise<void>((resolve) => ctx.signal.addEventListener("abort", () => resolve(), { once: true }));
				throw new Error("killed");
			},
			verify: async () => ({ text: "x", version: "1.0.0", files: [] }),
			activate: async () => undefined,
		};
		const t = testEngine(made.root, () => [stage]);
		const first = await t.run(makeStack({}));
		assert.equal(first.ok, true);
		assert.deepEqual(readStartGate(layout).interrupted, [], "the installed stage does not block a start");
		phase = "repair";
		const running = t.engine.handle({ type: "run", config: { root: made.root, stack: makeStack({}), secretPatterns, force: true } });
		await waitFor("the repair to start", () => seen.started);
		await t.engine.handle({ type: "cancel" });
		await running;
		assert.deepEqual(readStartGate(layout).interrupted, ["pkg:repro"], "a quit during Repair blocks the next start until a run of the stage finishes");
	});

	it("keeps the start block of a rollback that failed on the way (`package-may-load`), where the cancel replaced the error", async () => {
		const block = { kind: "package-may-load", package: "pkg-one", sentence: "pkg-one may still load" } as const;
		const seen = { started: false };
		const out = await cancelRun(cancellable({ touch: true, afterCancel: () => new StageError("other", { stage: "pkg:repro", reason: "package-may-load", name: "pkg-one" }, "pi remove failed", { startBlock: block }) }, seen), seen);
		assert.equal(out.record?.startBlock?.kind, "package-may-load");
		assert.deepEqual(out.gate.blocks.map((b) => b.package), ["pkg-one"]);
		assert.deepEqual(out.gate.interrupted, ["pkg:repro"]);
	});

	it("is unchanged for a stage that had not touched anything: nothing in place is half done, so the record is a plain failure", async () => {
		const seen = { started: false };
		const out = await cancelRun(cancellable({ touch: false }, seen), seen);
		assert.equal(out.record?.status, "failed");
		assert.deepEqual(out.gate.interrupted, []);
		assert.deepEqual(out.gate.blocks, []);
	});
});

describe("R9-F004 b: a cancel that arrives while the engine lock is being taken is not lost", () => {
	it("ends the run without installing anything", async () => {
		const made = scratchRoot("sbd-r9-lock-");
		scratch.push(made.base);
		let installed = false;
		const stage: Stage = {
			name: "pkg:late",
			needs: [],
			lane: "npm",
			plannedVersion: () => "1.0.0",
			detect: async () => null,
			async install() {
				installed = true;
			},
			verify: async () => ({ text: "x", version: "1.0.0", files: [] }),
			activate: async () => undefined,
		};
		const t = testEngine(made.root, () => [stage]);
		// Both requests in the same tick: `run` is at its first await (the lock) when the cancel arrives.
		const running = t.engine.handle({ type: "run", config: { root: made.root, stack: makeStack({}), secretPatterns } });
		const cancelling = t.engine.handle({ type: "cancel" });
		await Promise.all([running, cancelling]);
		const done = t.events.find((e) => e.type === "done");
		assert.ok(done?.type === "done", JSON.stringify(t.events));
		assert.equal(done.ok, false);
		assert.equal(installed, false, "the stage never ran");
		assert.equal(done.outcomes[0]?.status, "blocked");
	});
});

// ---- R9-F001 ---------------------------------------------------------------------------------------------------------

/** A process table whose listing answers `busy` for the first `times` calls under the tools folder, then nothing. */
function table(toolsRoot: string, times: number): { platform: Platform; calls: () => number } {
	let n = 0;
	const base = testPlatform();
	return {
		calls: () => n,
		platform: {
			...base,
			processes: {
				...base.processes,
				listUnder: async () => (++n <= times ? [{ pid: 4242, startTime: "t", executable: join(toolsRoot, "node", "24.0.0", "node") }] : []),
			},
		},
	};
}

function logOf(): { log: ReturnType<Logger["stage"]>; lines: () => Array<Record<string, unknown>> } {
	const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "sbd-r9-log-")));
	scratch.push(dir);
	const logger = new Logger({ dir, redactor: new Redactor([]) });
	return {
		log: logger.stage("pkg:x"),
		lines: () => readFileSync(join(dir, "bootstrap.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>),
	};
}

describe("R9-F001: a package stage does not start while a program of the data root runs", () => {
	const made = scratchRoot("sbd-r9-quiet-");
	scratch.push(made.base);
	const layout = testLayout(made.root);

	it("waits while the listing names a program under <root>/tools, goes on once it is gone, and lists once more only after a child was ended alone", async () => {
		const t = table(layout.tools.root, 3);
		const { log, lines } = logOf();
		const quiet = new ToolsQuiet({ waitMs: 5_000, pollMs: 5 });
		const request = { layout, processes: t.platform.processes, signal: new AbortController().signal, stage: "pkg:x", log };
		await quiet.ensure(request);
		assert.equal(t.calls(), 4, "three listings named the program, the fourth was empty");
		assert.deepEqual(lines().map((l) => l.event), ["tools-busy", "tools-quiet"]);
		assert.deepEqual((lines()[0]?.programs as string[]) ?? [], ["node (pid 4242)"], "the executable's file name and the pid are all that is said of it");
		await quiet.ensure(request);
		assert.equal(t.calls(), 4, "a clean answer holds for the run");
		quiet.markDirty();
		await quiet.ensure(request);
		assert.equal(t.calls(), 5, "after a child was ended alone, the next stage lists again");
	});

	it("fails as `locked` with its own reason and no automatic retry when the program is still there after the limit", async () => {
		const t = table(layout.tools.root, Number.POSITIVE_INFINITY);
		const { log, lines } = logOf();
		const quiet = new ToolsQuiet({ waitMs: 120, pollMs: 10 });
		const error = await quiet.ensure({ layout, processes: t.platform.processes, signal: new AbortController().signal, stage: "pkg:x", log }).then(
			() => null,
			(e: unknown) => e,
		);
		assert.ok(error instanceof StageError);
		assert.equal(error.category, "locked");
		assert.equal(error.params.reason, "tools-running");
		assert.equal(error.noRetry, true);
		assert.equal(error.sentence, TOOLS_RUNNING_SENTENCE);
		assert.match(error.message, /node \(pid 4242\)/);
		assert.deepEqual(lines().map((l) => l.event), ["tools-busy", "tools-locked"]);
	});

	it("is cancelled at once when the run is aborted while it waits", async () => {
		const t = table(layout.tools.root, Number.POSITIVE_INFINITY);
		const { log } = logOf();
		const abort = new AbortController();
		const quiet = new ToolsQuiet({ waitMs: 60_000, pollMs: 20 });
		setTimeout(() => abort.abort(), 60);
		const began = Date.now();
		const error = await quiet.ensure({ layout, processes: t.platform.processes, signal: abort.signal, stage: "pkg:x", log }).then(
			() => null,
			(e: unknown) => e,
		);
		assert.ok(error instanceof StageError);
		assert.equal(error.message, "cancelled");
		assert.ok(Date.now() - began < 10_000);
	});

	it("words the failure in the engine's English sentence, and leaves a plain lock's sentence as it was", () => {
		assert.equal(failureSentence("locked", { reason: "tools-running" }), TOOLS_RUNNING_SENTENCE);
		assert.equal(failureSentence("locked", {}), "A file was in use (often antivirus scanning it).");
	});

	it("does not wait at all when the listing is empty", async () => {
		const t = table(layout.tools.root, 0);
		const { log } = logOf();
		const quiet = new ToolsQuiet({ waitMs: 50, pollMs: 5 });
		await quiet.ensure({ layout, processes: t.platform.processes, signal: new AbortController().signal, stage: "pkg:x", log });
		assert.equal(t.calls(), 1);
	});
});
