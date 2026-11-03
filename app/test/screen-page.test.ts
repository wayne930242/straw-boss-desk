import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { catalogs } from "../src/renderer/i18n/index.ts";
import { START_FAILURE_KINDS } from "../src/main/runtime/failure.ts";
import { primaryAction, REPAIR_NAMED_KINDS, showsRepair } from "../src/shared/failure-action.ts";

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
		assert.deepEqual([...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]).sort(), ["desk-tokens.css", "desk.css", "screen.css", "screen.js"]);
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

	it("draws its first state in the language main holds now, not the one the window opened with (T9-F003)", () => {
		assert.match(script, /import \{ currentLocale/);
		assert.match(script, /Promise\.all\(\[currentLocale\(shell\), shell\.state\(\)\]\)/);
		assert.doesNotMatch(script, /void shell\.state\(\)\.then\(render\)/);
	});

	it("has a sentence for the failure kinds the budgets and the window add", () => {
		for (const kind of ["restart-budget", "renderer", "sb-unverified"]) {
			assert.ok(START_FAILURE_KINDS.includes(kind as never), kind);
			for (const locale of ["en", "zh-TW"] as const) assert.ok((catalogs[locale].start.failure as Record<string, string>)[kind], `${locale} ${kind}`);
		}
	});
});

describe("the primary button of a failure (SA-10)", () => {
	const kinds = Object.keys(catalogs.en.start.failure);

	it("lists exactly the kinds whose sentence says to run Repair, in both languages", () => {
		const en = kinds.filter((k) => /\bRun Repair\b/.test((catalogs.en.start.failure as Record<string, string>)[k] ?? ""));
		const zh = kinds.filter((k) => /執行「修復」/.test((catalogs["zh-TW"].start.failure as Record<string, string>)[k] ?? ""));
		assert.deepEqual([...REPAIR_NAMED_KINDS].sort(), en.sort(), "the English sentences");
		assert.deepEqual([...REPAIR_NAMED_KINDS].sort(), zh.sort(), "the zh-TW sentences");
	});

	it("makes Repair the primary button where the sentence names it, and Try again everywhere else", () => {
		for (const kind of REPAIR_NAMED_KINDS) assert.equal(primaryAction({ kind, offerRepair: true }), "repair", kind);
		for (const kind of kinds.filter((k) => !REPAIR_NAMED_KINDS.includes(k))) assert.equal(primaryAction({ kind, offerRepair: kind === "repair-failed" }), "retry", kind);
	});

	it("shows the Repair button a sentence names, even where the failure did not set offerRepair", () => {
		assert.equal(showsRepair({ kind: "loader" }), true);
		assert.equal(showsRepair({ kind: "network" }), false);
		assert.equal(showsRepair({ kind: "repair-failed", offerRepair: true }), true);
	});

	it("is applied by the runtime page and by the wizard's start step, and the stopped-screens' Start is primary", () => {
		assert.match(script, /primaryAction\(failure\) === "repair"/);
		assert.match(script, /retry\.classList\.toggle\("primary", !repairFirst\)/);
		assert.match(script, /delete card\.dataset\.failureKind;\n\tretry\.classList\.add\("primary"\)/);
		const start = readFileSync(join(renderer, "wizard", "start.ts"), "utf8");
		assert.match(start, /primaryAction\(failure\) === "retry" \? "primary" : null/);
		assert.match(start, /primaryAction\(failure\) === "repair" \? "primary" : null/);
	});
});

