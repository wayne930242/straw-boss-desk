import { randomBytes } from "node:crypto";
import { linkSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Layout } from "../paths.ts";
import type { Processes } from "../platform/index.ts";
import { packageMayLoadSentence } from "./errors.ts";
import { JsonFileError, readJsonFile, removeTree, writeFileAtomic, type JsonValue } from "./fsutil.ts";

// `state/bootstrap.json` (per stage: status, version, evidence, hashes) and `state/current.json` (the active version of each tool), and the engine's lock.
// Both files are written by rename, so a kill between two writes leaves the old file or the new one (spec: Bootstrap engine, Resume).

export type StageStatus = "running" | "ok" | "failed";

export interface FailureNote {
	category: string;
	/** The version that was being installed. */
	version: string | null;
	message: string;
	at: string;
}

/** Something a stage found that does not fail it. `sentence` is the plain English line; the catalog carries zh-TW from `kind` and `host`. */
export interface StageWarning {
	/** `forge-host-unreachable`, ... */
	kind: string;
	host?: string;
	/** A file the finding is about (`wsl-bash`: the `bash.exe` a pane would run; `machine-pi`: the `pi` it would run; `machine-bun`: the `bun` or `bunx` it would run). */
	path?: string;
	sentence: string;
}

/**
 * Why the app must not start pi (T7-F002): a package failed its check, `pi remove` failed too, and the package could not be taken off pi's package list, so pi
 * would load it. Written on the record of the stage that failed; the next run of that stage that succeeds writes a record without it. The supervisor reads
 * it through `StateStore.startBlocks()`.
 */
export interface StartBlock {
	kind: "package-may-load";
	/** The npm package name. */
	package: string;
	/** The plain English line for the PM; the catalog carries zh-TW from `kind` and `package`. */
	sentence: string;
}

export interface StageRecord {
	status: StageStatus;
	/** The version this stage made active, or the one it was installing while `running`. */
	version: string;
	/** What `verify` returned. */
	evidence: string;
	at: string;
	/** SHA-256 of each installed executable as recorded at activation, keyed by a path relative to the data root with `/` separators (R-F009). */
	hashes: Record<string, string>;
	/** The versions of other tools this stage's output names; any change fails `detect` (spec: Stage contract). */
	dependsOn: Record<string, string>;
	/** Set when a later attempt failed while this record's version stayed active. */
	lastFailure?: FailureNote;
	/** What the stage found that does not fail it (the preflight's unreachable recipe forge host). */
	warnings?: StageWarning[];
	/** Set while the last failure left a package that may still load code; start refuses while any record has it (T7-F002). */
	startBlock?: StartBlock;
}

export interface BootstrapState {
	schema: 1;
	stages: Record<string, StageRecord>;
}

export interface CurrentState {
	schema: 1;
	/** The active version of each tool, by tool name. */
	versions: Record<string, string>;
	/** The version each tool had before its last change; the target of a rollback. */
	previous: Record<string, string>;
}

const emptyBootstrap = (): BootstrapState => ({ schema: 1, stages: {} });
const emptyCurrent = (): CurrentState => ({ schema: 1, versions: {}, previous: {} });

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isStringMap = (value: unknown): value is Record<string, string> => isObject(value) && Object.values(value).every((v) => typeof v === "string");

function asRecord(value: unknown): StageRecord | null {
	if (!isObject(value)) return null;
	const { status, version, evidence, at, hashes, dependsOn } = value;
	if (status !== "running" && status !== "ok" && status !== "failed") return null;
	if (typeof version !== "string" || typeof evidence !== "string" || typeof at !== "string") return null;
	if (!isStringMap(hashes) || !isStringMap(dependsOn)) return null;
	const failure = value.lastFailure;
	const lastFailure =
		isObject(failure) && typeof failure.category === "string" && typeof failure.message === "string" && typeof failure.at === "string"
			? { category: failure.category, version: typeof failure.version === "string" ? failure.version : null, message: failure.message, at: failure.at }
			: undefined;
	const warnings = Array.isArray(value.warnings)
		? value.warnings.flatMap((w): StageWarning[] =>
				isObject(w) && typeof w.kind === "string" && typeof w.sentence === "string" ? [{ kind: w.kind, ...(typeof w.host === "string" ? { host: w.host } : {}), ...(typeof w.path === "string" ? { path: w.path } : {}), sentence: w.sentence }] : [],
			)
		: [];
	// A start block that does not parse is still a block: dropping it would let pi start.
	const startBlock = value.startBlock === undefined ? undefined : asStartBlock(value.startBlock);
	return { status, version, evidence, at, hashes, dependsOn, ...(lastFailure ? { lastFailure } : {}), ...(warnings.length > 0 ? { warnings } : {}), ...(startBlock ? { startBlock } : {}) };
}

