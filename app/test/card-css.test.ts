import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

// R12-F014 and SA-T12-1: the parts of an update or project card are written once, in desk.css beside the card list's frame, and the frame and the card wrap long unbroken text instead of growing past
// the panel. The pictures are the e2e gallery's; this guards the rules.

const dir = join(import.meta.dirname, "..", "src", "renderer");
const files = readdirSync(dir).filter((f) => f.endsWith(".css"));
const css = Object.fromEntries(files.map((f) => [f, readFileSync(join(dir, f), "utf8")]));

describe("the card parts", () => {
	for (const selector of [".update-head", ".update-name", ".update-version", ".update-buttons", ".update-details", ".update-detail"]) {
		it(`${selector} is defined once, in desk.css`, () => {
			const defined = files.filter((f) => (css[f] ?? "").split("\n").some((line) => line.startsWith(`${selector} {`) || line.includes(`] ${selector} {`)));
			assert.deepEqual(defined, ["desk.css"]);
			assert.equal((css["desk.css"] ?? "").split("\n").filter((line) => line.startsWith(`${selector} {`)).length, 1);
		});
	}

	it("keeps each name of a link path in one unbreakable box that is capped at the card's width, so a hyphen is never where it breaks (CIN-F006)", () => {
		const desk = css["desk.css"] ?? "";
		assert.match(desk, /\.path-name \{[^}]*display: inline-block;[^}]*max-width: 100%;[^}]*overflow-wrap: anywhere/);
	});

	it("lets a card and its warning box shrink and wrap, so a long list of paths stays inside the panel (SA-T12-1)", () => {
		const desk = css["desk.css"] ?? "";
		assert.match(desk, /\.accounts \{[^}]*grid-template-columns: minmax\(0, 1fr\)/);
		assert.match(desk, /\.accounts > li \{[^}]*min-width: 0;[^}]*overflow-wrap: anywhere/);
		assert.match(desk, /\.project-card \.finding[^{]*\{[^}]*min-width: 0;[^}]*overflow-wrap: anywhere/);
	});
});
