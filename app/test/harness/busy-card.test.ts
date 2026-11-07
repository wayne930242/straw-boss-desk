import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { en } from "../../src/renderer/i18n/en.ts";
import { zhTW } from "../../src/renderer/i18n/zh-TW.ts";
import { busySentenceShown } from "./busy-card.ts";

describe("the busy sentences of the Team recipe card", () => {
	for (const [name, catalog] of [["zh-TW", zhTW], ["en", en]] as const) {
		const recipe = catalog.settings.recipe;
		it(`${name}: reads both busy sentences, with the card's other text around them, and nothing else`, () => {
			assert.equal(busySentenceShown(`Team recipe\n${recipe.errorBusy}\nDetails`, recipe), true);
			assert.equal(busySentenceShown(recipe.errorBusyProject.replace("{repository}", "octocat/Hello-World"), recipe), true);
			assert.equal(busySentenceShown(`Team recipe\n${recipe.errorOther}`, recipe), false, "any other error kind fails at once");
			assert.equal(busySentenceShown("", recipe), false);
		});
	}
});
