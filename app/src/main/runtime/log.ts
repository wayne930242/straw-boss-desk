import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Redactor, RotatingFile, loadSecretPatterns, redactValue, tailLines, type LogValue, type RotationOptions } from "../bootstrap/log.ts";

// `logs/start.jsonl`: what the supervisor did at a start, a stop, and a restart, one JSON line each (spec: App data layout). Every value goes through the redactor
// before it is written: the GUI URL's token is masked by the redactor's own rule, and the credential shapes of `recipe/secret-patterns.json` by its patterns. The log takes its
// redactor from the caller and has no default, so it never runs without the patterns (T8A-F007): the tool output it keeps (the sb server's log tail, a CLI's stderr) can carry a token.

/** The redactor of this log: the engine's rules with every pattern of `recipe/secret-patterns.json` (parsed). Throws when the patterns are missing or malformed. */
export const runtimeRedactor = (secretPatterns: unknown): Redactor => new Redactor(loadSecretPatterns(secretPatterns));

export interface RuntimeLogOptions extends RotationOptions {
	/** `<root>/logs`. */
	dir: string;
	redactor: Redactor;
	now?: () => Date;
	/** The file name inside `dir`; `start.jsonl` for the supervisor, `shell.jsonl` for the shell's own events (the code-host sign-ins). */
	file?: string;
}

export class RuntimeLog {
	readonly redactor: Redactor;
	readonly file: RotatingFile;
	readonly #now: () => Date;
	readonly #path: string;
	readonly #keep: number | undefined;

	constructor(options: RuntimeLogOptions) {
		this.redactor = options.redactor;
		this.#now = options.now ?? (() => new Date());
		this.#path = join(options.dir, options.file ?? "start.jsonl");
		this.#keep = options.keep;
		mkdirSync(options.dir, { recursive: true });
		this.file = new RotatingFile(this.#path, {
			...(options.maxBytes !== undefined ? { maxBytes: options.maxBytes } : {}),
			...(options.keep !== undefined ? { keep: options.keep } : {}),
		});
	}

	/** One JSON line: the time, then `fields`. */
	event(fields: Record<string, LogValue>): void {
		const line = redactValue(this.redactor, { t: this.#now().toISOString(), ...fields });
		this.file.append(`${JSON.stringify(line)}\n`);
	}

	/** The last `count` lines, redacted again now. */
	tail(count = 40): string[] {
		return tailLines(this.#path, count, this.#keep).map((l) => this.redactor.redact(l));
	}
}

/** A sink for runtime events; the supervisor's modules take this, so a test passes an array's `push`. */
export type RuntimeEvent = (fields: Record<string, LogValue>) => void;
