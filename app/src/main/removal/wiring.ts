import type { RemoveState } from "../../shared/computer.ts";
import type { Locate } from "../platform/types.ts";
import type { QuitGate } from "../quit-gate.ts";
import type { StopOutcome } from "../stop-sequence.ts";
import { cleanupCommand, type CleanupCommand } from "./cleanup.ts";
import type { RemovalDeps } from "./service.ts";

// The connections between **Remove all data** and the quit gate that `index.ts` makes, kept here so that unit tests can break each one (T14R2-F002): the removal's stop goes through the gate, a quit asked
// meanwhile is held and answered at the end, a closed last window ends the app only when that is the rule, and the cleanup armed by the removal starts once, with the marker flag it was armed with.

export interface RemovalStopWiring {
	gate: Pick<QuitGate, "stopForRemoval" | "resumeAfterRefusedRemoval">;
	/** Keep awake: let go when the stop starts (the result screen can wait for hours), applied again by a refused removal. */
	keepAwake: { release(): void; apply(): void };
	/** The stop sequence of the removal (`stopForRemoval(stopParts())`, which waits out a pane's pi helper). */
	stopSequence(): Promise<StopOutcome>;
}

/**
 * The `stop` and `resume` the removal service is given. The stop runs inside the gate, so a stop already under way (an update's, a quit's) is neither joined nor undone, the gate holds a quit asked
 * meanwhile, and `resume` ends that hold. A removal whose stop does not go through the gate is the T14R-F001 regression: nothing holds the quit.
 */
export function removalStop(d: RemovalStopWiring): Pick<RemovalDeps, "stop" | "resume"> {
	return {
		stop: () =>
			d.gate.stopForRemoval(() => {
				d.keepAwake.release();
				return d.stopSequence();
			}),
		resume: async () => {
			await d.gate.resumeAfterRefusedRemoval();
			d.keepAwake.apply();
		},
	};
}

export interface RemovalChangeWiring {
	phase: RemoveState["phase"];
	gate: Pick<QuitGate, "removalDone">;
	/** Opens the window if none is open (a quit that closed the last one was held). */
	openWindow(): void;
	showComputer(): void;
	focus(): void;
}

/** The removal's state changed: when it is done and a quit was asked meanwhile, the result is shown now, in a window opened for it if the PM had closed theirs (T14R-F001). */
export function afterRemovalChange(d: RemovalChangeWiring): void {
	if (d.phase !== "done" || !d.gate.removalDone()) return;
	d.openWindow();
	d.showComputer();
	d.focus();
}

/** `before-quit`: a quit the gate holds is cancelled. */
export function holdQuit(gate: Pick<QuitGate, "beforeQuit">, event: { preventDefault(): void }): void {
	if (!gate.beforeQuit()) event.preventDefault();
}

/** `window-all-closed`: Windows quits and stops with its window (design: Window close); macOS keeps the app and the stack, except after **Remove all data**, which leaves nothing to run. */
export function quitsWhenWindowsClose(platform: NodeJS.Platform, removalPhase: RemoveState["phase"]): boolean {
	return platform !== "darwin" || removalPhase === "done";
}

export interface ExitCleanupDeps {
	platform: NodeJS.Platform;
	/** This app's pid, which the cleanup waits for. */
	pid: number;
	locate: Pick<Locate, "system">;
	spawn(command: CleanupCommand): void;
}

/** The cleanup that deletes `<root>` after the app has gone (`cleanup.ts`): armed by **Remove all data**, started once, at the app's exit. */
export class ExitCleanup {
	readonly #d: ExitCleanupDeps;
	#armed: { root: string; fallbackDir: string | null; marked: boolean } | null = null;

	constructor(deps: ExitCleanupDeps) {
		this.#d = deps;
	}

	/** `marked` is whether `remove-pending` was written: the cleanup then goes on only while the marker is there (T14R-F002). */
	arm(spec: { root: string; fallbackDir: string | null; marked: boolean }): void {
		this.#armed = spec;
	}

	run(): void {
		if (this.#armed === null) return;
		const spec = this.#armed;
		this.#armed = null;
		try {
			this.#d.spawn(cleanupCommand({ platform: this.#d.platform, pid: this.#d.pid, root: spec.root, fallbackDir: spec.fallbackDir, marked: spec.marked }, this.#d.locate));
		} catch {
			// The marker `remove-pending` is in the root: the next launch deletes it.
		}
	}
}
