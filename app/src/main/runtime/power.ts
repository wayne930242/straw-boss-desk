import type { RuntimeEvent } from "./log.ts";

// Power (spec: Runtime supervisor, Crash and sleep): `powerMonitor` `suspend` pauses the follower, and `resume` reads the slot folder again and gives the URL 20 s before the gone rule
// applies, so the sleep's gap is not counted as an unanswered GUI. This module only joins the two ends; it takes the monitor as an argument, so a test emits the events itself and the
// e2e test emits them through `electronApp.evaluate`, as a real sleep of 5 minutes cannot run on a CI runner.

/** The part of Electron's `powerMonitor` this module uses. */
export interface PowerMonitorLike {
	on(event: "suspend" | "resume", listener: () => void): void;
	removeListener(event: "suspend" | "resume", listener: () => void): void;
}

/** What follows the computer's sleep: the supervisor. */
export interface PowerTarget {
	suspend(): void;
	resume(): void;
}

/** Wires `target` to the monitor and returns the function that unwires it. */
export function attachPower(monitor: PowerMonitorLike, target: PowerTarget, log: RuntimeEvent): () => void {
	const onSuspend = (): void => {
		log({ event: "power-suspend" });
		target.suspend();
	};
	const onResume = (): void => {
		log({ event: "power-resume" });
		target.resume();
	};
	monitor.on("suspend", onSuspend);
	monitor.on("resume", onResume);
	return () => {
		monitor.removeListener("suspend", onSuspend);
		monitor.removeListener("resume", onResume);
	};
}
