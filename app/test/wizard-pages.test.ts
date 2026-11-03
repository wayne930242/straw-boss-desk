import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { listOf } from "../src/shared/locale.ts";
import type { WizardView } from "../src/shared/wizard.ts";
import { catalogs } from "../src/renderer/i18n/index.ts";
import { announcementParts, newParts } from "../src/renderer/wizard/announce.ts";
import { makeCtx } from "../src/renderer/wizard/common.ts";
import { flattenKeys, readText, sourceFiles, valueAt } from "./harness/ui-rules.ts";

// The wizard's pages without a DOM: the words a screen reader hears, the language of lists and parentheses, and what the sources promise about focus and the drop zone.

const renderer = join(import.meta.dirname, "..", "src", "renderer");

const view = (over: Partial<WizardView> = {}): WizardView => ({
	step: "install",
	steps: ["welcome", "recipe", "trust", "folder", "install", "start", "claude", "hosts", "linear", "done"],
	locale: "en",
	root: "/r",
	dev: true,
	welcome: { wslBash: null },
	recipe: { choice: { kind: "none" }, refused: [], fileName: null },
	trust: null,
	folder: { path: "/h/StrawBoss", defaultPath: "/h/StrawBoss", problem: null },
	install: { status: "running", stages: [{ name: "node", badge: "working" }], current: "node", failures: [], tail: [], crashed: null },
	start: { status: "idle", failure: null },
	hosts: { forges: [], index: 0 },
	linearOffered: false,
	later: [],
	...over,
});
const parts = (v: WizardView) => announcementParts(makeCtx(v, v.locale, () => undefined));

describe("lists and parentheses follow the language (SA-04)", () => {
	it("joins a list with the language's separators", () => {
		const items = ["Claude", "GitHub（github.com）", "GitLab（gitlab.com）", "Linear"];
		assert.equal(listOf("zh-TW", items), "Claude、GitHub（github.com）、GitLab（gitlab.com）和Linear");
		assert.equal(listOf("en", ["Claude", "GitHub (github.com)", "Linear"]), "Claude, GitHub (github.com), and Linear");
		assert.equal(listOf("zh-TW", ["Claude"]), "Claude");
	});

	it("uses full-width parentheses in every zh-TW string and half-width ones in every English string", () => {
		for (const key of flattenKeys(catalogs["zh-TW"])) assert.doesNotMatch(String(valueAt(catalogs["zh-TW"], key)), /[()]/, `zh-TW ${key}`);
		for (const key of flattenKeys(catalogs.en)) assert.doesNotMatch(String(valueAt(catalogs.en, key)), /[（）]/, `en ${key}`);
	});

	it("builds no parenthesised text or comma-joined list in a page, where the language could not change it", () => {
		for (const file of sourceFiles(renderer, [".ts"]).filter((f) => !f.includes("i18n"))) {
			const text = readText(file);
			assert.doesNotMatch(text, /\$\{[^}]+\}\s*\(/, `${file} puts a half-width parenthesis after a value`);
			assert.doesNotMatch(text, /\.join\(", "\)/, `${file} joins with a comma`);
			assert.doesNotMatch(text, /"\(setup\)"/, `${file} has English text in code`);
		}
	});
});

describe("what a screen reader hears (T9-F004)", () => {
	it("speaks the step on a new step and the stage line when the stage changes, and nothing for a redraw that changed nothing", () => {
		const first = parts(view());
		assert.deepEqual(first, ["Install", "Now: Programming runtime"]);
		assert.equal(newParts("en", [], first), "Install. Now: Programming runtime");
		assert.equal(newParts("en", first, parts(view())), "", "a redraw of the same view is silent");
		const next = parts(view({ install: { ...view().install, current: "git" } }));
		assert.equal(newParts("en", first, next), "Now: Version control", "only the change is spoken");
	});

	it("speaks a refusal, a folder problem and a failure once, in the page's language", () => {
		const refused = parts(view({ step: "recipe", recipe: { choice: { kind: "none" }, refused: [{ field: "a", rule: "invalid-json" }], fileName: null } }));
		assert.ok(refused.includes(catalogs.en.recipe.refusedTitle));
		const zh = parts(view({ locale: "zh-TW", step: "folder", folder: { path: "/x", defaultPath: "/y", problem: "outside-home" } }));
		assert.ok(zh.includes(catalogs["zh-TW"].folder.problems["outside-home"]));
		assert.equal(newParts("zh-TW", ["a"], ["a", "b", "c"]), "b。c");
		const failed = parts(view({ install: { status: "failed", stages: [], current: null, failures: [{ stage: "node", category: "disk", params: {}, detail: "d" }], tail: [], crashed: null } }));
		assert.ok(failed.includes(catalogs.en.install.failure.disk));
	});

	it("keeps the live region out of the step, which is rebuilt on every change", () => {
		const html = readText(join(renderer, "wizard.html"));
		assert.doesNotMatch(html, /<section id="step"[^>]*aria-live/);
		assert.match(html, /id="announce"[^>]*aria-live="polite"/);
		for (const file of sourceFiles(join(renderer, "wizard"), [".ts"])) assert.doesNotMatch(readText(file), /role: "(?:alert|status)"/, `${file} puts a live role in a rebuilt step`);
	});

	it("restores focus to the same control after a redraw, and starts a new step at its heading", () => {
		const script = readText(join(renderer, "wizard.ts"));
		assert.match(script, /function focusKey\(\)/);
		assert.match(script, /target\.focus\(\{ preventScroll: true \}\)/);
		assert.match(script, /heading\?\.focus/);
		assert.match(script, /announce\.textContent = text/);
	});

	it("makes the drop zone a button that Enter and Space open", () => {
		const recipe = readText(join(renderer, "wizard", "recipe.ts"));
		assert.match(recipe, /id: "recipe-drop", tabindex: 0, role: "button"/);
		assert.match(recipe, /e\.key !== "Enter" && e\.key !== " "/);
		assert.match(recipe, /ctx\.act\(\{ type: "choose-recipe-file" \}\)/);
	});
});

describe("the refusal table (SA-02)", () => {
	it("has a header over every column, in both languages", () => {
		const recipe = readText(join(renderer, "wizard", "recipe.ts"));
		assert.doesNotMatch(recipe, /h\("th", \{\}\)/, "no empty header cell");
		assert.match(recipe, /ctx\.tr\("recipe\.explanation"\)/);
		for (const locale of ["en", "zh-TW"] as const) assert.ok(catalogs[locale].recipe.explanation.length > 0);
	});
});

describe("the WSL sentence (SA-05)", () => {
	it("is the clearer sentence in zh-TW and says the same in English", () => {
		assert.equal(catalogs["zh-TW"].welcome.wsl, "這台電腦裝了 Windows Subsystem for Linux，它的 bash 會被優先使用，所以代理程式無法把工作派給子代理。其他功能都正常。");
		assert.match(catalogs.en.welcome.wsl, /Windows Subsystem for Linux.*bash is used first.*cannot hand work to helper agents\. Everything else works\.$/);
	});
});

describe("the PM's screens name no tool they do not need (T9-F007)", () => {
	it("keeps npm out of every sentence outside the Details strings", () => {
		for (const locale of ["en", "zh-TW"] as const) {
			for (const key of flattenKeys(catalogs[locale])) {
				if (/wslPath$/.test(key)) continue;
				assert.doesNotMatch(String(valueAt(catalogs[locale], key)), /\bnpm\b/i, `${locale} ${key}`);
			}
		}
	});
});
