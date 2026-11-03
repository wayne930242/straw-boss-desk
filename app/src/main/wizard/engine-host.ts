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
	| { kind: "crashed"; code: number | null };

export interface EngineHost {
	/** The pid of the engine process while a run is active, else null: Repair's lock check treats it as ours (T8A-F009). */
	readonly pid: number | null;
	/** Runs the graph once. Resolves when the engine says it is done, fails, or ends; `onEvent` hears every stage start and outcome meanwhile. Rejects when a run is already active. */
	run(config: EngineConfig, onEvent: (event: EngineEvent) => void): Promise<EngineEnd>;
	/** Asks the active run to stop; the run then ends with the outcomes it has. */
	cancel(): void;
	/** Ends the engine process at once (the app is quitting). */
	dispose(): Promise<void>;
}

export interface UtilityEngineHostOptions {
	fork(): UtilityChild;
	/** How long `dispose` waits for the process to leave. */
	exitWaitMs?: number;
}

export class UtilityEngineHost implements EngineHost {
	readonly #fork: () => UtilityChild;
	readonly #exitWaitMs: number;
	#child: UtilityChild | null = null;
	#exited: Promise<void> = Promise.resolve();

	constructor(options: UtilityEngineHostOptions) {
		this.#fork = options.fork;
		this.#exitWaitMs = options.exitWaitMs ?? 5000;
	}

	get pid(): number | null {
		return this.#child?.pid ?? null;
	}

	run(config: EngineConfig, onEvent: (event: EngineEvent) => void): Promise<EngineEnd> {
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
				resolve(end);
				// The engine process has done its work: it ends with its run.
				child.kill();
			};
			child.on("message", (message) => {
				if (ended) return;
				switch (message.type) {
					case "ready":
						child.postMessage({ type: "run", config });
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
				finish({ kind: "crashed", code });
				exitResolve();
			});
		});
	}

	cancel(): void {
		this.#child?.postMessage({ type: "cancel" });
	}

	async dispose(): Promise<void> {
		const child = this.#child;
		if (child === null) return;
		child.kill();
		await Promise.race([this.#exited, new Promise<void>((resolve) => setTimeout(resolve, this.#exitWaitMs))]);
	}
}