function asStartBlock(value: unknown): StartBlock {
	const block = isObject(value) ? value : {};
	const name = typeof block.package === "string" ? block.package : "";
	return { kind: "package-may-load", package: name, sentence: typeof block.sentence === "string" && block.sentence !== "" ? block.sentence : packageMayLoadSentence(name === "" ? undefined : name) };
}

function asBootstrap(value: JsonValue): BootstrapState | null {
	if (!isObject(value) || value.schema !== 1 || !isObject(value.stages)) return null;
	const stages: Record<string, StageRecord> = {};
	for (const [name, raw] of Object.entries(value.stages)) {
		const record = asRecord(raw);
		if (record === null) return null;
		stages[name] = record;
	}
	return { schema: 1, stages };
}

function asCurrent(value: JsonValue): CurrentState | null {
	if (!isObject(value) || value.schema !== 1 || !isStringMap(value.versions) || !isStringMap(value.previous)) return null;
	return { schema: 1, versions: value.versions, previous: value.previous };
}

/** Moves an unreadable state file aside so the engine can start over from what is on disk, and says so. */
function quarantine(file: string, onQuarantine: (file: string, moved: string) => void): void {
	const moved = `${file}.corrupt-${Date.now()}`;
	renameSync(file, moved);
	onQuarantine(file, moved);
}

export interface StateStoreOptions {
	/** Called when a state file was unreadable and was moved aside. */
	onQuarantine?: (file: string, moved: string) => void;
}

/**
 * The two state files of one data root, with writes serialized inside this process.
 *
 * Reads (`record`, `version`) answer from a copy read once. Every change re-reads its file from disk first, so a store whose copy went stale (the
 * engine updated a version since, in this process or another) never writes the stale copy back. The engine holds the engine lock for a whole run;
 * `rollbackTool` and `pruneInactive`, which main calls between runs, take it themselves.
 */
export class StateStore {
	readonly bootstrapFile: string;
	readonly currentFile: string;
	readonly #layout: Layout;
	readonly #onQuarantine: (file: string, moved: string) => void;
	#bootstrap: BootstrapState | null = null;
	#current: CurrentState | null = null;
	#queue: Promise<unknown> = Promise.resolve();

	constructor(layout: Layout, options: StateStoreOptions = {}) {
		this.#layout = layout;
		this.bootstrapFile = join(layout.state, "bootstrap.json");
		this.currentFile = join(layout.state, "current.json");
		this.#onQuarantine = options.onQuarantine ?? (() => {});
	}

	#load<T>(file: string, parse: (value: JsonValue) => T | null, empty: () => T): T {
		let value: JsonValue;
		try {
			value = readJsonFile(file);
		} catch (error) {
			if (!(error instanceof JsonFileError)) throw error;
			quarantine(file, this.#onQuarantine);
			return empty();
		}
		if (value === null) return empty();
		const parsed = parse(value);
		if (parsed === null) {
			quarantine(file, this.#onQuarantine);
			return empty();
		}
		return parsed;
	}

	bootstrap(): BootstrapState {
		this.#bootstrap ??= this.#load(this.bootstrapFile, asBootstrap, emptyBootstrap);
		return this.#bootstrap;
	}

	current(): CurrentState {
		this.#current ??= this.#load(this.currentFile, asCurrent, emptyCurrent);
		return this.#current;
	}

	/** The state files as they are on disk now, replacing the copy this store read earlier. */
	#reload(): void {
		this.#bootstrap = null;
		this.#current = null;
	}

	record(stage: string): StageRecord | null {
		return this.bootstrap().stages[stage] ?? null;
	}

	/** Every stage record, by stage name, as this store last read or wrote them: a record outlives the stack that planned its stage, which is how the `pkg-prune` stage finds a package an earlier stack installed. */
	records(): Readonly<Record<string, StageRecord>> {
		return this.bootstrap().stages;
	}

	/** The stages whose last failure left a package that may still load code. The supervisor refuses to start pi while this is not empty (T7-F002); read it from a fresh store. */
	startBlocks(): Array<{ stage: string } & StartBlock> {
		return Object.entries(this.bootstrap().stages).flatMap(([stage, record]) => (record.startBlock ? [{ stage, ...record.startBlock }] : []));
	}

