import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { catalogs } from "../src/renderer/i18n/index.ts";
import { START_FAILURE_KINDS } from "../src/main/runtime/failure.ts";

// The runtime page (screen.html, screen.ts) has no DOM in a node test, so these checks read the two files and the catalog: every element the script looks up is in the page, the page
// is as strict as the welcome page, and every banner and failure kind has words in both languages.
const renderer = join(import.meta.dirname, "..", "src", "renderer");
const html = readFileSync(join(renderer, "screen.html"), "utf8");
const script = readFileSync(join(renderer, "screen.ts"), "utf8");

describe("the runtime page", () => {
	it("has every element screen.ts looks up by id", () => {
		const wanted = [...script.matchAll(/byId<[A-Za-z]+>\("([a-z-]+)"\)/g)].map((m) => m[1] ?? "");
		assert.ok(wanted.length >= 8, wanted.join(","));
		for (const id of wanted) assert.match(html, new RegExp(`id="${id}"`), id);
	});

	it("loads only its own script and style, under the welcome page's strict CSP", () => {
		assert.match(html, /default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'/);
		assert.deepEqual([...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]).sort(), ["screen.css", "screen.js"]);
		assert.doesNotMatch(html, /<script(?![^>]*src=)/, "no inline script");
		assert.doesNotMatch(html, /\son[a-z]+=/, "no inline handler");
	});

	it("words every banner kind, both screens and the starting note in both languages", () => {
		for (const locale of ["en", "zh-TW"] as const) {
			const c = catalogs[locale];
			for (const key of ["restarting", "addressChanged", "starting"] as const) assert.ok(c.banner[key].length > 0, `${locale} banner.${key}`);
			for (const screen of ["guiStopped", "serverStopped"] as const) assert.ok(c.screen[screen].title.length > 0 && c.screen[screen].body.length > 0, `${locale} screen.${screen}`);
			assert.ok(c.screen.start.length > 0 && c.screen.starting.length > 0);
		}
	});

	it("maps each banner kind the follower can send to a catalog key", () => {
		for (const kind of ["restarting", "address-changed", "starting"]) assert.match(script, new RegExp(`"?${kind}"?: "banner\\.`), kind);
	});

	it("has a sentence for the failure kinds the budgets and the window add", () => {
		for (const kind of ["restart-budget", "renderer", "sb-unverified"]) {
			assert.ok(START_FAILURE_KINDS.includes(kind as never), kind);
			for (const locale of ["en", "zh-TW"] as const) assert.ok((catalogs[locale].start.failure as Record<string, string>)[kind], `${locale} ${kind}`);
		}
	});
});
