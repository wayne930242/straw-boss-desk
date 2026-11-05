import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../bootstrap/fsutil.ts";
import type { Layout } from "../paths.ts";

// Keep awake (spec: Decisions, Settings, Computer): a setting, off by default, kept in `state/computer.json`. While it is on, the app asks the OS not to suspend the computer
// (`powerSaveBlocker` `prevent-app-suspension`: the display may still sleep). It becomes "while agents work" once pi-straw-boss exposes that state (seam U3).

export interface PowerBlockerLike {
	start(type: "prevent-app-suspension"): number;
	stop(id: number): void;
	isStarted(id: number): boolean;
}

const file = (layout: Pick<Layout, "state">): string => join(layout.state, "computer.json");

/** The saved setting; off when the file is missing or damaged (a laptop that never sleeps surprises people, so the safe answer is off). */
export function readKeepAwake(layout: Pick<Layout, "state">): boolean {
	try {
		const parsed: unknown = JSON.parse(readFileSync(file(layout), "utf8"));
		return typeof parsed === "object" && parsed !== null && (parsed as { keepAwake?: unknown }).keepAwake === true;
	} catch {
		return false;
	}
}

export class KeepAwake {
	readonly #layout: Pick<Layout, "state">;
	readonly #blocker: PowerBlockerLike;
	#id: number | null = null;

	constructor(layout: Pick<Layout, "state">, blocker: PowerBlockerLike) {
		this.#layout = layout;
		this.#blocker = blocker;
	}

	get on(): boolean {
		return this.#id !== null && this.#blocker.isStarted(this.#id);
	}

	/** Applies the saved setting; called once at launch. */
	apply(): void {
		this.#set(readKeepAwake(this.#layout));
	}

	/** Saves the setting and applies it. The file is written first, so a setting that cannot be saved is not applied. */
	change(on: boolean): void {
		writeFileAtomic(file(this.#layout), `${JSON.stringify({ keepAwake: on })}\n`);
		this.#set(on);
	}

	/** Lets the computer sleep again without changing the saved setting (the app is leaving). */
	release(): void {
		this.#set(false);
	}

	#set(on: boolean): void {
		if (on && !this.on) this.#id = this.#blocker.start("prevent-app-suspension");
		else if (!on && this.#id !== null) {
			if (this.#blocker.isStarted(this.#id)) this.#blocker.stop(this.#id);
			this.#id = null;
		}
	}
}
