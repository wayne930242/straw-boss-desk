import { randomBytes } from "node:crypto";
import { linkSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { EngineLockedError, osPidAlive, parseLockOwner } from "../bootstrap/state.ts";
import type { Layout } from "../paths.ts";
import type { Processes } from "../platform/types.ts";

// The engine lock at a start and at Repair (spec: Build notes, R4-F002). `state/engine.lock` is held by one engine run at a time. Two edge cases of task 4 can
// leave it held with no engine: a lock written while the engine could not read its own start time stays held while any process has that pid, and a release
// that races a contender's put-back can leave a file nobody owns. A start therefore reports a lock it cannot take in one plain sentence and offers Repair,
// and Repair removes a lock whose owner is not an engine of this root.

export const ENGINE_LOCKED_SENTENCE = "Another setup step is running, or a previous one stopped without letting go. Run Repair to clear it.";

/**
 * Throws `EngineLockedError` when an engine run holds the root, or a lock stays that nothing is known to have released. It reads the lock file and, only when there
 * is one, asks about its owner: no lock is the common case, and it costs no process read (on Windows each is a PowerShell start, and a start reads nothing before the
 * GUI shows). The owner counts as holding it when its start time still equals the one in the lock; when no start time can be read for it, a live pid holds it (fail closed,
 * as the engine's own takeover does, so a lock written while the engine could not read its start time stays held while any process has that pid: the case Repair clears).
 * A lock younger than 2 s that does not parse is being written. A lock whose owner is gone is stale: the next engine run takes it over, so it does not stop a start.
 */
export async function assertEngineIdle(layout: Layout, processes: Processes, pidAlive: (pid: number) => boolean = osPidAlive): Promise<void> {
	const file = join(layout.state, "engine.lock");
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	const owner = parseLockOwner(text);
	if (owner === null) {
		if (lockAgeMs(layout) !== null && (lockAgeMs(layout) as number) < 2000) throw new EngineLockedError(`another engine is writing ${file}`);
		return;
	}
	const seen = (await processes.inspect([owner.pid]))[0]?.startTime ?? null;
	const held = seen !== null ? owner.startTime === null || seen === owner.startTime : pidAlive(owner.pid);
	if (held) throw new EngineLockedError(`another engine (pid ${owner.pid}) holds ${file}`);
}

export { EngineLockedError };

export type RepairResult =
	/** There was no lock file. */
	| { result: "none" }
	/** The lock named an engine of this app that is running; nothing was removed. */
	| { result: "engine-running"; pid: number }
	/** The lock was removed; `owner` is the pid it named, or null for a file that did not parse. */
	| { result: "removed"; owner: number | null };

export interface RepairOptions {
	/** True when `pid` is an engine this app started and still holds (the `utilityProcess` handle's pid). The app's own pid is always ours, with or without this. */
	isOurEngine: (pid: number) => boolean;
}

/**
 * Removes a lock whose owner pid is not an engine of this root. An engine of this root is a `utilityProcess` this app started and still holds, or the app's own
 * process (its prune lock); every other pid in the file is a leftover (a crashed app's engine ends with its parent, and a pid the lock names may have been reused by any program),
 * whether the pid is alive or not. The file is renamed away first and removed only when what moved is the file that was judged, so a contender's new lock
 * is never deleted.
 */
export function repairEngineLock(layout: Layout, options: RepairOptions): RepairResult {
	const file = join(layout.state, "engine.lock");
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { result: "none" };
		throw error;
	}
	const owner = parseLockOwner(text);
	// The main process takes this lock itself with its own pid (`StateStore` prunes the previous versions under it), so a lock it holds is never a leftover (T8A-F009).
	if (owner !== null && (owner.pid === process.pid || options.isOurEngine(owner.pid))) return { result: "engine-running", pid: owner.pid };
	const away = `${file}.repair-${process.pid}-${randomBytes(4).toString("hex")}`;
	try {
		renameSync(file, away);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { result: "none" };
		throw error;
	}
	if (readFileSync(away, "utf8") === text) {
		rmSync(away, { force: true });
		return { result: "removed", owner: owner?.pid ?? null };
	}
	// Another contender took over between the read and the rename and wrote its own lock: put it back, without replacing anything newer.
	try {
		linkSync(away, file);
	} catch {
		// something newer is already there
	}
	rmSync(away, { force: true });
	return { result: "engine-running", pid: -1 };
}

/** The age of the lock file in ms, or null when there is none (for the sentence's detail). */
export function lockAgeMs(layout: Layout): number | null {
	try {
		return Math.max(0, Date.now() - statSync(join(layout.state, "engine.lock")).mtimeMs);
	} catch {
		return null;
	}
}
