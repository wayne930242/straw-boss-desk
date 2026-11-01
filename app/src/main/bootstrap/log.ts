import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { safeFileName } from "./fsutil.ts";

// Logs and the redactor (spec: Bootstrap engine, Logs and failures). Every line that reaches a file goes through one `Redactor`: the GUI URL token,
// every pattern of `recipe/secret-patterns.json`, and, by exact match, every secret value main has registered at that moment.

export const REDACTED = "<redacted>";
export const TOKEN = "<token>";
export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
export const DEFAULT_KEEP = 10;
/** A registered value shorter than this would blank ordinary text; registering one is a programming error, not a secret. */
export const MIN_SECRET_LENGTH = 4;
const MAX_PENDING_LINE = 1024 * 1024;

/**
 * `http://127.0.0.1:<port>/<token>`: the pi-straw-boss page URL carries its token as the first path segment. A segment of 16 or more URL-safe
 * characters that ends the URL (a slash, a query, a quote, white space, or the end) counts; a file name such as `node-v24-win-x64.zip` has a dot after it and does not.
 */
const GUI_URL = /((?:127\.0\.0\.1|localhost|\[::1\]):\d{1,5}\/)[A-Za-z0-9_~-]{16,}(?=[/?#"'\s\\]|$)/g;

export interface PatternEntry {
	id: string;
	regex: string;
}

/** The shapes of `recipe/secret-patterns.json` as regular expressions. A missing or malformed file throws: logging never runs without its patterns. */
export function loadSecretPatterns(json: unknown): RegExp[] {
	const list = typeof json === "object" && json !== null ? (json as { patterns?: unknown }).patterns : undefined;
	if (!Array.isArray(list) || list.length === 0) throw new Error("secret-patterns.json has no patterns");
	return list.map((entry: Partial<PatternEntry>) => {
		if (typeof entry.regex !== "string" || entry.regex === "") throw new Error(`secret pattern ${String(entry.id)} has no regex`);
		return new RegExp(entry.regex, "g");
	});
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export class Redactor {
	readonly #patterns: RegExp[];
	readonly #secrets = new Set<string>();
	#exact: RegExp | null = null;

	constructor(patterns: readonly RegExp[]) {
		this.#patterns = patterns.map((p) => (p.global ? p : new RegExp(p.source, `${p.flags}g`)));
	}

	/** Registers a secret value main holds. Its percent-encoded form is registered too, since URLs carry it that way. */
	add(value: string): void {
		if (value.length < MIN_SECRET_LENGTH) throw new Error(`a secret to redact must be at least ${MIN_SECRET_LENGTH} characters`);
		this.#secrets.add(value);
		const encoded = encodeURIComponent(value);
		if (encoded !== value && encoded.length >= MIN_SECRET_LENGTH) this.#secrets.add(encoded);
		this.#exact = null;
	}

	remove(value: string): void {
		this.#secrets.delete(value);
		this.#secrets.delete(encodeURIComponent(value));
		this.#exact = null;
	}

	get size(): number {
		return this.#secrets.size;
	}

	#exactPattern(): RegExp | null {
		if (this.#secrets.size === 0) return null;
		// Longest first, so a secret that contains another registered one is replaced whole.
		this.#exact ??= new RegExp([...this.#secrets].sort((a, b) => b.length - a.length).map(escapeRegExp).join("|"), "g");
		return this.#exact;
	}

	redact(text: string): string {
		let out = text;
		const exact = this.#exactPattern();
		if (exact) out = out.replace(exact, REDACTED);
		out = out.replace(GUI_URL, `$1${TOKEN}`);
		for (const pattern of this.#patterns) out = out.replace(pattern, REDACTED);
		return out;
	}
}

export type LogValue = string | number | boolean | null | undefined | LogValue[] | { [key: string]: LogValue };

/** Redacts every string of a value, and every key, before it is serialized: a secret with a quote or a backslash in it would not match once JSON-escaped. */
function redactValue(redactor: Redactor, value: LogValue): LogValue {
	if (typeof value === "string") return redactor.redact(value);
	if (Array.isArray(value)) return value.map((v) => redactValue(redactor, v));
	if (value !== null && typeof value === "object") {
		const out: Record<string, LogValue> = {};
		for (const [key, v] of Object.entries(value)) out[redactor.redact(key)] = redactValue(redactor, v);
		return out;
	}
	return value;
}

export interface RotationOptions {
	/** Rotate when appending would pass this size (default 5 MB). */
	maxBytes?: number;
	/** Files kept per log, the live one included (default 10). */
	keep?: number;
}

/** An append-only text file that rotates at a size: `x.jsonl` becomes `x.jsonl.1`, that `x.jsonl.2`, and the file past `keep` is deleted. */
export class RotatingFile {
	readonly file: string;
	readonly #maxBytes: number;
	readonly #keep: number;
	#size: number | null = null;

	constructor(file: string, options: RotationOptions = {}) {
		this.file = file;
		this.#maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
		this.#keep = Math.max(1, options.keep ?? DEFAULT_KEEP);
	}

	append(text: string): void {
		const bytes = Buffer.byteLength(text, "utf8");
		this.#size ??= this.#currentSize();
		if (this.#size > 0 && this.#size + bytes > this.#maxBytes) {
			this.#rotate();
			this.#size = 0;
		}
		appendFileSync(this.file, text, "utf8");
		this.#size += bytes;
	}

	#currentSize(): number {
		try {
			return statSync(this.file).size;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
			throw error;
		}
	}

	#rotate(): void {
		rmSync(`${this.file}.${this.#keep - 1}`, { force: true });
		for (let i = this.#keep - 2; i >= 1; i--) {
			try {
				renameSync(`${this.file}.${i}`, `${this.file}.${i + 1}`);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
		}
		if (this.#keep > 1) renameSync(this.file, `${this.file}.1`);
		else rmSync(this.file, { force: true });
	}
}

/** The raw output of one stage's tools, `logs/stage-<name>.log`, redacted a line at a time so a secret split across two chunks is still caught. */
export class StageLog {
	readonly #redactor: Redactor;
	readonly #file: RotatingFile;
	readonly #events: (fields: Record<string, LogValue>) => void;
	#pending = "";

	constructor(redactor: Redactor, file: RotatingFile, events: (fields: Record<string, LogValue>) => void) {
		this.#redactor = redactor;
		this.#file = file;
		this.#events = events;
	}

	/** A structured line in `bootstrap.jsonl`. */
	event(fields: Record<string, LogValue>): void {
		this.#events(fields);
	}

	/** Raw tool output, in chunks as it arrives. */
	raw(chunk: string): void {
		this.#pending += chunk;
		let newline = this.#pending.indexOf("\n");
		while (newline !== -1) {
			this.#file.append(`${this.#redactor.redact(this.#pending.slice(0, newline))}\n`);
			this.#pending = this.#pending.slice(newline + 1);
			newline = this.#pending.indexOf("\n");
		}
		if (this.#pending.length > MAX_PENDING_LINE) this.flush();
	}

	/** Writes out a last line that had no newline. */
	flush(): void {
		if (this.#pending === "") return;
		this.#file.append(`${this.#redactor.redact(this.#pending)}\n`);
		this.#pending = "";
	}
}

export interface LoggerOptions extends RotationOptions {
	/** `<root>/logs`. */
	dir: string;
	redactor: Redactor;
	now?: () => Date;
}

/** `logs/bootstrap.jsonl` and the per-stage logs of one engine. */
export class Logger {
	readonly redactor: Redactor;
	readonly #dir: string;
	readonly #options: RotationOptions;
	readonly #now: () => Date;
	readonly #bootstrap: RotatingFile;
	readonly #stages = new Map<string, StageLog>();

	constructor(options: LoggerOptions) {
		this.redactor = options.redactor;
		this.#dir = options.dir;
		this.#now = options.now ?? (() => new Date());
		this.#options = { ...(options.maxBytes !== undefined ? { maxBytes: options.maxBytes } : {}), ...(options.keep !== undefined ? { keep: options.keep } : {}) };
		mkdirSync(options.dir, { recursive: true });
		this.#bootstrap = new RotatingFile(join(options.dir, "bootstrap.jsonl"), this.#options);
	}

	/** One JSON line in `bootstrap.jsonl`: the time, then `fields`. */
	event(fields: Record<string, LogValue>): void {
		const line = redactValue(this.redactor, { t: this.#now().toISOString(), ...fields });
		this.#bootstrap.append(`${JSON.stringify(line)}\n`);
	}

	/** The log of one stage; the same object on every call for a name. */
	stage(name: string): StageLog {
		let log = this.#stages.get(name);
		if (log === undefined) {
			log = new StageLog(
				this.redactor,
				new RotatingFile(join(this.#dir, `stage-${safeFileName(name)}.log`), this.#options),
				(fields) => this.event({ stage: name, ...fields }),
			);
			this.#stages.set(name, log);
		}
		return log;
	}

	flush(): void {
		for (const log of this.#stages.values()) log.flush();
	}

	/** The last `count` lines of `bootstrap.jsonl`, across rotated files, redacted again now (**Details**, spec: Logs and failures). */
	tail(count = 40): string[] {
		return tailLines(join(this.#dir, "bootstrap.jsonl"), count, this.#options.keep ?? DEFAULT_KEEP).map((l) => this.redactor.redact(l));
	}
}

/** The last `count` non-empty lines of a rotating log, oldest first. */
export function tailLines(file: string, count: number, keep = DEFAULT_KEEP): string[] {
	const lines: string[] = [];
	for (let i = 0; i < keep && lines.length < count; i++) {
		let text: string;
		try {
			text = readFileSync(i === 0 ? file : `${file}.${i}`, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw error;
		}
		const part = text.split("\n").filter((l) => l !== "");
		lines.unshift(...part.slice(-(count - lines.length)));
	}
	return lines.slice(-count);
}
