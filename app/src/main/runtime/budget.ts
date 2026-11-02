// A sliding-window count for the crash budgets of the spec's **Crash and sleep**: more than 3 restarts of the Herdr server or of the sb server in 10 minutes stop the retrying, and
// a GUI renderer that goes away twice in a minute shows the failure screen. One class, because both are "more than `max` events in `windowMs`".

export class SlidingBudget {
	readonly #max: number;
	readonly #windowMs: number;
	#hits: number[] = [];

	constructor(max: number, windowMs: number) {
		this.#max = max;
		this.#windowMs = windowMs;
	}

	/** Records one event at `now` and says whether the budget is now spent: more than `max` events within the window, this one included. */
	hit(now: number): boolean {
		this.#hits = [...this.#within(now), now];
		return this.#hits.length > this.#max;
	}

	/** How many events lie within the window ending at `now`. */
	count(now: number): number {
		return this.#within(now).length;
	}

	/** A new start by the PM (Retry, Start) begins a fresh budget. */
	reset(): void {
		this.#hits = [];
	}

	#within(now: number): number[] {
		return this.#hits.filter((t) => now - t < this.#windowMs);
	}
}

/** More than 3 restarts of either server in 10 minutes (spec: Crash and sleep). */
export const SERVER_RESTART_MAX = 3;
export const SERVER_RESTART_WINDOW_MS = 10 * 60 * 1000;

/** The GUI view's renderer going away twice within a minute shows the failure screen: the first loss reloads, the second inside the minute fails. */
export const RENDERER_GONE_MAX = 1;
export const RENDERER_GONE_WINDOW_MS = 60 * 1000;
