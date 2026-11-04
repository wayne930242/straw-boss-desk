// Reading the supervisor's start log from a test (the follow e2e). Test code only.

/** How far the clock of the app's process may run behind the test's own. On Windows two processes read wall clocks that differ by a few milliseconds (a high-resolution clock re-synced to the system time now and then), and one CDP round trip lies between the test's mark and the app's log line (R-F005). */
export const CLOCK_SKEW_MS = 1000;

export interface LogLine {
	event?: unknown;
	t?: unknown;
	[key: string]: unknown;
}

/**
 * The lines of `event` the app logged at or after `since` (the test's `Date.now()` mark), counting a line stamped up to `skewMs` before it. A caller passes the skew only where the mark is taken right
 * before the app's own call and nothing older than the margin can have the same event: the suspend check marks the resume 2 s after its suspend, so no older resume falls in a 1 s margin.
 */
export function eventsSince(lines: readonly LogLine[], event: string, since: number, skewMs = 0): LogLine[] {
	return lines.filter((l) => l.event === event && Date.parse(String(l.t)) >= since - skewMs);
}
