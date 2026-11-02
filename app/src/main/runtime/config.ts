import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Forge } from "../bootstrap/recipe-config.ts";
import type { Layout } from "../paths.ts";

// What a start needs to know that the install does not say: the work folder (the home base is `<work folder>/Straw Boss`), the base's label, and the recipe's
// forge hosts and optional tools (the OS proxy is resolved for each host; bun's folders for a recipe that names it). The wizard (task 9) writes
// `state/wizard.json` and chooses the recipe; until it does, a start uses the defaults and the one recipe file under `recipe/`, if there is exactly one.

export interface StartConfig {
	/** `~/StrawBoss` by default (spec: Decisions, Work folder). */
	workFolder: string;
	/** The label of the home base, and the name of its folder inside the work folder. */
	homeBaseLabel: string;
	forges: Forge[];
	optionalTools: string[];
}

export const HOME_BASE_LABEL = "Straw Boss";

/** The home base's folder: a sibling of the clones, not their parent (spec: Decisions, Home base). */
export const homeBaseDir = (config: StartConfig, join2: (...p: string[]) => string = join): string => join2(config.workFolder, config.homeBaseLabel);

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The JSON object in `file`, or null when the file is missing, does not parse, or holds something else. */
function readJsonObject(file: string): Record<string, unknown> | null {
	try {
		const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
		return isObject(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

/** The recipe the start reads: the only `*.json` under `recipe/`. Null when there is none or more than one (the wizard's choice is not written yet). */
function activeRecipe(layout: Layout): Record<string, unknown> | null {
	let names: string[];
	try {
		names = readdirSync(layout.recipe).filter((n) => n.endsWith(".json"));
	} catch {
		return null;
	}
	if (names.length !== 1) return null;
	return readJsonObject(join(layout.recipe, names[0] as string));
}

export function loadStartConfig(layout: Layout, home: string): StartConfig {
	const wizard = readJsonObject(join(layout.state, "wizard.json"));
	const chosen = typeof wizard?.workFolder === "string" && wizard.workFolder !== "" ? wizard.workFolder : null;
	const recipe = activeRecipe(layout);
	const forges: Forge[] = [];
	for (const f of Array.isArray(recipe?.forges) ? recipe.forges : []) {
		if (isObject(f) && (f.kind === "github" || f.kind === "gitlab") && typeof f.host === "string") forges.push({ kind: f.kind, host: f.host.toLowerCase() });
	}
	const tools = (Array.isArray(recipe?.tools) ? recipe.tools : []).filter((t): t is string => typeof t === "string");
	return { workFolder: chosen ?? join(home, "StrawBoss"), homeBaseLabel: HOME_BASE_LABEL, forges, optionalTools: tools };
}
