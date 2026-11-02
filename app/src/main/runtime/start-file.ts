import { rmSync } from "node:fs";
import { join } from "node:path";
import type { Layout } from "../paths.ts";
import { JsonFileError, readJsonFile, writeFileAtomic } from "../bootstrap/fsutil.ts";

// `state/start.json` (spec: App data layout; Runtime supervisor, Start times). It records what the app started or adopted: the Herdr server and the sb
// server, each with the pid and the start time the app itself read for it. A start time is the only thing that lets the app kill a process it does not
// hold a handle for, so a process without one is never killed, only reported (the desk kill invariant). The file holds no secret: the GUI URL, which
// carries the page token, is never written here.

/** What a reused Herdr server must have been started with. A server started under another config home, agent folder, or root is not ours to reuse. */
export interface Fingerprint {
	desk: true;
	root: string;
	socket: string;
	xdg: string;
	agentDir: string;
}

export const fingerprintOf = (layout: Layout): Fingerprint => ({ desk: true, root: layout.root, socket: layout.herdrSocket, xdg: layout.configHome, agentDir: layout.agent });

export function sameFingerprint(a: Fingerprint | null | undefined, b: Fingerprint): boolean {
	return a != null && a.desk === true && a.root === b.root && a.socket === b.socket && a.xdg === b.xdg && a.agentDir === b.agentDir;
}

export interface ProcessRecord {
	pid: number;
	/** As `Processes.inspect` reads it. Null: not read yet, or not trusted; the process has no kill fallback until it is. */
	startTime: string | null;
}

export interface SbRecord extends ProcessRecord {
	/** `<agent>/straw-boss`, the primary slot's folder (where `server.json` and `gui.json` live). */
	slotDir: string;
}

export interface BaseRecord {
	dir: string;
	workspace: string | null;
	pane: string | null;
	tower: string | null;
	created: boolean | null;
	integration: string | null;
}

export interface StartRecord {
	schema: 1;
	fingerprint: Fingerprint;
	startedAt: string;
	herdr: ProcessRecord | null;
	sb: SbRecord | null;
	base: BaseRecord | null;
	/** Milliseconds from the start to the GUI URL. */
	guiMs: number | null;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown): value is string => typeof value === "string" && value !== "";

function asProcess(value: unknown): ProcessRecord | null {
	if (!isObject(value) || typeof value.pid !== "number" || !Number.isInteger(value.pid) || value.pid <= 0) return null;
	// An empty string is no start time: it never matches anything (the kill check treats it as absent).
	const startTime = typeof value.startTime === "string" && value.startTime !== "" ? value.startTime : null;
	return { pid: value.pid, startTime };
}

function asFingerprint(value: unknown): Fingerprint | null {
	if (!isObject(value) || value.desk !== true || !str(value.root) || !str(value.socket) || !str(value.xdg) || !str(value.agentDir)) return null;
	return { desk: true, root: value.root, socket: value.socket, xdg: value.xdg, agentDir: value.agentDir };
}

function asBase(value: unknown): BaseRecord | null {
	if (!isObject(value) || !str(value.dir)) return null;
	const opt = (v: unknown): string | null => (str(v) ? v : null);
	return { dir: value.dir, workspace: opt(value.workspace), pane: opt(value.pane), tower: opt(value.tower), created: typeof value.created === "boolean" ? value.created : null, integration: opt(value.integration) };
}

/** The record in `value`, or null when it is not one this version wrote (an older kit's `start.json` has other fields and is no record here). */
export function parseStartRecord(value: unknown): StartRecord | null {
	if (!isObject(value) || value.schema !== 1) return null;
	const fingerprint = asFingerprint(value.fingerprint);
	if (fingerprint === null || !str(value.startedAt)) return null;
	const herdr = value.herdr === null || value.herdr === undefined ? null : asProcess(value.herdr);
	if (value.herdr != null && herdr === null) return null;
	let sb: SbRecord | null = null;
	if (value.sb != null) {
		const proc = asProcess(value.sb);
		const slotDir = isObject(value.sb) ? value.sb.slotDir : undefined;
		if (proc === null || !str(slotDir)) return null;
		sb = { ...proc, slotDir };
	}
	return {
		schema: 1,
		fingerprint,
		startedAt: value.startedAt,
		herdr,
		sb,
		base: value.base == null ? null : asBase(value.base),
		guiMs: typeof value.guiMs === "number" ? value.guiMs : null,
	};
}

/**
 * The file, with every change serialized inside this process and written by rename. A change reads the file again first, so a store whose copy went
 * stale never writes it back.
 */
export class StartFile {
	readonly path: string;
	#queue: Promise<unknown> = Promise.resolve();

	constructor(layout: Layout) {
		this.path = join(layout.state, "start.json");
	}

	/** The record on disk now, or null when there is none, or it is not one this version understands (`onUnreadable` says why). */
	read(onUnreadable?: (why: string) => void): StartRecord | null {
		let value;
		try {
			value = readJsonFile(this.path);
		} catch (error) {
			if (!(error instanceof JsonFileError)) throw error;
			onUnreadable?.(error.message);
			return null;
		}
		if (value === null) return null;
		const record = parseStartRecord(value);
		if (record === null) onUnreadable?.(`${this.path} is not a start record this version wrote`);
		return record;
	}

	/** Runs `change` on the record as it is on disk and writes the result: null deletes the file. Returns what was written. */
	update(change: (current: StartRecord | null) => StartRecord | null): Promise<StartRecord | null> {
		const run = this.#queue.then(() => {
			const next = change(this.read());
			if (next === null) rmSync(this.path, { force: true });
			else writeFileAtomic(this.path, `${JSON.stringify(next, null, "\t")}\n`);
			return next;
		});
		this.#queue = run.catch(() => {});
		return run;
	}

	/** Resolves when every change made so far has been written. */
	idle(): Promise<void> {
		return this.#queue.then(() => undefined);
	}
}