	/** The active version of `tool`, or null. */
	version(tool: string): string | null {
		return this.current().versions[tool] ?? null;
	}

	/**
	 * Runs `change` after every earlier change, on the files as they are on disk, and writes the result by rename. One writer at a time keeps
	 * parallel stages from overwriting each other.
	 */
	#serial<T>(change: () => T): Promise<T> {
		const run = this.#queue.then(() => {
			this.#reload();
			return change();
		});
		this.#queue = run.catch(() => {});
		return run;
	}

	/** Runs `change` under the engine lock: for the changes main makes between runs. Throws `EngineLockedError` while an engine run holds the root. */
	async #locked<T>(processes: Processes, change: () => T): Promise<T> {
		const lock = await acquireEngineLock(this.#layout, processes);
		try {
			return await this.#serial(change);
		} finally {
			lock.release();
		}
	}

	setRecord(stage: string, record: StageRecord): Promise<void> {
		return this.#serial(() => {
			const state = this.bootstrap();
			state.stages[stage] = record;
			writeFileAtomic(this.bootstrapFile, `${JSON.stringify(state, null, "\t")}\n`);
		});
	}

	/** Forgets a stage's record: for a stage no stack plans any more, once what it installed is gone (`pkg-prune`). A record that is not there is not an error. */
	dropRecord(stage: string): Promise<void> {
		return this.#serial(() => {
			const state = this.bootstrap();
			if (!(stage in state.stages)) return;
			delete state.stages[stage];
			writeFileAtomic(this.bootstrapFile, `${JSON.stringify(state, null, "\t")}\n`);
		});
	}

	/** Makes `version` the active one of `tool`, keeping the one it replaces as the rollback target. */
	setVersion(tool: string, version: string): Promise<void> {
		return this.#serial(() => {
			const state = this.current();
			const old = state.versions[tool];
			if (old !== undefined && old !== version) state.previous[tool] = old;
			state.versions[tool] = version;
			writeFileAtomic(this.currentFile, `${JSON.stringify(state, null, "\t")}\n`);
		});
	}

	/**
	 * Points `current.json` back at the version `tool` had before its last change (spec: Rollback). Returns that version, or null when there is none.
	 * Stages whose evidence names the tool's version fail `detect` afterwards, so the next graph run writes them again for the old version.
	 * Takes the engine lock: it throws `EngineLockedError` while a run is active.
	 */
	rollbackTool(tool: string, processes: Processes): Promise<string | null> {
		return this.#locked(processes, () => {
			const state = this.current();
			const back = state.previous[tool];
			if (back === undefined) return null;
			state.versions[tool] = back;
			delete state.previous[tool];
			writeFileAtomic(this.currentFile, `${JSON.stringify(state, null, "\t")}\n`);
			return back;
		});
	}

	/**
	 * Deletes the folders of `tool` that are not the active version and forgets the rollback target: "the previous version is deleted after the next
	 * successful start". Failures to delete are returned, not thrown, so a locked old folder does not fail a start.
	 * Takes the engine lock (it throws `EngineLockedError` while a run is active), so it never deletes a staging folder a run is writing.
	 */
	pruneInactive(tool: string, processes: Processes): Promise<string[]> {
		return this.#locked(processes, () => {
			const state = this.current();
			const active = state.versions[tool];
			const base = join(this.#layout.tools.root, tool);
			const errors: string[] = [];
			let names: string[] = [];
			try {
				names = readdirSync(base);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			for (const name of names) {
				if (name === active) continue;
				try {
					removeTree(join(base, name));
				} catch (error) {
					errors.push(`${join(base, name)}: ${(error as Error).message}`);
				}
			}
			if (state.previous[tool] !== undefined && errors.length === 0) {
				delete state.previous[tool];
				writeFileAtomic(this.currentFile, `${JSON.stringify(state, null, "\t")}\n`);
			}
			return errors;
		});
	}
}

// ---- the engine's lock ---------------------------------------------------------------------------------------------

export class EngineLockedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "EngineLockedError";
	}
}

export interface EngineLock {
	release(): void;
}

export interface LockOptions {
	/** Whether the OS still has a process with this pid; the default asks with signal 0. Used only when `Processes.inspect` gave no start time. */
	pidAlive?: (pid: number) => boolean;
	/** An unreadable lock younger than this is taken to be mid-write by its owner, not stale (default 2 s). */
	unreadableGraceMs?: number;
}

