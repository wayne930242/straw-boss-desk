import type { Layout } from "../paths.ts";
import type { ProcessInfo, Processes } from "../platform/types.ts";
import { handleHeld, isUnderTools, SerialQueue, type ProcHandle } from "./identity.ts";
import type { RuntimeEvent } from "./log.ts";
import type { ProcessRecord, StartFile, StartRecord } from "./start-file.ts";

// Start times in `state/start.json` (spec: Runtime supervisor, Start times: Recording, Re-recording, Adopting). A start time is what lets the app kill a
// process it holds no handle for, so the rules for writing one are strict:
//   - the record is the app's own read (`Processes.inspect`), never `up`'s `started`, so the kill check, which reads the same way, compares like with like;
//   - a process the app did not start (`up`'s answer, the follower's `server.json` pid) is recorded only when the same read shows its executable under `<root>/tools`;
//   - a process the app finds running (adoption) keeps its old record only when the start time read now equals it; a mismatch or no record drops the start time;
//   - on Windows each read is a PowerShell start of 2 to 5 s, so nothing is read before the GUI shows (the Herdr the app started is covered by its handle); the
//     reads of a start are one call after the GUI shows, and every later read waits its turn in a queue so two never overlap. macOS reads at once (`ps`);
//   - the Herdr the app started is recorded only if its handle is still held, and not exited, when the read has returned (T8A-F001): the handle is what keeps its
//     pid from being given to another program, so a handle that ended during a late read means the start time may be a stranger's. Its executable must also lie
//     under `<root>/tools` whenever the read can tell.

export type Kind = "herdr" | "sb";

/** What the deferred read does for a process. */
type Plan = "record-trusted" | "record" | "adopt";

export class StartTimes {
	readonly #layout: Layout;
	readonly #processes: Processes;
	readonly #file: StartFile;
	readonly #log: RuntimeEvent;
	readonly #queue = new SerialQueue();
	readonly #plan: Partial<Record<Kind, Plan>> = {};
	/** The handle of the Herdr the app started, for the plan `record-trusted`: it must still be held after the read. */
	#herdrHandle: ProcHandle | null = null;
	readonly #eager: boolean;

	constructor(deps: { layout: Layout; processes: Processes; startFile: StartFile; log: RuntimeEvent; eager?: boolean }) {
		this.#layout = deps.layout;
		this.#processes = deps.processes;
		this.#file = deps.startFile;
		this.#log = deps.log;
		// macOS reads at once: `ps` is cheap. Windows waits for `flush`, which the supervisor calls once the GUI shows.
		this.#eager = deps.eager ?? deps.layout.platform === "darwin";
	}

	/**
	 * The Herdr server of this run, already written to `start.json` without a start time: one the app started (its handle covers it; the start time is recorded on
	 * top, only while the handle is still held after the read) or one it found and reused (adopted).
	 */
	herdrReady(how: "reused"): Promise<void>;
	herdrReady(how: "started", handle: ProcHandle): Promise<void>;
	async herdrReady(how: "started" | "reused", handle?: ProcHandle): Promise<void> {
		this.#plan.herdr = how === "started" ? "record-trusted" : "adopt";
		this.#herdrHandle = how === "started" ? (handle ?? null) : null;
		if (this.#eager) await this.flush();
	}

	/**
	 * The sb server of this run, already written to `start.json`, from `up`'s answer. `adopted`: `up` found the server the record already named (same pid), so it keeps that record only
	 * when the start time still matches (adoption). Any other answer, a server `up` started or replaced, or a `found` one under a pid the record did not name (a pi session restarted
	 * it since), is recorded with the executable check, as the spec's Re-recording says for a pid the app did not start (T8A-F013).
	 */
	async sbReady(adopted: boolean): Promise<void> {
		this.#plan.sb = adopted ? "adopt" : "record";
		if (this.#eager) await this.flush();
	}

	/** Reads the start times the plan asks for, in one call, and writes them. */
	flush(): Promise<void> {
		return this.#queue.run(async () => {
			const plan = { ...this.#plan };
			const herdrHandle = this.#herdrHandle;
			this.#plan.herdr = undefined;
			this.#plan.sb = undefined;
			this.#herdrHandle = null;
			const current = this.#file.read();
			const wanted: number[] = [];
			if (plan.herdr !== undefined && current?.herdr) wanted.push(current.herdr.pid);
			if (plan.sb !== undefined && current?.sb) wanted.push(current.sb.pid);
			if (wanted.length === 0) return;
			const infos = await this.#processes.inspect(wanted);
			const byPid = new Map(infos.map((i) => [i.pid, i]));
			await this.#file.update((record) => {
				if (record === null) return null;
				const next: StartRecord = { ...record };
				if (plan.herdr !== undefined && record.herdr) next.herdr = this.#apply("herdr", plan.herdr, record.herdr, byPid.get(record.herdr.pid), herdrHandle);
				if (plan.sb !== undefined && record.sb) next.sb = { ...this.#apply("sb", plan.sb, record.sb, byPid.get(record.sb.pid), null), slotDir: record.sb.slotDir };
				return next;
			});
		});
	}

	/** `handle`: the app's handle for the process, consulted only by `record-trusted`, and consulted here, after the read has returned (T8A-F001). */
	#apply(kind: Kind, plan: Plan, held: ProcessRecord, info: ProcessInfo | undefined, handle: ProcHandle | null): ProcessRecord {
		const keep = (startTime: string | null): ProcessRecord => ({ pid: held.pid, startTime });
		const read = info?.startTime ?? null;
		switch (plan) {
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
				// The read took 2 to 5 s on Windows; the process may have ended during it and its pid gone to another program. Only a handle that is still held now proves
				// the pid was ours through the whole read (the OS keeps the pid until the handle's exit is reaped).
				if (!handleHeld(handle) || handle.pid !== held.pid) {
					this.#log({ event: "start-time-refused", kind, pid: held.pid, why: "the process handle is no longer held, so the pid may belong to another program" });
					return keep(null);
				}
				// An executable that can be read must be the app's own; one that cannot be read is covered by the handle alone.
				if (info?.executable != null && !isUnderTools(this.#layout, info.executable)) {
					this.#log({ event: "start-time-refused", kind, pid: held.pid, why: "its executable is not under the app's tools folder" });
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
	 * one), then the new pid's start time is read the same way as a first one and written. `handle`: the app started the process and holds this handle (it covers the pid
	 * only while it is held after the read); without one the executable check applies, as for any pid the app did not start.
	 * Queued behind any read in flight. Resolves when the record is written.
	 */
	rerecord(kind: Kind, pid: number, options: { handle?: ProcHandle | null; slotDir?: string }): Promise<void> {
		const handle = options.handle ?? null;
		this.#log({ event: "rerecord", kind, pid, byApp: handle !== null });
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
				const done = this.#apply(kind, handle !== null ? "record-trusted" : "record", held, info, handle);
				return kind === "herdr" ? { ...record, herdr: done } : record.sb ? { ...record, sb: { ...done, slotDir: record.sb.slotDir } } : record;
			});
		});
	}

	/** Resolves when every queued read has been written. */
	idle(): Promise<void> {
		return this.#queue.idle();
	}
}
