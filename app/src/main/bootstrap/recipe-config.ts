import type { TeamRecipe } from "../profile/team-profile.ts";
import { StackError, isPackageName, optionalToolNames, type NpmPin, type Stack } from "./stack.ts";

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

/** What the profile stages read of a validated recipe (spec: Stages `profile`, `team-pkg:<name>`): the installer's input, the extra packages, and a profile pin. */
export interface EngineTeam extends TeamRecipe {
	/** Extra pi packages the team adds, installed skills-only. */
	packages: NpmPin[];
	/** Pins the official profile package to another version than `stack.json`'s (the package name stays the stack's). */
	profile?: { version: string; integrity: string };
}

export interface EngineRecipe {
	forges: Forge[];
	/** Names under the stack's `optionalTools`, each once, in the order the recipe wrote them. */
	tools: string[];
	/** Absent before a recipe is chosen, and for a caller that only needs the forges and tools. */
	team?: EngineTeam;
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
	const team = teamOf(recipe);
	return team === undefined ? { forges, tools } : { forges, tools, team };
}

const EXACT = /^\d+\.\d+\.\d+(?:[.-][0-9A-Za-z.-]+)?$/;
const SRI = /^sha512-[A-Za-z0-9+/]{86}==$/;
const str = (value: unknown): value is string => typeof value === "string" && value !== "";

/** The team part of a validated recipe, or undefined when it has no `id` (a caller that passes forges and tools only). Throws `StackError` for a field of the wrong shape. */
function teamOf(recipe: Record<string, unknown>): EngineTeam | undefined {
	if (recipe.id === undefined) return undefined;
	if (!str(recipe.id) || !str(recipe.name) || !str(recipe.version)) throw new StackError("the recipe needs an id, a name, and a version");
	const team: EngineTeam = { id: recipe.id, name: recipe.name, version: recipe.version, packages: [] };
	if (recipe.instructions !== undefined) {
		if (typeof recipe.instructions !== "string") throw new StackError("the recipe's instructions must be text");
		if (recipe.instructions !== "") team.instructions = recipe.instructions;
	}
	if (recipe.straw !== undefined) {
		if (!isObject(recipe.straw) || (recipe.straw.relay !== undefined && !str(recipe.straw.relay))) throw new StackError("the recipe's straw.relay must be a URL");
		if (recipe.straw.relay !== undefined) team.straw = { relay: recipe.straw.relay as string };
	}
	if (recipe.profile !== undefined) {
		const p = recipe.profile;
		if (!isObject(p) || !str(p.version) || !EXACT.test(p.version) || !str(p.integrity) || !SRI.test(p.integrity)) throw new StackError("the recipe's profile needs an exact version and a sha512 integrity");
		team.profile = { version: p.version, integrity: p.integrity };
	}
	for (const [i, pkg] of (Array.isArray(recipe.packages) ? recipe.packages : []).entries()) {
		// The name reaches the arguments of npm and pi: the recipe schema checks it, but only main knows the recipe was validated (T7-F009).
		if (isObject(pkg) && !isPackageName(pkg.name)) throw new StackError(`the recipe's packages[${i}] needs an npm package name (lowercase, no leading dash)`);
		if (!isObject(pkg) || !str(pkg.name) || !str(pkg.version) || !EXACT.test(pkg.version) || !str(pkg.integrity) || !SRI.test(pkg.integrity)) {
			throw new StackError(`the recipe's packages[${i}] needs a name, an exact version, and a sha512 integrity`);
		}
		if (team.packages.some((p) => p.name === pkg.name)) throw new StackError(`the recipe's packages[${i}] (${pkg.name}) is listed twice`);
		team.packages.push({ name: pkg.name, version: pkg.version, integrity: pkg.integrity });
	}
	return team;
}