const UNREADABLE_GRACE_MS = 2000;

/** True unless the OS says there is no such process: a pid we may not signal (EPERM) is alive. */
export function osPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

export interface LockOwner {
	pid: number;
	startTime: string | null;
}

/**
 * One engine per data root: `state/engine.lock` holds the owner's pid, start token, and a random token. Only one run at a time may hold it, this process's
 * own earlier run included: a lock that names this very process (same pid and start token) is held, never stale. A lock is stale when its owner is
 * gone, or its pid now belongs to another process (a different start token), and is taken over; a live owner makes this throw `EngineLockedError`.
 *
 * When the platform gives no start time for the owner (a timed-out `ps`), the answer is "unknown", and unknown counts as alive unless the OS itself
 * says the pid does not exist. The takeover renames the stale file to a name of our own and checks that what moved is the file judged stale before
 * deleting it, so two contenders that read the same stale lock cannot both win; the winner creates the new lock with `wx`.
 */
export async function acquireEngineLock(layout: Layout, processes: Processes, pid: number = process.pid, options: LockOptions = {}): Promise<EngineLock> {
	const file = join(layout.state, "engine.lock");
	const pidAlive = options.pidAlive ?? osPidAlive;
	const grace = options.unreadableGraceMs ?? UNREADABLE_GRACE_MS;
	mkdirSync(dirname(file), { recursive: true });
	const mine = (await processes.inspect([pid]))[0]?.startTime ?? null;
	const token = randomBytes(8).toString("hex");
	const body = `${JSON.stringify({ pid, startTime: mine, token })}\n`;
	for (let attempt = 0; attempt < 4; attempt++) {
		try {
			writeFileSync(file, body, { flag: "wx" });
			return {
				release() {
					// Only the lock we wrote: a lock someone else took over is theirs.
					try {
						if (readFileSync(file, "utf8") === body) rmSync(file, { force: true });
					} catch {
						// the lock is gone or unreadable: nothing of ours to release
					}
				},
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		const text = readText(file);
		if (text === null) continue; // released between the failed create and the read
		const owner = parseLockOwner(text);
		if (owner === null) {
			if (ageMs(file) < grace) throw new EngineLockedError(`another engine is writing ${file}`);
		} else if (await ownerAlive(owner, processes, pid, mine, pidAlive)) {
			throw new EngineLockedError(`another engine (pid ${owner.pid}) is running for ${layout.root}`);
		}
		await takeOver(file, text);
	}
	throw new EngineLockedError(`could not take the engine lock at ${file}`);
}

async function ownerAlive(owner: LockOwner, processes: Processes, pid: number, mine: string | null, pidAlive: (pid: number) => boolean): Promise<boolean> {
	if (owner.pid === pid) {
		// This process: held unless the pid was reused, which needs two known, different start tokens. Unknown fails closed.
		return owner.startTime === null || mine === null || owner.startTime === mine;
	}
	const info = (await processes.inspect([owner.pid]))[0];
	const seen = info?.startTime ?? null;
	if (seen !== null) return owner.startTime === null || seen === owner.startTime;
	return pidAlive(owner.pid);
}

/**
 * Removes the stale lock whose text was `stale`: rename it away, check that the renamed file is that text, delete it. If it is something else (another
 * contender took over first and wrote its own lock), it is put back, without replacing anything newer.
 */
async function takeOver(file: string, stale: string): Promise<void> {
	const away = `${file}.stale-${process.pid}-${randomBytes(4).toString("hex")}`;
	try {
		renameSync(file, away);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return; // someone else removed it first
		throw error;
	}
	if (readText(away) === stale) {
		rmSync(away, { force: true });
		return;
	}
	try {
		linkSync(away, file);
	} catch {
		// something newer is already there: the lock we moved cannot go back, and its owner will find the file is not its own
	}
	rmSync(away, { force: true });
}

function readText(file: string): string | null {
	try {
		return readFileSync(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

function ageMs(file: string): number {
	try {
		return Math.max(0, Date.now() - statSync(file).mtimeMs);
	} catch {
		return Number.POSITIVE_INFINITY;
	}
}

export function parseLockOwner(text: string): LockOwner | null {
	try {
		const value: unknown = JSON.parse(text);
		if (isObject(value) && typeof value.pid === "number") return { pid: value.pid, startTime: typeof value.startTime === "string" ? value.startTime : null };
	} catch {
		// an unreadable lock is stale (once it is older than the grace period)
	}
	return null;
}
