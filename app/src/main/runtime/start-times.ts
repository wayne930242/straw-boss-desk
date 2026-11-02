import type { Layout } from "../paths.ts";
import type { ProcessInfo, Processes } from "../platform/types.ts";
import { isUnderTools, SerialQueue } from "./identity.ts";
import type { RuntimeEvent } from "./log.ts";
import type { ProcessRecord, StartFile, StartRecord } from "./start-file.ts";

// Start times in `state/start.json` (spec: Runtime supervisor, Start times: Recording, Re-recording, Adopting). A start time is what lets the app kill a
// process it holds no handle for, so the rules for writing one are strict:
//   - the record is the app's own read (`Processes.inspect`), never `up`'s `started`, so the kill check, which reads the same way, compares like with like;
//   - a process the app did not start (`up`'s answer, the follower's `server.json` pid) is recorded only when the same read shows its executable under `<root>/tools`;
//   - a process the app finds running (adoption) keeps its old record only when the start time read now equals it; a mismatch or no record drops the start time;
//   - on Windows each read is a PowerShell start of 2 to 5 s, so nothing is read before the GUI shows (the Herdr the app started is covered by its handle); the
//     reads of a start are one call after the GUI shows, and every later read waits its turn in a queue so two never overlap. macOS reads at once (`ps`).

export type Kind = "herdr" | "sb";

/** What the deferred read does for a process. `none`: nothing is read and the process keeps no start time this run. */
type Plan = "record-trusted" | "record" | "adopt" | "none";

export class StartTimes {
	readonly #layout: Layout;
	readonly #processes: Processes;
	readonly #file: StartFile;
	readonly #log: RuntimeEvent;
	readonly #queue = new SerialQueue();
	readonly #plan: Partial<Record<Kind, Plan>> = {};
	readonly #eager: boolean;

	constructor(deps: { layout: Layout; processes: Processes; startFile: StartFile; log: RuntimeEvent; eager?: boolean }) {
		this.#layout = deps.layout;
		this.#processes = deps.processes;
		this.#file = deps.startFile;
		this.#log = deps.log;
		// macOS reads at once: `ps` is cheap. Windows waits for `flush`, which the supervisor calls once the GUI shows.
		this.#eager = deps.eager ?? deps.layout.platform === "darwin";
	}

	/** The Herdr server of this run, already written to `start.json` without a start time: one the app started (its handle covers it; the start time is recorded on top) or one it found and reused (adopted). */
	async herdrReady(how: "started" | "reused"): Promise<void> {
		this.#plan.herdr = how === "started" ? "record-trusted" : "adopt";
		if (this.#eager) await this.flush();
	}

	/**
	 * The sb server of this run, already written to `start.json` (an adopted one with the record it had), from `up`'s answer. `found` is a server the app did not start in this call: it keeps the record it had only when the start time still
	 * matches the same pid (adoption). Any other answer means `up` started or replaced it: it is recorded, with the executable check.
	 */
	async sbReady(pid: number, server: string): Promise<void> {
		const record = this.#file.read()?.sb ?? null;
		this.#plan.sb = server === "found" ? (record?.pid === pid ? "adopt" : "none") : "record";
		if (this.#eager) await this.flush();
	}

	/** Reads the start times the plan asks for, in one call, and writes them. */
	flush(): Promise<void> {
		return this.#queue.run(async () => {
			const plan = { ...this.#plan };
			this.#plan.herdr = undefined;
			this.#plan.sb = undefined;
			const current = this.#file.read();
			const wanted: number[] = [];
			if (plan.herdr !== undefined && plan.herdr !== "none" && current?.herdr) wanted.push(current.herdr.pid);
			if (plan.sb !== undefined && plan.sb !== "none" && current?.sb) wanted.push(current.sb.pid);
			if (wanted.length === 0) return;
			const infos = await this.#processes.inspect(wanted);
			const byPid = new Map(infos.map((i) => [i.pid, i]));
			await this.#file.update((record) => {
				if (record === null) return null;
				const next: StartRecord = { ...record };
				if (plan.herdr !== undefined && record.herdr) next.herdr = this.#apply("herdr", plan.herdr, record.herdr, byPid.get(record.herdr.pid));
				if (plan.sb !== undefined && record.sb) next.sb = { ...this.#apply("sb", plan.sb, record.sb, byPid.get(record.sb.pid)), slotDir: record.sb.slotDir };
				return next;
			});
		});
	}

	#apply(kind: Kind, plan: Plan, held: ProcessRecord, info: ProcessInfo | undefined): ProcessRecord {
		const keep = (startTime: string | null): ProcessRecord => ({ pid: held.pid, startTime });
		const read = info?.startTime ?? null;
		switch (plan) {
			case "none":
				return held;
			case "adopt": {
				if (held.startTime !== null && read !== null && read === held.startTime) {
					this.#log({ event: "start-time-adopted", kind, pid: held.pid });
					return held;
				}
				this.#log({ event: "start-time-dropped", kind, pid: held.pid, why: held.startTime === null ? "no record" : read === null ? "unreadable" : "differs" });
				return keep(null);
			}
			case "record-trusted":
				if (read === null) {
					this.#log({ event: "start-time-unreadable", kind, pid: held.pid });
					return keep(null);
				}
				this.#log({ event: "start-time-recorded", kind, pid: held.pid, trusted: true });
				return keep(read);
			case "record": {
				if (read === null) {
					this.#log({ event: "start-time-unreadable", kind, pid: held.pid });
					return keep(null);
				}
				if (info?.executable == null || !isUnderTools(this.#layout, info.executable)) {
					this.#log({ event: "start-time-refused", kind, pid: held.pid, why: "its executable is not under the app's tools folder" });
					return keep(null);
				}
				this.#log({ event: "start-time-recorded", kind, pid: held.pid, trusted: false });
				return keep(read);
			}
		}
	}

	/**
	 * A restart: the process of `kind` now has `pid`. The old record goes first (the new pid is written with no start time, so nothing is ever killed by the old
	 * one), then the new pid's start time is read the same way as a first one and written. `byApp`: the app started the process (its handle covers it, so no executable check).
	 * Queued behind any read in flight. Resolves when the record is written.
	 */
	rerecord(kind: Kind, pid: number, options: { byApp: boolean; slotDir?: string }): Promise<void> {
		this.#log({ event: "rerecord", kind, pid, byApp: options.byApp });
		return this.#queue.run(async () => {
			await this.#file.update((record) => {
				if (record === null) return null;
				if (kind === "herdr") return { ...record, herdr: { pid, startTime: null } };
				const slotDir = options.slotDir ?? record.sb?.slotDir;
				return slotDir === undefined ? record : { ...record, sb: { pid, startTime: null, slotDir } };
			});
			const info = (await this.#processes.inspect([pid]))[0];
			await this.#file.update((record) => {
				if (record === null) return null;
				const held = kind === "herdr" ? record.herdr : record.sb;
				// The record may have moved on while the read ran (another restart): only the pid that was read is written.
				if (held === null || held.pid !== pid) return record;
				const done = this.#apply(kind, options.byApp ? "record-trusted" : "record", held, info);
				return kind === "herdr" ? { ...record, herdr: done } : record.sb ? { ...record, sb: { ...done, slotDir: record.sb.slotDir } } : record;
			});
		});
	}

	/** Resolves when every queued read has been written. */
	idle(): Promise<void> {
		return this.#queue.idle();
	}
}
