// The state behind "the quit holds until the stop sequence is done, then leaves with `app.exit`" and behind the stop that an update's installer needs (spec: Updater). Kept apart from `index.ts`
// so the cases that decide what happens to a quit asked in the middle of an update's stop can be tested without Electron.

export interface QuitGateDeps {
	/** The stop sequence (`stop-sequence.ts`). Resolves with whether it stopped everything. */
	stopAll(): Promise<boolean>;
	/** Leaves for good (`app.exit`). */
	exit(code: number): void;
	/** Undoes an update's stop: the app goes on as it was. Resolves with whether the agents are running again. */
	resume(): Promise<boolean>;
	log(fields: { event: string; ok?: boolean }): void;
}

export class QuitGate {
	readonly #d: QuitGateDeps;
	#stopping = false;
	#stopped = false;
	/** A quit was asked while a stop was already under way (an update's), so the app must leave when that stop's own plan fails. */
	#quitAsked = false;

	constructor(deps: QuitGateDeps) {
		this.#d = deps;
	}

	/** The stop sequence has run to its end and nothing more holds a quit. */
	get stopped(): boolean {
		return this.#stopped;
	}

	/** `before-quit`: true when the quit is let through, false when it is held (the caller calls `preventDefault`). */
	beforeQuit(): boolean {
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
	async resumeAfterFailedUpdate(): Promise<boolean> {
		const leaving = this.#quitAsked;
		this.#stopping = false;
		this.#stopped = false;
		this.#quitAsked = false;
		if (leaving) {
			this.#d.log({ event: "update-resume-quit" });
			this.quit(() => 0);
			return false;
		}
		return this.#d.resume();
	}
}
