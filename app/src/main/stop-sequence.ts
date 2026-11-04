import type { RuntimeEvent } from "./runtime/log.ts";

interface Disposable {
	dispose(): void;
	settled?(): Promise<unknown>;
}

export interface StopParts {
	supervisor: { beginQuit(): void; stop(): Promise<{ ok: boolean; leftovers: readonly unknown[] }> };
	updates: { dispose(): void };
	accounts: Required<Disposable>;
	claude: Required<Disposable>;
	linear: Required<Disposable>;
	engineHost: { dispose(): Promise<unknown> };
	log: RuntimeEvent;
}

/** The stop sequence of a quit and of Restart to update: the install in the engine ends, every sign-in ends or is finished, the stack stops. Resolves with whether everything stopped. */
export function stopSequence(p: StopParts): Promise<boolean> {
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
		.then(() => p.supervisor.stop())
		.then((report) => {
			p.log({ event: "quit-stop", ok: report.ok, leftovers: report.leftovers.length });
			return report.ok;
		})
		.catch((error: Error) => {
			p.log({ event: "quit-stop-failed", detail: error.message.slice(0, 300) });
			return false;
		});
}
