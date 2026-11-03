import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../bootstrap/fsutil.ts";
import { parseStack, type Stack } from "../bootstrap/stack.ts";
import type { Layout } from "../paths.ts";

// Which `stack.json` the engine installs from (spec: Updater, Precedence). The app carries one (`dist/assets/stack.json`, copied by `scripts/copy-assets.ts`); `stack/active.json` is the one in
// force. The active stack is the verified one with the highest `generation`: the bundled file replaces the active one only when its generation is higher, so a downloaded stack (task 13) is
// never lowered by an older shell. The signature check of a downloaded candidate is task 13's; the bundled file is part of the signed app.

export interface ActiveStack {
	stack: Stack;
	/** The parsed JSON the engine takes (`EngineConfig.stack`). */
	raw: unknown;
	/** True when the bundled file replaced the active one in this call. */
	seeded: boolean;
}

function readStackFile(file: string): { raw: unknown; stack: Stack } | null {
	if (!existsSync(file)) return null;
	const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
	return { raw, stack: parseStack(raw) };
}

/** Reads the bundled and the active stack, keeps the one with the higher generation as `stack/active.json`, and returns it. Throws when the bundled file is missing or unusable. */
export function loadActiveStack(layout: Layout, bundledFile: string): ActiveStack {
	const bundled = readStackFile(bundledFile);
	if (bundled === null) throw new Error(`the bundled stack.json is missing: ${bundledFile}`);
	const activeFile = join(layout.stack, "active.json");
	let active: { raw: unknown; stack: Stack } | null = null;
	try {
		active = readStackFile(activeFile);
	} catch {
		active = null; // damaged: the bundled file takes its place
	}
	if (active !== null && active.stack.generation >= bundled.stack.generation) return { ...active, seeded: false };
	writeFileAtomic(activeFile, `${JSON.stringify(bundled.raw, null, "\t")}\n`);
	return { ...bundled, seeded: true };
}
