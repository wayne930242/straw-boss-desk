import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { appRoot } from "./harness/packaged.ts";

// What the e2e files of task 14 must keep asserting, read as text because they run on the CI runners only (SBD_E2E=1, a packaged build): the anchor's 30 s, and the whole-page shots.
const source = (name: string): string => readFileSync(join(appRoot, "test", "e2e", name), "utf8").replace(/\/\/[^\n]*/g, "");

describe("the task 14 e2e files", () => {
	it("the removal e2e asserts that the root is gone within 30 s of the exit, as the anchor says, and keeps no 60 s allowance or PowerShell listing (T14-F002)", () => {
		const text = source("removal.e2e.ts");
		const test = /it\("deletes the root within 30 s of the app's exit[^]*?\n\t\}\);/.exec(text)?.[0] ?? "";
		assert.ok(test.length > 0, "the test exists");
		assert.match(test, /Date\.now\(\) - started < 30_000/);
		assert.match(test, /assert\.equal\(existsSync\(world\.root\), false/);
		assert.doesNotMatch(test, /60_000(?![^]*closed)/, "no 60 s allowance after the exit");
		assert.doesNotMatch(test, /listUnder|WindowsPowerShell|timeline/);
	});

	it("the settings e2e files shoot the whole page with shotWhole, never fullPage alone, which leaves out what scrolls inside the panel (T14-F010)", () => {
		for (const name of ["gallery-computer.e2e.ts", "removal.e2e.ts", "diagnostics.e2e.ts"]) {
			const text = source(name);
			assert.match(text, /shotWhole\(/, `${name} uses shotWhole`);
			assert.doesNotMatch(text, /page\.screenshot\(/, `${name} takes no page screenshot of its own`);
		}
		const helper = readFileSync(join(appRoot, "test", "harness", "shot-whole.ts"), "utf8");
		assert.match(helper, /\.body, \.nav \{ overflow: visible !important/);
		assert.match(helper, /fullPage: true/);
	});

	it("the gallery has the states of this round: the app's entry beside a foreign one, the busy refusal, a result whose only problem is the files step", () => {
		const text = source("gallery-computer.e2e.ts");
		for (const needle of ['"confirm-beside"', '"done-beside"', '["busy"', '"done-problems-files"', 'why: "beside"']) assert.ok(text.includes(needle), needle);
	});
});
