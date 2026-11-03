import type { EngineEvent } from "../bootstrap/engine.ts";
import type { StageOutcome } from "../bootstrap/stage.ts";
import type { InstallFailure, InstallStage, InstallView, StageBadge } from "../../shared/wizard.ts";

// The install step's list (spec: First run, step 5): every stage the engine will run, each with a badge, built from the engine's `stage-start` and `stage` events. The names are the engine's;
// the page words them from the catalog and shows the raw name only under **Details**.

const badgeOf = (outcome: StageOutcome): StageBadge =>
	outcome.status === "installed" ? "done" : outcome.status === "skipped-verified" ? "skipped" : outcome.status === "blocked" ? "blocked" : "failed";

export function failureOf(outcome: StageOutcome): InstallFailure | null {
	const f = outcome.failure;
	if (f === undefined) return null;
	return { stage: outcome.stage, category: f.category, params: { ...f.params }, detail: f.detail };
}

export class InstallProgress {
	#stages: InstallStage[] = [];
	#status: InstallView["status"] = "idle";
	#current: string | null = null;
	#failures: InstallFailure[] = [];
	#tail: string[] = [];
	#crashed: string | null = null;

	/** A run begins: every planned stage waits. Failures of an earlier run are dropped; the stages already done in an earlier run show as waiting until the engine skips them. */
	begin(planned: readonly string[]): void {
		this.#stages = planned.map((name) => ({ name, badge: "waiting" }));
		this.#status = "running";
		this.#current = null;
		this.#failures = [];
		this.#crashed = null;
	}

	apply(event: EngineEvent): void {
		if (event.type === "stage-start") {
			this.#set(event.stage, "working");
			this.#current = event.stage;
		} else if (event.type === "stage") {
			this.#set(event.outcome.stage, badgeOf(event.outcome));
			const failure = failureOf(event.outcome);
			if (failure !== null) this.#failures.push(failure);
			if (this.#current === event.outcome.stage) this.#current = null;
		}
	}

	#set(name: string, badge: StageBadge): void {
		const known = this.#stages.find((s) => s.name === name);
		if (known !== undefined) known.badge = badge;
		else this.#stages.push({ name, badge });
	}

	/** The stage that was working when the engine process ended. */
	get working(): string | null {
		return this.#stages.find((s) => s.badge === "working")?.name ?? null;
	}

	/** The engine crashed twice in the same stage: that stage fails (spec: Crash and sleep). */
	crashFailed(stage: string): void {
		this.#set(stage, "failed");
		this.#crashed = stage;
		this.#failures.push({ stage, category: "other", params: { stage }, detail: "the install process ended unexpectedly twice in this stage" });
	}

	/** The engine ended without a stage's outcome (a refused or failed run): one failure with the engine's message. */
	errored(message: string): void {
		this.#failures.push({ stage: "", category: "other", params: {}, detail: message });
	}

	finish(ok: boolean, tail: string[]): void {
		this.#status = ok ? "done" : "failed";
		this.#current = null;
		this.#tail = tail;
		// A stage the run never reached because the engine ended stays waiting; the badge list shows what happened.
	}

	view(): InstallView {
		return { status: this.#status, stages: this.#stages.map((s) => ({ ...s })), current: this.#current, failures: this.#failures.map((f) => ({ ...f, params: { ...f.params } })), tail: [...this.#tail], crashed: this.#crashed };
	}
}
