import type { RuntimeEvent } from "./runtime/log.ts";

interface Disposable {
	dispose(): void;
	settled?(): Promise<unknown>;
}

export interface StopParts {
	supervisor: { beginQuit(): void; stop(options?: { waitForTools?: boolean }): Promise<{ ok: boolean; leftovers: readonly unknown[] }> };
	updates: { dispose(): void };
	accounts: Required<Disposable>;
	claude: Required<Disposable>;
	linear: Required<Disposable>;
	engineHost: { dispose(): Promise<unknown> };
	log: RuntimeEvent;
}

export interface StopOutcome {
	/** Everything stopped: nothing of the app runs from `<root>/tools`. */
	ok: boolean;
	/** The programs still running from `<root>/tools` after the stop, by executable file name (never a command line). */
	leftovers: Array<{ pid: number; file: string }>;
}

const leftoverOf = (value: unknown): { pid: number; file: string } | null => {
	if (typeof value !== "object" || value === null) return null;
	const { pid, file } = value as { pid?: unknown; file?: unknown };
	return typeof pid === "number" && typeof file === "string" ? { pid, file } : null;
};

/** The stop sequence of a quit and of Restart to update: the install in the engine ends, every sign-in ends or is finished, the stack stops. Resolves with whether everything stopped. */
export function stopSequence(p: StopParts): Promise<boolean> {
	return stopSequenceReport(p).then((outcome) => outcome.ok);
}

/**
 * The same stop, with the programs it could not end named (**Remove all data** refuses to delete while any runs). With `waitForTools` the last listing waits for programs under `<root>/tools` to end,
 * as Repair's does (R9B-F006): on macOS a pane's pi leaves the `balance.mjs after-close` helper for 30 s after it quits (seam U13), and a removal that took one listing would refuse for it.
 */
export function stopSequenceReport(p: StopParts, options: { waitForTools?: boolean } = {}): Promise<StopOutcome> {
	// An install running in the engine process ends first (a quit during the install resumes at the next launch: verified stages are skipped), then the stack stops.
	// A Repair job in the queue does not start the stack again once the engine is gone (T9-F002).
	p.supervisor.beginQuit();
	p.updates.dispose();
	// A device-code login that waits ends with the app; one that is being finished (glab signing in, the entries being recorded) is waited for, so the login is recorded and never lost.
	// A running `ttt init` or Claude sign-in does not survive the stop either, an update's included.
	p.accounts.dispose();
	p.claude.dispose();
	p.linear.dispose();
	return Promise.all([p.accounts.settled().catch(() => undefined), p.claude.settled().catch(() => undefined), p.linear.settled().catch(() => undefined), p.engineHost.dispose().catch(() => undefined)])
		.then(() => p.supervisor.stop(options))
		.then((report): StopOutcome => {
			p.log({ event: "quit-stop", ok: report.ok, leftovers: report.leftovers.length });
			return { ok: report.ok, leftovers: report.leftovers.map(leftoverOf).filter((l): l is { pid: number; file: string } => l !== null) };
		})
		.catch((error: Error): StopOutcome => {
			p.log({ event: "quit-stop-failed", detail: error.message.slice(0, 300) });
			return { ok: false, leftovers: [] };
		});
}

/** The stop of **Remove all data**: the report, with the wait for programs under `<root>/tools` that Repair's stop also does, so a pane's pi helper that ends within 30 s does not make the removal refuse. */
export const stopForRemoval = (p: StopParts): Promise<StopOutcome> => stopSequenceReport(p, { waitForTools: true });
