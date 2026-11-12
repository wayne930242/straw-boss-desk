import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { listOf } from "../src/shared/locale.ts";
import type { WizardView } from "../src/shared/wizard.ts";
import { catalogs } from "../src/renderer/i18n/index.ts";
import { packageDroppedSentence, TOOLS_RUNNING_SENTENCE } from "../src/main/bootstrap/errors.ts";
import { announcementParts, newParts } from "../src/renderer/wizard/announce.ts";
import { failureSentence, nowLine, stageLabel } from "../src/renderer/wizard/install.ts";
import { makeCtx } from "../src/renderer/wizard/common.ts";
import { flattenKeys, readText, sourceFiles, valueAt } from "./harness/ui-rules.ts";

// The wizard's pages without a DOM: the words a screen reader hears, the language of lists and parentheses, and what the sources promise about focus and the drop zone.

const renderer = join(import.meta.dirname, "..", "src", "renderer");

const view = (over: Partial<WizardView> = {}): WizardView => ({
	step: "install",
	steps: ["welcome", "recipe", "trust", "folder", "install", "start", "claude", "hosts", "linear", "projects", "done"],
	locale: "en",
	root: "/r",
	dev: true,
	welcome: { wslBash: null },
	recipe: { choice: { kind: "none" }, refused: [], fileName: null },
	trust: null,
	folder: { path: "/h/StrawBoss", defaultPath: "/h/StrawBoss", problem: null },
	install: { status: "running", stages: [{ name: "node", badge: "working" }], current: "node", failures: [], tail: [], crashed: null },
	start: { status: "idle", failure: null },
	hosts: { forges: [], index: 0, current: null },
	claude: { state: "unknown", storage: "keychain", flow: { phase: "idle" } },
	linear: { state: "not-saved", flow: { phase: "idle" }, restart: { phase: "none" }, encryption: true },
	linearOffered: false,
	projects: { rows: [], running: false, held: false },
	later: [],
	...over,
});
const parts = (v: WizardView) => announcementParts(makeCtx(v, v.locale, () => undefined));

