import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { safeFileName } from "./fsutil.ts";

// Logs and the redactor (spec: Bootstrap engine, Logs and failures). Every line that reaches a file goes through one `Redactor`: the GUI URL token,
// every pattern of `recipe/secret-patterns.json`, the userinfo of any `scheme://user:password@host` URL, and, by exact match, every secret value main has
// registered at that moment.

export const REDACTED = "<redacted>";
export const TOKEN = "<token>";
export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
export const DEFAULT_KEEP = 10;
/** A registered value shorter than this would blank ordinary text; registering one is a programming error, not a secret. */
export const MIN_SECRET_LENGTH = 4;
const MAX_PENDING_LINE = 1024 * 1024;
/** A PEM block that never closes drops at most this many lines after its BEGIN line, so a stray marker cannot swallow the rest of a stage's output (R4-F001). */
export const MAX_PEM_LINES = 64;

/**
 * `http://127.0.0.1:<port>/<token>`: the pi-straw-boss page URL carries its token as the first path segment. A segment of 16 or more URL-safe
 * characters counts when whatever follows it is not part of a name: anything but a URL-safe character, and not a dot with a letter or digit after it.
 * So `<token>.`, `<token>)`, `<token>,`, `<token>>`, `<token>&x`, `<token>;`, and a quote all end it, while a file name such as `node-v24-win-x64.zip`
 * has `.zip` after it and does not.
 */
const GUI_URL = /((?:127\.0\.0\.1|localhost|\[::1\]):\d{1,5}\/)[A-Za-z0-9_~-]{16,}(?![A-Za-z0-9_~-]|\.[A-Za-z0-9])/g;

/**
 * `scheme://user:password@host`: the userinfo of a URL, as a company proxy variable carries it (`HTTPS_PROXY=http://user:pass@proxy:8080`, which reaches
 * every child the engine starts, T6-F011). The user and the password are masked; the scheme and the host stay. The user has no colon, the password may hold
 * anything up to the last `@` before the next slash, a space, a double quote, or `<>`: those four never appear raw in a valid URL, while a single quote may
 * (R6-F003). A URL with a user and no password (`ssh://git@host`) is left alone. A match starts only right after `://` with a scheme character before it, so
 * whatever comes before (`git+https`, `x.http`, a scheme of any length) stays as it is, and a long run such as `a.a.a…` is never rescanned from each dot
 * (R6-F001, R6C-F001). A compact single-quoted list such as `['http://h:8080','a@b.c']` is masked up to the later `@`: too much, never too little (R6C-F002).
 */
const URL_USERINFO = /(?<=[A-Za-z0-9+.-]:\/\/)[^/\s:@"<>]+:[^/\s"<>]*@/g;

/** A PEM block, `-----BEGIN <label>-----` to the matching `-----END <label>-----` (to the end of the text when there is none), whatever its label. */
const PEM_BLOCK = /-----BEGIN ([A-Z0-9 ]+)-----[\s\S]*?(?:-----END \1-----|$)/g;
const PEM_BEGIN = /-----BEGIN [A-Z0-9 ]+-----/;
const PEM_END = /-----END [A-Z0-9 ]+-----/;

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

/** Raised when main registers a value that is too short to be a secret; named, so the engine reports it instead of crashing on it. */
export class SecretRefusedError extends Error {
	constructor(length: number) {
		super(`a secret to redact must be at least ${MIN_SECRET_LENGTH} characters (this one has ${length})`);
		this.name = "SecretRefusedError";
	}
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
		if (value.length < MIN_SECRET_LENGTH) throw new SecretRefusedError(value.length);
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
		let out = text.replace(PEM_BLOCK, REDACTED);
		const exact = this.#exactPattern();
		if (exact) out = out.replace(exact, REDACTED);
		out = out.replace(GUI_URL, `$1${TOKEN}`);
		out = out.replace(URL_USERINFO, `${REDACTED}@`);
		for (const pattern of this.#patterns) out = out.replace(pattern, REDACTED);
		return out;
	}
}

export type LogValue = string | number | boolean | null | undefined | LogValue[] | { [key: string]: LogValue };

/** Redacts every string of a value, and every key, before it is serialized: a secret with a quote or a backslash in it would not match once JSON-escaped. */
export function redactValue(redactor: Redactor, value: LogValue): LogValue {
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
	/** True between the line that opens a PEM block and the line that closes it: the lines in between are never written. */
	#inBlock = false;
	/** Lines dropped since the BEGIN line of the open block. */
	#dropped = 0;

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
			this.#line(this.#pending.slice(0, newline));
			this.#pending = this.#pending.slice(newline + 1);
			newline = this.#pending.indexOf("\n");
		}
		if (this.#pending.length > MAX_PENDING_LINE) this.#flushPending();
	}

	/** Writes out a last line that had no newline, and ends a PEM block that never closed: the next output starts clean. */
	flush(): void {
		this.#flushPending();
		this.#inBlock = false;
		this.#dropped = 0;
	}

	#flushPending(): void {
		if (this.#pending === "") return;
		this.#line(this.#pending);
		this.#pending = "";
	}

	/**
	 * One line of output. A PEM block spans lines, which a per-line redactor cannot see whole: the line that opens it is written with everything from
	 * `-----BEGIN` on masked, and the lines up to the closing `-----END` are dropped. The dropping ends at the END marker or after `MAX_PEM_LINES`
	 * lines, whichever comes first, and any text after the END marker on its line is kept (R4-F001).
	 */
	#line(line: string): void {
		if (this.#inBlock) {
			const end = PEM_END.exec(line);
			if (end !== null) {
				this.#inBlock = false;
				this.#dropped = 0;
				const rest = line.slice(end.index + end[0].length);
				if (rest.trim() !== "") this.#line(rest);
				return;
			}
			if (++this.#dropped >= MAX_PEM_LINES) {
				this.#inBlock = false;
				this.#dropped = 0;
			}
			return;
		}
		const begin = PEM_BEGIN.exec(line);
		if (begin !== null && !PEM_END.test(line.slice(begin.index + begin[0].length))) {
			this.#inBlock = true;
			this.#dropped = 0;
		}
		this.#file.append(`${this.#redactor.redact(line)}\n`);
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
