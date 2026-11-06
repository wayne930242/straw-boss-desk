// The state behind "the quit holds until the stop sequence is done, then leaves with `app.exit`" and behind the stop that an update's installer needs (spec: Updater). Kept apart from `index.ts`
// so the cases that decide what happens to a quit asked in the middle of an update's stop can be tested without Electron.

export interface QuitGateDeps {
	/** The stop sequence (`stop-sequence.ts`). Resolves with whether it stopped everything. */
	stopAll(): Promise<boolean>;
	/** Leaves for good (`app.exit`). */
	exit(code: number): void;
	/** Undoes a stop that did not end the app: the app goes on as it was. `event` names the log line (`update-resume`, `remove-resume`). Resolves with whether the agents are running again. */
	resume(event: string): Promise<boolean>;
	log(fields: { event: string; ok?: boolean }): void;
}

/** What **Remove all data** gets from the gate: the stop's own outcome, or `busy` when another stop (a quit's, an update's) was under way and nothing was started. */
export type RemovalStopResult<T extends { ok: boolean }> = T | { ok: false; busy: true; leftovers: [] };

export class QuitGate {
	readonly #d: QuitGateDeps;
	#stopping = false;
	#stopped = false;
	/** A quit was asked while a stop was already under way (an update's, or the removal's), so the app must leave when that stop's own plan fails, or show the removal's result when it ends. */
	#quitAsked = false;
	/** **Remove all data** holds the gate: from the start of its stop until it is refused, fails, or is done. A quit asked meanwhile is held even after the stop itself has ended (T14R-F001). */
	#removing = false;

	constructor(deps: QuitGateDeps) {
		this.#d = deps;
	}

	/** The stop sequence has run to its end and nothing more holds a quit. */
	get stopped(): boolean {
		return this.#stopped;
	}

	/** `before-quit`: true when the quit is let through, false when it is held (the caller calls `preventDefault`). */
	beforeQuit(): boolean {
		if (this.#removing) {
			this.#quitAsked = true;
			return false;
		}
		if (this.#stopped) return true;
		this.quit(() => 0);
		return false;
	}

	/** Stops everything, then leaves with `code(ok)`. A quit asked while a stop is under way is remembered, not lost. */
	quit(code: (ok: boolean) => number): void {
		if (this.#stopping) {
			this.#quitAsked = true;
			return;
		}
		this.#stopping = true;
		void this.#d.stopAll().then((ok) => {
			this.#stopped = true;
			this.#d.exit(code(ok));
		});
	}

	/** Restart to update: the stop sequence runs, and the quit that electron-updater makes next finds nothing left to hold it. */
	async stopForUpdate(): Promise<void> {
		if (this.#stopping) return;
		this.#stopping = true;
		const ok = await this.#d.stopAll();
		this.#stopped = true;
		this.#d.log({ event: "update-stop", ok });
	}

	/**
	 * The installer could not start. The app goes on as it was, unless the PM asked to quit during the stop: then it leaves, through the whole stop sequence again (R13B-F004). The second stop is
	 * harmless: the update's stop disposed the sign-ins too, so what it finds is already stopped. Resolves with whether the agents are running again (false when the app is leaving).
	 */
	resumeAfterFailedUpdate(): Promise<boolean> {
		return this.#undoStop("update-resume-quit", "update-resume");
	}

	/**
	 * **Remove all data** stops the stack through the gate. A stop already under way (an update's, a quit's) is neither joined nor undone, so the removal gets `busy` and the other stop goes on: the
	 * stack is never started again in the middle of an update (T14-F004). The stop is held like a quit's until the removal is refused or done (`removalDone`).
	 */
	async stopForRemoval<T extends { ok: boolean }>(run: () => Promise<T>): Promise<RemovalStopResult<T>> {
		if (this.#stopping) return { ok: false, busy: true, leftovers: [] };
		this.#stopping = true;
		this.#removing = true;
		const outcome = await run();
		this.#stopped = outcome.ok;
		return outcome;
	}

	/**
	 * The removal is done and shows its result. A quit asked while it worked (the window closed on Windows, Cmd-Q) was held, and is answered here, not dropped: the result is shown, and closing it quits
	 * through the usual rule. Returns whether such a quit was asked, which tells the caller to open the window if none is open (T14R-F001).
	 */
	removalDone(): boolean {
		if (!this.#removing) return false;
		const asked = this.#quitAsked;
		this.#removing = false;
		this.#quitAsked = false;
		return asked;
	}

	/** The removal's stop did not finish (programs still run) or the removal failed before deleting anything: the app goes on as it was, or leaves if the PM asked to quit meanwhile. */
	resumeAfterRefusedRemoval(): Promise<boolean> {
		return this.#undoStop("remove-resume-quit", "remove-resume");
	}

	async #undoStop(leavingEvent: string, resumeEvent: string): Promise<boolean> {
		const leaving = this.#quitAsked;
		this.#removing = false;
		this.#stopping = false;
		this.#stopped = false;
		this.#quitAsked = false;
		if (leaving) {
			this.#d.log({ event: leavingEvent });
			this.quit(() => 0);
			return false;
		}
		return this.#d.resume(resumeEvent);
	}
}
