import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../bootstrap/fsutil.ts";
import type { Layout } from "../paths.ts";
import type { RecipeSource } from "../../shared/recipe-update.ts";

// `state/recipe.json`: what the Team recipe card remembers between launches: where the active recipe came from, when the last check finished, and the version the PM kept out (so a day's check does
// not offer it again). No secret.

export interface RecipeMemo {
	schema: 1;
	source: RecipeSource | null;
	checkedAt: string | null;
	kept: { id: string; version: string } | null;
}

export const EMPTY_MEMO: RecipeMemo = { schema: 1, source: null, checkedAt: null, kept: null };

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown): value is string => typeof value === "string" && value !== "";

export class RecipeMemoStore {
	readonly #dir: string;
	readonly #file: string;

	constructor(layout: Pick<Layout, "state">) {
		this.#dir = layout.state;
		this.#file = join(layout.state, "recipe.json");
	}

	read(): RecipeMemo {
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(this.#file, "utf8"));
		} catch {
			return { ...EMPTY_MEMO };
		}
		if (!isObject(parsed) || parsed.schema !== 1) return { ...EMPTY_MEMO };
		const s = parsed.source;
		const source: RecipeSource | null = isObject(s) && s.kind === "file" && str(s.fileName) ? { kind: "file", fileName: s.fileName } : isObject(s) && s.kind === "url" && str(s.host) ? { kind: "url", host: s.host } : null;
		const k = parsed.kept;
		return { schema: 1, source, checkedAt: str(parsed.checkedAt) ? parsed.checkedAt : null, kept: isObject(k) && str(k.id) && str(k.version) ? { id: k.id, version: k.version } : null };
	}

	write(memo: RecipeMemo): void {
		mkdirSync(this.#dir, { recursive: true });
		writeFileAtomic(this.#file, `${JSON.stringify(memo, null, 2)}\n`);
	}

	update(change: Partial<Omit<RecipeMemo, "schema">>): RecipeMemo {
		const next = { ...this.read(), ...change };
		this.write(next);
		return next;
	}
}
