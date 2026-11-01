import type { AppPlatform } from "../../paths.ts";
import type { EngineRecipe } from "../recipe-config.ts";
import type { NpmRun } from "../npm.ts";
import { StackError, optionalToolNames, type Stack } from "../stack.ts";
import type { Stage } from "../stage.ts";
import { launchersStage, gitHelpersStage, toolPathsStage } from "./paths-launchers.ts";
import type { EnabledTools } from "./path-files.ts";
import { piShimStage } from "./pi-shim.ts";
import { piStage } from "./pi.ts";
import { preflightStage, type PreflightOptions } from "./preflight.ts";
import { profileStages } from "./profile.ts";
import { fdRgStage, ghStage, gitStage, glabStage, herdrStage, nodeStage, optionalToolStage } from "./tools.ts";

export interface StageOptions {
	/** Test hooks of the preflight (free space, OS release, the reachability limit). */
	preflight?: Omit<PreflightOptions, "platform">;
	/** Extra environment for the `pi` stage's npm (tests point it at a local registry). The product passes none. */
	npm?: NpmRun;
}

/** The CLIs and optional tools the recipe turns on: `gh` for a github forge, `glab` for a gitlab one, and the optional tools it names. */
export function enabledTools(recipe: EngineRecipe): EnabledTools {
	const clis: Array<"gh" | "glab"> = [];
	if (recipe.forges.some((f) => f.kind === "github")) clis.push("gh");
	if (recipe.forges.some((f) => f.kind === "gitlab")) clis.push("glab");
	return { clis, optional: recipe.tools };
}

/**
 * The tool stages of the install, in no particular order (the graph orders them by `needs`): `preflight`, `node`, `git`, `herdr`, `fd-rg`, `gh` and
 * `glab` for the forges the recipe names, `opt:<tool>` for each optional tool it names, then `tool-paths`, `launchers`, and `git-helpers`. A tool the recipe
 * does not name has no stage at all (spec: Stages). Task 6 adds `pi` and, on Windows, `pi-shim`. The profile and package stages that follow `pi`
 * (`profile`, `pi-settings`, `pkg:*`, `team-pkg:*`, `claude`) are `profileStages` (`profile.ts`), and `allStages` joins the two.
 */
export function toolStages(stack: Stack, recipe: EngineRecipe, platform: AppPlatform, options: StageOptions = {}): Stage[] {
	for (const name of recipe.tools) if (!optionalToolNames(stack).includes(name)) throw new StackError(`the recipe names the tool ${name}, which the stack does not list`);
	const enabled = enabledTools(recipe);
	return [
		preflightStage({ platform, ...options.preflight }),
		nodeStage(platform),
		gitStage(platform),
		herdrStage(platform),
		fdRgStage(platform),
		...enabled.clis.map((cli) => (cli === "gh" ? ghStage(platform) : glabStage(platform))),
		...enabled.optional.map((tool) => optionalToolStage(platform, tool)),
		toolPathsStage(platform, enabled),
		launchersStage(platform, enabled, optionalToolNames(stack)),
		gitHelpersStage(platform, recipe.forges),
		piStage(platform, options.npm),
		...(platform === "win32" ? [piShimStage(enabled, optionalToolNames(stack))] : []),
	];
}

/** Every stage this version of the engine runs: the tool stages, then the profile and the packages. */
export const allStages = (stack: Stack, recipe: EngineRecipe, platform: AppPlatform): Stage[] => [...toolStages(stack, recipe, platform), ...profileStages(stack, recipe, platform)];

export { profileStages, type ProfileStageOptions } from "./profile.ts";
