import type { EngineConfig, EngineEvent } from "../bootstrap/engine.ts";
import type { RuntimeEvent } from "../runtime/log.ts";
import type { EngineEnd } from "../wizard/engine-host.ts";
import type { EngineRunResult } from "./stack.ts";

// One engine run for an update (the candidate's, or the old stack's after a failure, or the heal's), as the stack updater needs its end: done, failed at a stage, or interrupted by a quit.
// This file holds no Electron import, so a test drives it with the real host and a fake child (CIN-F001).

/** What the update's run needs of `UtilityEngineHost`. */
export interface UpdateEngineHost {
	/** True from `dispose()` until `resume()`: the app is quitting, or an update's stop has not been undone yet. */
	readonly disposed: boolean;
	run(config: EngineConfig, onEvent: (event: EngineEvent) => void): Promise<EngineEnd>;
}

export interface UpdateEngineRun {
	host: UpdateEngineHost;
	/** The engine's config; read inside the run, since the proxy lookup it waits for can span a quit. */
	config(): Promise<EngineConfig>;
	log: RuntimeEvent;
}

/**
 * Runs the engine once. A run that ends after the host was disposed did not fail: the quit cancelled it, and the engine answers a cancel with `done` and `ok: false` before it leaves (only a
 * run that ignores the cancel for the host's wait ends `disposed`). Taken as a stage failure it would start a rollback run that the disposed host refuses, and the apply would delete its own
 * marker, so the heal that the next launch or the resume after a failed installer makes would find nothing. It is `interrupted` instead, and the marker stays.
 */
export async function runUpdateEngine(run: UpdateEngineRun, onStage: (event: { type: "start" | "end"; stage: string }) => void): Promise<EngineRunResult> {
	let current: string | null = null;
	const failures: Array<{ stage: string; category: string }> = [];
	let end: EngineEnd;
	try {
		end = await run.host.run(await run.config(), (event) => {
			if (event.type === "stage-start") {
				current = event.stage;
				onStage({ type: "start", stage: event.stage });
			} else if (event.type === "stage") {
				onStage({ type: "end", stage: event.outcome.stage });
				if (event.outcome.status === "failed") failures.push({ stage: event.outcome.stage, category: event.outcome.failure?.category ?? "other" });
			}
		});
	} catch (error) {
		// The host refuses a run once it is disposed: the quit landed before this run could start, and the engine never ran.
		if (run.host.disposed) return { ok: false, interrupted: true };
		throw error;
	}
	if (end.kind === "disposed") return { ok: false, interrupted: true };
	// A run that was already complete when the quit came stays complete.
	if (run.host.disposed && !(end.kind === "done" && end.ok)) return { ok: false, interrupted: true };
	switch (end.kind) {
		case "done":
			return end.ok ? { ok: true } : { ok: false, failed: failures[0] ?? { stage: "engine", category: "other" } };
		case "error":
			run.log({ event: "update-engine-error", name: end.name, detail: end.message.slice(0, 300) });
			return { ok: false, failed: { stage: "engine", category: "other" } };
		case "crashed":
			return { ok: false, failed: { stage: current ?? "engine", category: "other" } };
	}
}
