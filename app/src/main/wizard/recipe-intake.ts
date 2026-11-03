import { createHash } from "node:crypto";
import { basename } from "node:path";
import type { Recipe, RecipeResult } from "../../../../recipe/validate.d.mts";
import { recipeValidationOptions } from "../bootstrap/recipe-config.ts";
import type { Stack } from "../bootstrap/stack.ts";
import type { RecipeRefusal } from "../../shared/wizard.ts";

// A recipe file enters the app here (spec: First run, step 2). `recipe/validate.mjs` judges the file's text, with the package names the app installs itself and the optional tools
// `stack.json` lists; a refusal names the field and the rule, never the value. The text is kept as it came: the trust screen shows the SHA256 of those bytes, and the accepted file is
// copied as it is (team-profile section 5, Delivery). Nothing is written here.

export type ValidateRecipe = (input: unknown, options: { reservedPackages: Iterable<string>; knownTools?: Iterable<string> }) => RecipeResult;

export type Intake = { ok: true; recipe: Recipe; text: string; sha256: string; fileName: string } | { ok: false; refused: RecipeRefusal[] };

/** The file name a recipe came with, cut to a short plain name: a path's folders, control characters and anything past 120 characters are dropped. */
export function plainFileName(name: string): string {
	// eslint-disable-next-line no-control-regex
	const cleaned = basename(name.replaceAll("\\", "/")).replace(/[\u0000-\u001f\u007f]/g, "").trim();
	return cleaned.slice(0, 120) || "recipe.strawboss.json";
}

export function intakeRecipe(validate: ValidateRecipe, stack: Stack, fileName: string, text: string): Intake {
	const result = validate(text, recipeValidationOptions(stack));
	if (!result.ok) return { ok: false, refused: result.errors.map((e) => ({ field: e.field, rule: e.rule })) };
	return { ok: true, recipe: result.recipe, text, sha256: createHash("sha256").update(text, "utf8").digest("hex"), fileName: plainFileName(fileName) };
}
