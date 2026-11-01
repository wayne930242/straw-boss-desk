import { mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Layout } from "../paths.ts";
import type { Processes } from "../platform/index.ts";
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
	return { status, version, evidence, at, hashes, dependsOn, ...(lastFailure ? { lastFailure } : {}) };
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

/** The two state files of one data root, with writes serialized inside this process. */
export class StateStore {
	readonly bootstrapFile: string;
	readonly currentFile: string;
	readonly #onQuarantine: (file: string, moved: string) => void;
	#bootstrap: BootstrapState | null = null;
	#current: CurrentState | null = null;
	#queue: Promise<unknown> = Promise.resolve();

	constructor(layout: Layout, options: StateStoreOptions = {}) {
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

	record(stage: string): StageRecord | null {
		return this.bootstrap().stages[stage] ?? null;
	}

	/** The active version of `tool`, or null. */
	version(tool: string): string | null {
		return this.current().versions[tool] ?? null;
	}

	/** Runs `change` after every earlier change and writes the result by rename. One writer at a time keeps parallel stages from overwriting each other. */
	#serial<T>(change: () => T): Promise<T> {
		const run = this.#queue.then(change);
		this.#queue = run.catch(() => {});
		return run;
	}

	setRecord(stage: string, record: StageRecord): Promise<void> {
		return this.#serial(() => {
			const state = this.bootstrap();
			state.stages[stage] = record;
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
	 */
	rollbackTool(tool: string): Promise<string | null> {
		return this.#serial(() => {
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
	 */
	pruneInactive(layout: Layout, tool: string): Promise<string[]> {
		return this.#serial(() => {
			const state = this.current();
			const active = state.versions[tool];
			const base = join(layout.tools.root, tool);
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

/**
 * One engine per data root: `state/engine.lock` holds the owner's pid and start token. A lock whose owner is gone, or whose pid now belongs to
 * another process (a different start token), is stale and is taken over; a live owner makes this throw `EngineLockedError`.
 */
export async function acquireEngineLock(layout: Layout, processes: Processes, pid: number = process.pid): Promise<EngineLock> {
	const file = join(layout.state, "engine.lock");
	mkdirSync(dirname(file), { recursive: true });
	const mine = (await processes.inspect([pid]))[0]?.startTime ?? null;
	const body = `${JSON.stringify({ pid, startTime: mine })}\n`;
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			writeFileSync(file, body, { flag: "wx" });
			return {
				release() {
					try {
						const held = readJsonFile(file);
						if (isObject(held) && held.pid === pid) rmSync(file, { force: true });
					} catch {
						// the lock is gone or unreadable: nothing of ours to release
					}
				},
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		const owner = readOwner(file);
		if (owner !== null && owner.pid !== pid) {
			const info = (await processes.inspect([owner.pid]))[0];
			const alive = info?.startTime != null && (owner.startTime === null || info.startTime === owner.startTime);
			if (alive) throw new EngineLockedError(`another engine (pid ${owner.pid}) is running for ${layout.root}`);
		}
		rmSync(file, { force: true });
	}
	throw new EngineLockedError(`could not take the engine lock at ${file}`);
}

function readOwner(file: string): { pid: number; startTime: string | null } | null {
	try {
		const value = readJsonFile(file);
		if (isObject(value) && typeof value.pid === "number") return { pid: value.pid, startTime: typeof value.startTime === "string" ? value.startTime : null };
	} catch {
		// an unreadable lock is stale
	}
	return null;
}
