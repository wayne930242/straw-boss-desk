// The design says a later launch reaches the GUI in 30 s; the e2e allows 45 s because a Windows runner took 26.7 s once (Build note, task 9). A run that measures more than 30 s is a finding, and
// only a person reading the log would see it, so it is also a GitHub Actions warning annotation that shows on the run's summary page (R9-F004 d).

export const RELAUNCH_DESIGN_S = 30;

/** The log line for a relaunch that took `ms`, with a `::warning::` workflow command in front of it when it took longer than the design says. */
export function relaunchNotice(ms: number): string {
	const seconds = (ms / 1000).toFixed(1);
	const line = `relaunch reached the GUI in ${seconds} s`;
	return ms / 1000 > RELAUNCH_DESIGN_S ? `::warning title=Slow relaunch::${line}, the design says ${RELAUNCH_DESIGN_S} s (spec: Build notes, task 9)\n${line}` : line;
}
