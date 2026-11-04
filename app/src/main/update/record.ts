import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { StackUpdateState } from "../../shared/updates.ts";
import type { Layout } from "../paths.ts";

// `state/update.json`, the stack updater's record. Besides the updater, the wizard's `loadActiveStack` reads it: a bundled stack that was rolled back must not be seeded again.

/** What `state/update.json` keeps: an apply under way (so a quit or a crash in the middle is healed at the next launch), the last outcome the card shows again, and the bundled generation that was rolled back. */
export interface UpdateRecord {
	schema: 1;
	/** `promoted` is set just before the candidate's bytes are written as `active.json`: a cut-short apply that finds it, and `active.json` at this generation, had finished. */
	inFlight?: { generation: number; source: "channel" | "bundled"; at: string; promoted?: true };
	last?: Extract<StackUpdateState, { phase: "applied" | "rolled-back" }>;
	/**
	 * The generation of a bundled `stack.json` whose first-start run did not finish (a stage failed, the stack could not be stopped, or the app was cut short). That file is a shell's one
	 * try (Precedence: it applies at its first start only): neither the wizard nor the next launch takes it up again. A newer shell with a higher generation, or the channel, supersedes it.
	 */
	bundledRolledBack?: number;
}

export const recordFile = (layout: Layout): string => join(layout.state, "update.json");

export function readRecord(file: string): UpdateRecord {
	try {
		const value: unknown = JSON.parse(readFileSync(file, "utf8"));
		if (typeof value === "object" && value !== null && (value as { schema?: unknown }).schema === 1) return value as UpdateRecord;
	} catch {
		// missing or damaged: a fresh record
	}
	return { schema: 1 };
}
