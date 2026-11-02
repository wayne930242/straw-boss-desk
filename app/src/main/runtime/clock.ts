/** Time as the supervisor's loops see it, so a test advances it by sleeping instead of waiting. */
export interface Clock {
	now(): number;
	sleep(ms: number): Promise<void>;
}

export const realClock: Clock = {
	now: () => Date.now(),
	sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};