describe("lists and parentheses follow the language (SA-04)", () => {
	it("joins a list with the language's separators", () => {
		const items = ["Claude", "GitHub（github.com）", "GitLab（gitlab.com）", "Linear"];
		assert.equal(listOf("zh-TW", items), "Claude、GitHub（github.com）、GitLab（gitlab.com）和 Linear");
		assert.equal(listOf("en", ["Claude", "GitHub (github.com)", "Linear"]), "Claude, GitHub (github.com), and Linear");
		assert.equal(listOf("zh-TW", ["Claude"]), "Claude");
	});

	it("spaces 「和」 from a Latin or digit neighbour in zh-TW, and only then (SA-09)", () => {
		assert.equal(listOf("zh-TW", ["Claude", "Linear"]), "Claude 和 Linear", "Latin on both sides");
		assert.equal(listOf("zh-TW", ["GitHub（github.com）", "Linear"]), "GitHub（github.com）和 Linear", "a full-width parenthesis needs no space");
		assert.equal(listOf("zh-TW", ["Claude", "第二項"]), "Claude 和第二項", "Chinese after 和 needs none");
		assert.equal(listOf("zh-TW", ["第一項", "第二項"]), "第一項和第二項");
		assert.equal(listOf("zh-TW", ["甲", "乙", "7 號"]), "甲、乙和 7 號", "a digit counts as Latin");
		assert.equal(listOf("zh-TW", [".agents/skills", ".claude/commands"]), ".agents/skills 和 .claude/commands", "a path that starts with a dot is Latin (SA-T12-2)");
		assert.equal(listOf("zh-TW", [".agents/skills", ".pi/x", "/opt/y"]), ".agents/skills、.pi/x 和 /opt/y");
		assert.equal(listOf("zh-TW", [".pi/x", "另外 3 個"]), ".pi/x 和另外 3 個");
		assert.equal(listOf("en", ["Claude", "Linear"]), "Claude and Linear", "English is left to Intl.ListFormat");
	});

	it("puts no space between a full-width 「）」 and 「、」 or 「和」, whatever spaces the ICU separators carry (SA-11)", () => {
		const real = Intl.ListFormat.prototype.formatToParts;
		Intl.ListFormat.prototype.formatToParts = function (this: Intl.ListFormat, list: Iterable<string>) {
			return real.call(this, list).map((p) => (p.type === "literal" ? { ...p, value: ` ${p.value} ` } : p));
		};
		try {
			assert.equal(listOf("zh-TW", ["GitHub（github.com）", "GitLab（gitlab.com）", "Linear"]), "GitHub（github.com）、GitLab（gitlab.com）和 Linear");
			assert.equal(listOf("zh-TW", ["GitHub（github.com）", "第二項"]), "GitHub（github.com）和第二項");
		} finally {
			Intl.ListFormat.prototype.formatToParts = real;
		}
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
		const next = parts(view({ install: { ...view().install, stages: [{ name: "node", badge: "done" }, { name: "git", badge: "working" }], current: "git" } }));
		assert.equal(newParts("en", first, next), "Now: Version control", "only the change is spoken");
	});

	it("says how many stages work when several do, and names the stage when one does (SA-07)", () => {
		const several = (locale: "en" | "zh-TW") =>
			view({ locale, install: { ...view().install, stages: [{ name: "node", badge: "working" }, { name: "git", badge: "working" }, { name: "fd-rg", badge: "working" }, { name: "gh", badge: "waiting" }, { name: "herdr", badge: "done" }], current: "fd-rg" } });
		assert.ok(parts(several("en")).includes("Now: 3 running"));
		assert.ok(parts(several("zh-TW")).includes("目前：3 項進行中"));
		const ctx = (v: WizardView) => makeCtx(v, v.locale, () => undefined);
		assert.equal(nowLine(ctx(several("en")), several("en").install), "Now: 3 running", "never the name of one of three");
		const one = view({ install: { ...view().install, stages: [{ name: "node", badge: "done" }, { name: "git", badge: "working" }], current: "node" } });
		assert.equal(nowLine(ctx(one), one.install), "Now: Version control", "the working stage, not the last one that was started or finished");
		const none = view({ install: { ...view().install, stages: [{ name: "node", badge: "done" }], current: null } });
		assert.equal(nowLine(ctx(none), none.install), null);
		const idle = view({ install: { ...view().install, status: "failed" } });
		assert.equal(nowLine(ctx(idle), idle.install), null, "nothing works once the run has ended");
	});

	it("words the tools-running failure in both catalogs, and the engine's English sentence is the catalog's (R9-F001)", () => {
		const failure = { stage: "pkg:x", category: "locked" as const, params: { reason: "tools-running" }, detail: "d" };
		const text = (locale: "en" | "zh-TW") => failureSentence(makeCtx(view({ locale }), locale, () => undefined), failure);
		assert.equal(text("en"), catalogs.en.install.failure.toolsRunning);
		assert.equal(text("zh-TW"), catalogs["zh-TW"].install.failure.toolsRunning);
		assert.equal(TOOLS_RUNNING_SENTENCE, catalogs.en.install.failure.toolsRunning);
		assert.doesNotMatch(catalogs.en.install.failure.toolsRunning, /\b(npm|pi|node|Herdr)\b/, "no tool is named where the PM reads");
		assert.match(catalogs["zh-TW"].install.failure.toolsRunning, /再試一次/, "it names the button the catalog has");
	});

	it("words the prune stage and its failure in both catalogs: a package the stack dropped that could not be removed (generation 15)", () => {
		const failure = { stage: "pkg-prune", category: "other" as const, params: { stage: "pkg-prune", reason: "package-dropped", name: "pi-old" }, detail: "d" };
		const ctxOf = (locale: "en" | "zh-TW") => makeCtx(view({ locale }), locale, () => undefined);
		assert.equal(failureSentence(ctxOf("en"), failure), packageDroppedSentence("pi-old"), "the engine's English sentence is the catalog's");
		assert.equal(failureSentence(ctxOf("zh-TW"), failure), catalogs["zh-TW"].install.failure.packageDropped.replace("{name}", "pi-old"));
		assert.match(catalogs["zh-TW"].install.failure.packageDropped, /再試一次/, "it names the button the catalog has");
		assert.doesNotMatch(`${catalogs.en.install.failure.packageDropped}${catalogs["zh-TW"].install.failure.packageDropped}`, /settings\.json|npm|\bpi\b/, "no file or tool is named where the PM reads");
		assert.equal(stageLabel(ctxOf("en"), "pkg-prune"), "Clean up add-ons no longer used");
		assert.equal(stageLabel(ctxOf("zh-TW"), "pkg-prune"), "清理不再使用的附加元件");
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
