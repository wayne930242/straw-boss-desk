import { posix, win32 } from "node:path";
import { isInside, type Layout } from "../paths.ts";
import type { Processes } from "../platform/types.ts";
import type { ProcessRecord } from "./start-file.ts";

// The desk kill invariant (spec: Runtime supervisor, Start times): the app kills a process, or adopts it as its own, only by a pid it holds a live child
// handle for, or by a pid whose current start time equals a non-empty start time it recorded. With neither, it never kills: it stops through the CLIs and
// reports what still runs. Nothing here reads a process's command line (other programs put passwords in theirs): a process is told by its pid, its
// start time, and the full path of its executable.

/** The part of a `ChildProcess` the kill rule needs. */
export interface ProcHandle {
	readonly pid?: number | undefined;
	readonly exitCode: number | null;
	readonly signalCode: NodeJS.Signals | null;
	kill(signal?: NodeJS.Signals | number): boolean;
}

/** True while the handle's process has not exited: its pid cannot have been reused, because the OS keeps it until the exit is reaped. */
export const handleHeld = (handle: ProcHandle | null | undefined): handle is ProcHandle & { pid: number } =>
	handle != null && handle.pid !== undefined && handle.exitCode === null && handle.signalCode === null;

export interface KillSubject {
	pid: number;
	/** What `start.json` holds for this pid, or null. */
	record: ProcessRecord | null;
	/** The handle the app holds for this pid, when it started the process in this run. */
	handle?: ProcHandle | null;
}

export type NotOurs = "no-record" | "no-start-time" | "gone" | "start-time-differs" | "start-time-unreadable";

export type KillVerdict = { may: true; via: "handle" | "start-time" } | { may: false; reason: NotOurs };

/**
 * Whether the app may kill `subject.pid`. A held handle for that pid is enough. Otherwise the record must hold a non-empty start time for the same pid
 * and the process's start time, read now, must equal it; a process that is gone, unreadable, or started at another time is not ours. One read of the
 * process table (one PowerShell call on Windows).
 */
export async function killVerdict(processes: Processes, subject: KillSubject): Promise<KillVerdict> {
	if (handleHeld(subject.handle) && subject.handle.pid === subject.pid) return { may: true, via: "handle" };
	const { record } = subject;
	if (record === null || record.pid !== subject.pid) return { may: false, reason: "no-record" };
	if (record.startTime === null || record.startTime === "") return { may: false, reason: "no-start-time" };
	const info = (await processes.inspect([subject.pid]))[0];
	if (info === undefined || info.startTime === null) return { may: false, reason: info === undefined ? "gone" : "start-time-unreadable" };
	return info.startTime === record.startTime ? { may: true, via: "start-time" } : { may: false, reason: "start-time-differs" };
}

export interface KillOutcome {
	pid: number;
	killed: boolean;
	verdict: KillVerdict;
}

/** Kills the process when `killVerdict` allows it: through the held handle, else by pid. A refusal changes nothing. */
export async function killOwned(processes: Processes, subject: KillSubject): Promise<KillOutcome> {
	const verdict = await killVerdict(processes, subject);
	if (!verdict.may) return { pid: subject.pid, killed: false, verdict };
	if (verdict.via === "handle" && subject.handle != null) {
		const killed = subject.handle.kill("SIGKILL");
		return { pid: subject.pid, killed, verdict };
	}
	return { pid: subject.pid, killed: processes.kill(subject.pid), verdict };
}

// ---- recording -------------------------------------------------------------------------------------------------------

/** True when `file` lies under `<root>/tools`, by its full path (the root's real path too, since `lsof` prints real paths). */
export function isUnderTools(layout: Layout, file: string): boolean {
	const P = layout.platform === "win32" ? win32 : posix;
	const roots = new Set([layout.tools.root, P.join(layout.record.realRoot, "tools")]);
	return [...roots].some((dir) => file !== dir && isInside(dir, file, P));
}

export type RecordRefusal = "unreadable" | "outside-tools";

export interface RecordRead {
	record: ProcessRecord | null;
	/** The executable's full path as the platform read it, for the log. */
	executable: string | null;
	refused?: RecordRefusal;
}

/**
 * The record for a pid, from one read: its start time, and with `requireUnderTools` also its executable, which must lie under `<root>/tools`. A pid the
 * app did not start (`up`'s answer, the follower's `server.json`) is recorded only when that read shows the app's own executable, so a stale
 * `server.json` pid that another program holds now is never recorded. A start time that cannot be read records nothing.
 */
export async function readRecord(processes: Processes, layout: Layout, pid: number, options: { requireUnderTools: boolean }): Promise<RecordRead> {
	const info = (await processes.inspect([pid]))[0];
	if (info === undefined || info.startTime === null || info.startTime === "") return { record: null, executable: info?.executable ?? null, refused: "unreadable" };
	if (options.requireUnderTools && (info.executable === null || !isUnderTools(layout, info.executable))) {
		return { record: null, executable: info.executable, refused: "outside-tools" };
	}
	return { record: { pid, startTime: info.startTime }, executable: info.executable };
}

/** A queue that runs one job at a time, so two reads that each cost a PowerShell start on Windows never overlap (spec: Start times, Re-recording). */
export class SerialQueue {
	#tail: Promise<unknown> = Promise.resolve();

	run<T>(job: () => Promise<T>): Promise<T> {
		const next = this.#tail.then(job);
		this.#tail = next.catch(() => {});
		return next;
	}

	idle(): Promise<void> {
		return this.#tail.then(() => undefined);
	}
}

// ---- the leftover listing --------------------------------------------------------------------------------------------

export interface Leftover {
	pid: number;
	/** The executable's file name (never its command line). */
	file: string;
}

/**
 * Any process whose executable, by its full path, lies under `<root>/tools`: one listing, after the stop sequence. The app's own process and the
 * pids in `except` are left out. The listing runs `lsof -d txt -Fpn` on macOS and one `Win32_Process` query (`ManagementObjectSearcher`) reading `ProcessId` and
 * `ExecutablePath` on Windows; neither reads a command line.
 */
export async function listLeftovers(processes: Processes, layout: Layout, except: readonly number[] = []): Promise<Leftover[]> {
	const P = layout.platform === "win32" ? win32 : posix;
	const dirs = [...new Set([layout.tools.root, P.join(layout.record.realRoot, "tools")])];
	const seen = new Map<number, Leftover>();
	for (const dir of dirs) {
		for (const p of await processes.listUnder(dir)) {
			if (p.pid === process.pid || except.includes(p.pid) || seen.has(p.pid)) continue;
			seen.set(p.pid, { pid: p.pid, file: p.executable === null ? "?" : P.basename(p.executable) });
		}
	}
	return [...seen.values()].sort((a, b) => a.pid - b.pid);
}
