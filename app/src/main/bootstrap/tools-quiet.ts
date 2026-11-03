import type { Layout } from "../paths.ts";
import type { Processes } from "../platform/index.ts";
import { listLeftovers } from "../runtime/identity.ts";
import { StageError } from "./errors.ts";
import type { StageLog } from "./log.ts";

// A package stage writes pi's package prefix (`<agent>/npm`) in place, and pi runs npm as its own child. The runner ends only the child it started, by its held handle, so a
// quit or a timeout in the middle of `pi install` can leave that npm running, and npm goes on writing the prefix after the app is gone (R9-F001). The app does not kill what it
// holds no handle for (spec: Start times); it waits instead. Before a package stage's first `pi install` or `pi remove`, and again after a call of pi that ended by a timeout or an
// abort, one listing looks for any process whose executable, by its full path, lies under `<root>/tools` (the private Node npm runs on included). The command line is never read.
// Anything found is waited for a bounded time; what is still there after that fails the stage as `locked`, and the PM's Try again waits once more.

/** How long a package stage waits for programs of the data root that were left running. A leftover npm finishes its install in well under this. */
export const TOOLS_WAIT_MS = 90_000;
export const TOOLS_POLL_MS = 1_000;

export interface ToolsQuietOptions {
	waitMs?: number;
	pollMs?: number;
}

export interface QuietRequest {
	layout: Layout;
	processes: Processes;
	signal: AbortSignal;
	stage: string;
	log: StageLog;
}

const pause = (ms: number, signal: AbortSignal): Promise<void> =>
	new Promise((resolve) => {
		if (signal.aborted) return resolve();
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = (): void => {
			clearTimeout(timer);
			resolve();
		};
		signal.addEventListener("abort", onAbort, { once: true });
	});

/**
 * What one engine run knows about the programs under `<root>/tools`. The listing costs a PowerShell start on Windows, so a clean answer holds for the rest of the run, until a call
 * of pi ends by a timeout or an abort (`markDirty`): that is the only way this run can leave an npm of its own behind.
 */
export class ToolsQuiet {
	#clean = false;
	readonly #waitMs: number;
	readonly #pollMs: number;

	constructor(options: ToolsQuietOptions = {}) {
		this.#waitMs = options.waitMs ?? TOOLS_WAIT_MS;
		this.#pollMs = options.pollMs ?? TOOLS_POLL_MS;
	}

	/** A child of this run was ended without its own children: the next package stage lists again. */
	markDirty(): void {
		this.#clean = false;
	}

	/** Returns when no program of the data root runs, waits while one does, and throws `locked` (no automatic retry: the wait was the retry) when one still does after the limit. */
	async ensure(request: QuietRequest): Promise<void> {
		if (this.#clean) return;
		const { layout, processes, signal, stage, log } = request;
		const began = Date.now();
		let found = await listLeftovers(processes, layout);
		const named = (): string[] => found.map((f) => `${f.file} (pid ${f.pid})`);
		const busy = found.length > 0;
		if (busy) log.event({ event: "tools-busy", programs: named() });
		while (found.length > 0) {
			if (signal.aborted) throw new StageError("other", { stage }, "cancelled");
			const waited = Date.now() - began;
			if (waited >= this.#waitMs) {
				log.event({ event: "tools-locked", waitedMs: waited, programs: named() });
				throw new StageError(
					"locked",
					{ reason: "tools-running" },
					`programs of the data root were still running after ${Math.round(waited / 1000)} s: ${named().join(", ")}. A package install would change the folder they use, so ${stage} did not start it.`,
					{ noRetry: true },
				);
			}
			await pause(Math.min(this.#pollMs, this.#waitMs - waited), signal);
			found = await listLeftovers(processes, layout);
		}
		if (busy) log.event({ event: "tools-quiet", waitedMs: Date.now() - began });
		this.#clean = true;
	}
}
