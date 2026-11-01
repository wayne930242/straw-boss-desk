import { createHash, randomBytes } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// File helpers shared by the engine's modules. Every write that another run might read half-done goes through `writeFileAtomic`.

const RENAME_TRIES = 8;
const RETRY_CODES = new Set(["EPERM", "EBUSY", "EACCES", "ENOTEMPTY"]);

const sleepSync = (ms: number): void => {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/** `rename`, retried briefly on the codes Windows gives while antivirus or an indexer still holds a freshly written file. */
export function renameRetry(from: string, to: string): void {
	for (let attempt = 1; ; attempt++) {
		try {
			renameSync(from, to);
			return;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code ?? "";
			if (attempt >= RENAME_TRIES || !RETRY_CODES.has(code)) throw error;
			sleepSync(100 * attempt);
		}
	}
}

/** Writes `text` to a temporary sibling, then renames it over `file`: a reader sees the old file or the new one, never half of it. */
export function writeFileAtomic(file: string, text: string): void {
	mkdirSync(dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
	try {
		writeFileSync(tmp, text, "utf8");
		renameRetry(tmp, file);
	} catch (error) {
		rmSync(tmp, { force: true });
		throw error;
	}
}

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** Raised when a state file exists but is not JSON. The caller decides whether to quarantine it. */
export class JsonFileError extends Error {
	readonly file: string;
	constructor(file: string, cause: unknown) {
		super(`${file} is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`);
		this.name = "JsonFileError";
		this.file = file;
	}
}

/** The parsed JSON file, or null when it does not exist. A file that does not parse throws `JsonFileError`. */
export function readJsonFile(file: string): JsonValue {
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
	try {
		return JSON.parse(text) as JsonValue;
	} catch (error) {
		throw new JsonFileError(file, error);
	}
}

/** Removes a file or folder tree, retrying the way antivirus scanning on Windows needs. Missing is fine. Throws when it cannot. */
export function removeTree(path: string): void {
	rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

/** The two file operations that can fail on Windows while a process still runs the file. A test passes stubs; the engine passes the real ones. */
export interface FsOps {
	removeTree(path: string): void;
	renameRetry(from: string, to: string): void;
}

export const REAL_FS: FsOps = { removeTree, renameRetry };

/** How many `.replaced` names `freeAside` tries before it gives up. */
const ASIDE_TRIES = 50;

/** `<target>.replaced`, or `<target>.replaced-<n>` for the n-th name. `sweepLeftovers` reads both forms. */
export const asideName = (target: string, n: number): string => (n <= 1 ? `${target}.replaced` : `${target}.replaced-${n}`);

/**
 * A free name to move `target` aside to. A `<target>.replaced` that is still there is deleted; when it cannot be (on Windows the old copy of a
 * running `bun.exe` can be renamed but not deleted, T5-F004), it stays and the next name is used, so a held leftover never blocks a later replace.
 * `held` receives each leftover that stayed, for the stage's `fsErrors`.
 */
export function freeAside(target: string, ops: FsOps = REAL_FS, held?: (path: string, error: Error) => void): string {
	for (let n = 1; n <= ASIDE_TRIES; n++) {
		const candidate = asideName(target, n);
		if (!existsSync(candidate)) return candidate;
		try {
			ops.removeTree(candidate);
			return candidate;
		} catch (error) {
			held?.(candidate, error as Error);
		}
	}
	throw new Error(`${target} has ${ASIDE_TRIES} leftover copies that cannot be deleted; stop the programs that run them`);
}

/** Lowercase hex SHA-256 of a file's bytes, streamed. */
export function sha256File(file: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const hash = createHash("sha256");
		const stream = createReadStream(file);
		stream.on("error", reject);
		stream.on("data", (chunk) => hash.update(chunk));
		stream.on("end", () => resolve(hash.digest("hex")));
	});
}

/** A stage name made safe as a file name: `pkg:pi-claude-bridge` becomes `pkg_pi-claude-bridge`. */
export const safeFileName = (name: string): string => name.replace(/[^A-Za-z0-9._-]/g, "_");
