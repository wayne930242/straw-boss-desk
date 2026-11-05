import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { EngineConfig, EngineEvent } from "../src/main/bootstrap/engine.ts";
import { runUpdateEngine, type UpdateEngineHost } from "../src/main/update/engine-run.ts";
import type { EngineEnd } from "../src/main/wizard/engine-host.ts";

// The end of an update's engine run, as the stack updater reads it (CIN-F001). The real host's sequence into the updater is in `update-stack.test.ts`.

const config: EngineConfig = { root: "/r", stack: {}, secretPatterns: {} };

/** A host whose run says `events`, then ends as `end`; `disposed` is what the host answers once the run is over. */
function host(end: EngineEnd | Error, options: { disposed: boolean; events?: EngineEvent[] }): UpdateEngineHost {
	return {
		disposed: options.disposed,
		async run(_config, onEvent) {
			for (const event of options.events ?? []) onEvent(event);
			if (end instanceof Error) throw end;
			return end;
		},
	};
}
const run = (h: UpdateEngineHost, log: Array<Record<string, unknown>> = [], stages: string[] = []) =>
	runUpdateEngine({ host: h, config: async () => config, log: (fields) => void log.push(fields as Record<string, unknown>) }, (e) => void stages.push(`${e.type} ${e.stage}`));

const failedStage = (stage: string): EngineEvent => ({ type: "stage", outcome: { stage, status: "failed", failure: { category: "network" } } as never });

describe("runUpdateEngine", () => {
	it("is ok when the engine is done and ok, and reports the stages it heard", async () => {
		const stages: string[] = [];
		const events: EngineEvent[] = [{ type: "stage-start", stage: "node" }, { type: "stage", outcome: { stage: "node", status: "done" } as never }];
		assert.deepEqual(await run(host({ kind: "done", ok: true, outcomes: [] }, { disposed: false, events }), [], stages), { ok: true });
		assert.deepEqual(stages, ["start node", "end node"]);
	});

	it("names the first stage that failed when the engine is done and not ok", async () => {
		const events: EngineEvent[] = [{ type: "stage-start", stage: "pi" }, failedStage("pi"), failedStage("loader")];
		assert.deepEqual(await run(host({ kind: "done", ok: false, outcomes: [] }, { disposed: false, events })), { ok: false, failed: { stage: "pi", category: "network" } });
		assert.deepEqual(await run(host({ kind: "done", ok: false, outcomes: [] }, { disposed: false })), { ok: false, failed: { stage: "engine", category: "other" } });
	});

	it("logs an engine error and calls a crash a failure of the stage that was running", async () => {
		const log: Array<Record<string, unknown>> = [];
		assert.deepEqual(await run(host({ kind: "error", name: "EngineLockedError", message: "locked", details: [] }, { disposed: false }), log), { ok: false, failed: { stage: "engine", category: "other" } });
		assert.deepEqual(log, [{ event: "update-engine-error", name: "EngineLockedError", detail: "locked" }]);
		assert.deepEqual(await run(host({ kind: "crashed", code: 9 }, { disposed: false, events: [{ type: "stage-start", stage: "pi" }] })), { ok: false, failed: { stage: "pi", category: "other" } });
	});

	it("takes a run that ends after the host was disposed as interrupted, whatever it says: the quit cancelled it", async () => {
		assert.deepEqual(await run(host({ kind: "disposed" }, { disposed: true })), { ok: false, interrupted: true });
		assert.deepEqual(await run(host({ kind: "done", ok: false, outcomes: [] }, { disposed: true, events: [failedStage("pi")] })), { ok: false, interrupted: true });
		assert.deepEqual(await run(host({ kind: "error", name: "EngineLockedError", message: "locked", details: [] }, { disposed: true })), { ok: false, interrupted: true });
	});

	it("keeps a run that was complete when the quit came", async () => {
		assert.deepEqual(await run(host({ kind: "done", ok: true, outcomes: [] }, { disposed: true })), { ok: true });
	});

	it("takes the host's refusal of a run as interrupted when the host is disposed, and rethrows any other", async () => {
		assert.deepEqual(await run(host(new Error("the engine host is disposed"), { disposed: true })), { ok: false, interrupted: true });
		await assert.rejects(run(host(new Error("an engine run is already active"), { disposed: false })), /already active/);
	});
});
