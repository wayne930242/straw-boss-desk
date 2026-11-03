import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { en } from "../src/renderer/i18n/en.ts";
import { catalogs, t } from "../src/renderer/i18n/index.ts";
import { zhTW } from "../src/renderer/i18n/zh-TW.ts";
import { flattenKeys, oneSidedBorders, placeholders, readText, reducedMotionGaps, scriptAnimation, sourceFiles, valueAt } from "./harness/ui-rules.ts";

const renderer = join(import.meta.dirname, "..", "src", "renderer");
const rendererSources = sourceFiles(renderer, [".ts", ".html", ".css"]);
// `desk-tokens.css` is generated custom properties; the rules below are about the stylesheets written by hand (desk-tokens.test.ts checks the generated one).
const cssFiles = sourceFiles(renderer, [".css"]).filter((f) => !f.endsWith("desk-tokens.css"));

describe("i18n", () => {
	it("keeps the key sets of en and zh-TW identical", () => {
		assert.deepEqual(flattenKeys(zhTW).sort(), flattenKeys(en).sort());
	});

	it("has a non-empty string behind every key, with the same placeholders in both locales", () => {
		for (const key of flattenKeys(en)) {
			const a = valueAt(en, key);
			const b = valueAt(zhTW, key);
			assert.equal(typeof a, "string", key);
			assert.equal(typeof b, "string", key);
			assert.ok((a as string).trim() && (b as string).trim(), `${key} is empty`);
			assert.deepEqual(placeholders(b as string), placeholders(a as string), `${key} placeholders differ`);
		}
	});

	it("writes zh-TW in Traditional characters", () => {
		// A few characters whose Simplified form differs; the check is a tripwire, not a proof.
		const simplified = /[这个们与开关设装态载务体务户术]/u;
		for (const key of flattenKeys(zhTW)) assert.ok(!simplified.test(String(valueAt(zhTW, key))), `${key} has a Simplified character`);
	});

	it("resolves every data-i18n key the pages use in both locales", () => {
		const keys = new Set<string>();
		for (const file of rendererSources.filter((f) => f.endsWith(".html"))) {
			for (const m of readText(file).matchAll(/data-i18n="([^"]+)"/g)) keys.add(m[1] ?? "");
		}
		assert.ok(keys.size > 0);
		for (const key of keys) for (const locale of ["en", "zh-TW"] as const) assert.ok(t(locale, key), `${key} in ${locale}`);
	});

	it("throws on a missing key instead of rendering a blank", () => {
		assert.throws(() => t("en", "welcome.nope"), /missing string/);
		assert.throws(() => t("zh-TW", "welcome"), /not a string/);
	});

	it("registers both locales", () => {
		assert.deepEqual(Object.keys(catalogs).sort(), ["en", "zh-TW"]);
	});
});

describe("animation is CSS only", () => {
	it("finds no requestAnimationFrame or .animate( in src/renderer", () => {
		const found = rendererSources.flatMap((f) => scriptAnimation(f, readText(f)));
		assert.deepEqual(found, []);
	});

	it("fails on each planted violation", () => {
		assert.equal(scriptAnimation("x.ts", "requestAnimationFrame(tick);").length, 1);
		assert.equal(scriptAnimation("x.ts", "el.animate([{opacity: 0}], 200);").length, 1);
		assert.equal(scriptAnimation("x.ts", "el.animate ([])").length, 1);
		assert.equal(scriptAnimation("x.ts", "const animated = true; el.classList.add('animate');").length, 0);
	});
});

describe("borders are uniform", () => {
	it("finds no one-sided border declaration in the renderer's CSS", () => {
		assert.ok(cssFiles.length > 0);
		const found = cssFiles.flatMap((f) => oneSidedBorders(f, readText(f)));
		assert.deepEqual(found, []);
	});

	it("fails on every one-sided form and passes the uniform ones", () => {
		for (const decl of [
			"border-left: 3px solid red;", "border-right: 1px solid;", "border-top: 0;", "border-bottom: 1px solid #ccc;",
			"border-left-color: red;", "border-top-width: 2px;", "border-inline-start: 2px solid;", "border-block-end-style: solid;", ".card { border-left: 4px solid; }",
		]) assert.equal(oneSidedBorders("x.css", decl).length, 1, decl);
		for (const decl of [
			"border: 1px solid var(--line);", "border-radius: 8px;", "border-top-left-radius: 8px;", "border-color: red;", "border-width: 1px;", "border-collapse: collapse;",
		]) assert.equal(oneSidedBorders("x.css", decl).length, 0, decl);
	});
});

describe("reduced motion", () => {
	it("turns every animation and transition off on each page, through the stylesheets it loads", () => {
		for (const page of ["wizard", "settings", "screen"]) {
			const sheets = [...readText(join(renderer, `${page}.html`)).matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map((m) => m[1] as string).filter((f) => f !== "desk-tokens.css");
			assert.ok(sheets.length >= 2, page);
			assert.deepEqual(reducedMotionGaps(page, sheets.map((f) => readText(join(renderer, f))).join("\n")), [], page);
		}
		// The shared stylesheet carries the block, so no page can forget it.
		assert.deepEqual(reducedMotionGaps("desk.css", readText(join(renderer, "desk.css"))), []);
	});

	it("flags a stylesheet without the block or with a partial one", () => {
		assert.equal(reducedMotionGaps("x.css", ".a { animation: spin 1s infinite; }").length, 1);
		assert.ok(reducedMotionGaps("x.css", "@media (prefers-reduced-motion: reduce) { .a { animation: none; } }").length >= 2);
	});

	it("uses animation in the stylesheet at all, so the end-to-end check has something to turn off", () => {
		assert.ok(cssFiles.some((f) => /@keyframes/.test(readText(f))));
	});
});
