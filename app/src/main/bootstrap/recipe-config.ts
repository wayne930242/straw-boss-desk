import { StackError, optionalToolNames, type Stack } from "./stack.ts";

// What the engine takes from the active recipe (spec: Stages, `gh`, `glab`, `opt:<tool>`; FE2 asks): the forges, which decide the code-host CLIs,
// and the names of the optional tools it turns on. Main validates the recipe file with `validateRecipe(text, recipeValidationOptions(stack))`
// (recipe/validate.mjs) and hands the engine the result through `engineRecipeOf`; the engine checks the names against the stack once more, so a
// name with no stage can never get as far as a missing `opt:<tool>` stage.

export type ForgeKind = "github" | "gitlab";

export interface Forge {
	kind: ForgeKind;
	/** Lowercase host name, with a port when the recipe has one. */
	host: string;
}

export interface EngineRecipe {
	forges: Forge[];
	/** Names under the stack's `optionalTools`, each once, in the order the recipe wrote them. */
	tools: string[];
}

/** The engine's recipe before any recipe is chosen (the welcome screen's preflight; "I have no recipe"): no forges and no optional tools. */
export const NO_RECIPE: EngineRecipe = { forges: [], tools: [] };

/** The options `validateRecipe` needs from the stack: the package names the app installs itself, and the optional tools a recipe may turn on (FE2R-F003). */
export function recipeValidationOptions(stack: Stack): { reservedPackages: string[]; knownTools: string[] } {
	return {
		reservedPackages: [...stack.npmGlobal.map((p) => p.name), stack.profile.name, ...stack.piPackages.map((p) => p.name)],
		knownTools: optionalToolNames(stack),
	};
}

const HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*(?::[0-9]{1,5})?$/;
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The engine's view of a validated recipe (`validateRecipe`'s `recipe`) or of `undefined` when there is none. Throws `StackError` for a tool name the
 * stack does not list, a repeated tool, or a forge that is not `github` or `gitlab` with a plain host: the recipe was validated, but only main knows
 * that, and the stack may have changed since.
 */
export function engineRecipeOf(recipe: unknown, stack: Stack): EngineRecipe {
	if (recipe === undefined || recipe === null) return NO_RECIPE;
	if (!isObject(recipe)) throw new StackError("the recipe is not an object");
	const forges: Forge[] = [];
	for (const [i, forge] of (Array.isArray(recipe.forges) ? recipe.forges : []).entries()) {
		if (!isObject(forge) || (forge.kind !== "github" && forge.kind !== "gitlab") || typeof forge.host !== "string" || !HOST.test(forge.host.toLowerCase())) {
			throw new StackError(`the recipe's forges[${i}] needs a kind of github or gitlab and a plain host name`);
		}
		forges.push({ kind: forge.kind, host: forge.host.toLowerCase() });
	}
	const known = new Set(optionalToolNames(stack));
	const tools: string[] = [];
	for (const [i, name] of (Array.isArray(recipe.tools) ? recipe.tools : []).entries()) {
		if (typeof name !== "string" || !known.has(name)) throw new StackError(`the recipe's tools[${i}] is not a tool this stack can turn on`);
		if (tools.includes(name)) throw new StackError(`the recipe's tools[${i}] (${name}) is listed twice`);
		tools.push(name);
	}
	return { forges, tools };
}
