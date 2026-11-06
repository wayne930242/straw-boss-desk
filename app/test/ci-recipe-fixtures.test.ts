import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { validateRecipe } from "../../recipe/validate.mjs";
import { recipeValidationOptions } from "../src/main/bootstrap/recipe-config.ts";
import { parseStack } from "../src/main/bootstrap/stack.ts";
import { recipeChanges } from "../src/main/recipe/diff.ts";
import { compareVersions } from "../src/main/update/verify.ts";

// The fixtures of the Team recipe checks that read their update over the internet (task 15, `wizard.e2e.ts`): the repository's own file is the update server, so the file has to be what the
// check expects before a runner reads it.
const read = (name: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
const stack = parseStack(JSON.parse(readFileSync(new URL("../../stack.json", import.meta.url), "utf8")) as unknown);
const valid = (name: string) => {
	const result = validateRecipe(read(name), recipeValidationOptions(stack));
	assert.ok(result.ok, JSON.stringify(result));
	return result.recipe;
};
const MAIN_URL = "https://raw.githubusercontent.com/wayne930242/straw-boss-desk/main/app/test/fixtures/ci-update.strawboss.json";

describe("the raw-URL update fixture", () => {
	const ci = valid("ci.strawboss.json");
	const update = valid("ci-update.strawboss.json");

	it("is a valid recipe for the same team as the CI recipe, at a higher version, and names its own address on main", () => {
		assert.equal(update.id, ci.id);
		assert.ok(compareVersions(update.version, ci.version) > 0);
		assert.equal(update.updateUrl, MAIN_URL);
	});

	it("is above the version the check starts from (the local fixture's 1.2.0 and the file the test chooses, 1.3.0), so the check offers it", () => {
		assert.ok(compareVersions(update.version, "1.3.0") > 0);
	});

	it("differs from the active recipe the test has by the version and the instructions only (the change list the test asserts)", () => {
		const local = { ...ci, version: "1.3.0", updateUrl: MAIN_URL, repos: [...(ci.repos ?? []), { url: "https://github.com/octocat/Spoon-Knife.git", folder: "spoon-knife", label: "Spoon Knife" }] };
		assert.deepEqual(recipeChanges(local, update, () => null).map((c) => c.kind), ["version", "instructions"]);
	});
});
