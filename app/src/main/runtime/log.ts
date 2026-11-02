import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Redactor, RotatingFile, redactValue, tailLines, type LogValue, type RotationOptions } from "../bootstrap/log.ts";

// `logs/start.jsonl`: what the supervisor did at a start, a stop, and a restart, one JSON line each (spec: App data layout). Every value goes through the redactor
// before it is written, and the GUI URL's token is masked by the redactor's own rule, so no line can hold the page token.

export interface RuntimeLogOptions extends RotationOptions {
	/** `<root>/logs`. */
	dir: string;
	redactor?: Redactor;
	now?: () => Date;
}

export class RuntimeLog {
	readonly redactor: Redactor;
	readonly file: RotatingFile;
	readonly #now: () => Date;
	readonly #path: string;
	readonly #keep: number | undefined;

	constructor(options: RuntimeLogOptions) {
		this.redactor = options.redactor ?? new Redactor([]);
		this.#now = options.now ?? (() => new Date());
		this.#path = join(options.dir, "start.jsonl");
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
