import type { EngineConfig, EngineEvent, EngineRequest } from "../bootstrap/engine.ts";
import type { StageOutcome } from "../bootstrap/stage.ts";

// Main's side of the bootstrap engine (spec: Decisions, Where the engine runs): one Electron `utilityProcess` per run, talking to main by messages, so a long install never blocks the window
// and an engine crash is a resumable event, not an app crash. The process is started for a run and ends with it. This file holds no Electron import: `index.ts` passes the real `fork`, and
// a test passes a fake, so the host's rules (one run at a time, a crash is reported, `cancel` and `dispose` end the child) run under plain Node.

/** What the host needs of an Electron `UtilityProcess`. */
export interface UtilityChild {
	readonly pid: number | undefined;
	postMessage(message: EngineRequest): void;
	on(event: "message", listener: (message: EngineEvent) => void): void;
	on(event: "exit", listener: (code: number) => void): void;
	kill(): boolean;
}

export type EngineEnd =
	| { kind: "done"; ok: boolean; outcomes: StageOutcome[] }
	/** The engine refused or failed outside a stage (a held lock, a bad config). `name` is the error's class name. */
	| { kind: "error"; name: string; message: string; details: string[] }
	/** The process ended before it said it was done. */
	| { kind: "crashed"; code: number | null }
	/** The host was disposed (the app is quitting) before the run said it was done: nobody resumes it, the next launch does (T9-F002). */
	| { kind: "disposed" };

export interface EngineHost {
	/** The pid of the engine process while a run is active, else null: Repair's lock check treats it as ours (T8A-F009). */
	readonly pid: number | null;
	/** Runs the graph once. Resolves when the engine says it is done, fails, or ends; `onEvent` hears every stage start and outcome meanwhile. Rejects when a run is already active. */
	run(config: EngineConfig, onEvent: (event: EngineEvent) => void): Promise<EngineEnd>;
	/** Asks the active run to stop; the run then ends with the outcomes it has. */
	cancel(): void;
	/** The app is quitting: asks the active run to cancel, gives it a moment to end by itself, then ends the process. Later runs are refused and the run in progress ends `disposed`, not `crashed`. */
	dispose(): Promise<void>;
}

export interface UtilityEngineHostOptions {
	fork(): UtilityChild;
	/** How long `dispose` waits for the process to leave after it was killed. */
	exitWaitMs?: number;
	/** How long `dispose` waits for a cancelled run to end by itself (its children are killed on abort) before it kills the process. */
	cancelWaitMs?: number;
}

export class UtilityEngineHost implements EngineHost {
	readonly #fork: () => UtilityChild;
	readonly #exitWaitMs: number;
	readonly #cancelWaitMs: number;
	#disposed = false;
	#child: UtilityChild | null = null;
	#exited: Promise<void> = Promise.resolve();

	constructor(options: UtilityEngineHostOptions) {
		this.#fork = options.fork;
		this.#exitWaitMs = options.exitWaitMs ?? 5000;
		this.#cancelWaitMs = options.cancelWaitMs ?? 4000;
	}

	get pid(): number | null {
		return this.#child?.pid ?? null;
	}

	/** True from `dispose()` until `resume()`: a run that ends meanwhile was cut short by the quit, whatever its end says. */
	get disposed(): boolean {
		return this.#disposed;
	}

	run(config: EngineConfig, onEvent: (event: EngineEvent) => void): Promise<EngineEnd> {
		if (this.#disposed) return Promise.reject(new Error("the engine host is disposed"));
		if (this.#child !== null) return Promise.reject(new Error("an engine run is already active"));
		const child = this.#fork();
		this.#child = child;
		let ended = false;
		let exitResolve: () => void = () => undefined;
		this.#exited = new Promise((resolve) => (exitResolve = resolve));
		return new Promise<EngineEnd>((resolve) => {
			const finish = (end: EngineEnd): void => {
				if (ended) return;
				ended = true;
				// The run is over when it ends, not when its process has exited: a rollback run started at once (the update's) must not meet "already active" while a slow
				// platform (Windows) still tears the process down.
				if (this.#child === child) this.#child = null;
				resolve(end);
				// The engine process has done its work: it ends with its run.
				child.kill();
			};
			child.on("message", (message) => {
				if (ended) return;
				switch (message.type) {
					case "ready":
						// A dispose that came before the engine was ready must not start the run it cancelled.
						if (this.#disposed) finish({ kind: "disposed" });
						else child.postMessage({ type: "run", config });
						return;
					case "done":
						onEvent(message);
						finish({ kind: "done", ok: message.ok, outcomes: message.outcomes });
						return;
					case "error":
						onEvent(message);
						finish({ kind: "error", name: message.name, message: message.message, details: message.details });
						return;
					default:
						onEvent(message);
				}
			});
			child.on("exit", (code) => {
				if (this.#child === child) this.#child = null;
				finish(this.#disposed ? { kind: "disposed" } : { kind: "crashed", code });
				exitResolve();
			});
		});
	}

	cancel(): void {
		this.#child?.postMessage({ type: "cancel" });
	}

	/** The app is not quitting after all (an update's installer could not start): runs are accepted again. */
	resume(): void {
		this.#disposed = false;
	}

	async dispose(): Promise<void> {
		this.#disposed = true;
		const child = this.#child;
		if (child === null) return;
		// Cancel first: the engine aborts its run, and the runner kills the child it started (npm, an extractor), so none outlives the quit. Only a run that does not end in time is killed.
		child.postMessage({ type: "cancel" });
		let timer: ReturnType<typeof setTimeout> | undefined;
		const left = await Promise.race([this.#exited.then(() => false), new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(true), this.#cancelWaitMs)))]);
		clearTimeout(timer);
		if (!left) return;
		child.kill();
		await Promise.race([this.#exited, new Promise<void>((resolve) => setTimeout(resolve, this.#exitWaitMs))]);
	}
}
