import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { menuTemplate } from "../src/main/menu.ts";
import { catalogs, t } from "../src/renderer/i18n/index.ts";
import { SETTINGS_SECTIONS } from "../src/shared/wizard.ts";
import { readText, sourceFiles } from "./harness/ui-rules.ts";

// The shell pages added by task 9 (wizard.html, settings.html) have no DOM in a node test, so these checks read the files: the same strict page as the runtime page, every element a script
// looks up, every catalog key a script asks for in both languages, and the menu that opens the settings.

const renderer = join(import.meta.dirname, "..", "src", "renderer");
const read = (name: string): string => readFileSync(join(renderer, name), "utf8");

describe("the wizard and settings pages", () => {
	for (const [page, script, style] of [["wizard.html", "wizard.ts", "wizard.css"], ["settings.html", "settings.ts", "settings.css"]] as const) {
		it(`${page} loads only its own script and style under the strict CSP, with no inline script or handler`, () => {
			const html = read(page);
			assert.match(html, /default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'/);
			assert.deepEqual([...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]).sort(), ["desk-tokens.css", "desk.css", style, script.replace(".ts", ".js")].sort());
			assert.doesNotMatch(html, /<script(?![^>]*src=)/);
			assert.doesNotMatch(html, /\son[a-z]+=/);
			const ids = [...read(script).matchAll(/getElementById\("([a-z-]+)"\)|byId\("([a-z-]+)"\)/g)].map((m) => m[1] ?? m[2] ?? "");
			assert.ok(ids.length >= 2);
			for (const id of ids) assert.match(html, new RegExp(`id="${id}"`), id);
		});
	}

	it("asks the catalog only for keys both languages have", () => {
		const files = sourceFiles(renderer, [".ts"]).filter((f) => !f.includes("i18n"));
		const keys = new Set<string>();
		for (const file of files) {
			for (const m of readText(file).matchAll(/\b(?:tr|t)\((?:locale, )?"([a-zA-Z.-]+)"/g)) keys.add(m[1] ?? "");
		}
		assert.ok(keys.size > 60, `found ${keys.size} keys`);
		for (const key of keys) for (const locale of ["en", "zh-TW"] as const) assert.ok(t(locale, key), `${key} in ${locale}`);
	});

	it("has words for every family of keys a page builds from a name", () => {
		for (const locale of ["en", "zh-TW"] as const) {
			const c = catalogs[locale];
			for (const badge of ["waiting", "working", "done", "skipped", "failed", "blocked"]) assert.ok(c.install.badge[badge as keyof typeof c.install.badge], `${locale} badge ${badge}`);
			for (const stage of ["preflight", "node", "git", "herdr", "fd-rg", "gh", "glab", "opt", "tool-paths", "launchers", "git-helpers", "pi", "pi-shim", "profile", "pi-settings", "pkg", "team-pkg", "claude", "ttt", "other"]) {
				assert.ok((c.install.stage as Record<string, string>)[stage], `${locale} stage ${stage}`);
			}
			for (const problem of ["not-absolute", "outside-home", "is-home", "inside-app-data", "not-a-folder"]) assert.ok((c.folder.problems as Record<string, string>)[problem], `${locale} folder problem ${problem}`);
			for (const section of SETTINGS_SECTIONS) {
				assert.ok(c.menu[section], `${locale} menu ${section}`);
				const block = c.settings[section];
				assert.ok(block.title && block.lead, `${locale} settings ${section}`);
			}
			for (const step of ["welcome", "recipe", "trust", "folder", "install", "start", "claude", "hosts", "linear", "projects", "done"]) assert.ok((c.steps as Record<string, string>)[step], `${locale} step ${step}`);
			for (const item of ["claude", "github", "gitlab", "linear"]) assert.ok((c.later as Record<string, string>)[item], `${locale} later ${item}`);
		}
	});

	it("words every rule the recipe validator can name", () => {
		const validator = readFileSync(join(import.meta.dirname, "..", "..", "recipe", "validate.mjs"), "utf8");
		const rules = new Set([...validator.matchAll(/errors\.add\([^,]*,\s*"([a-z-]+)"/g)].map((m) => m[1] ?? ""));
		assert.ok(rules.size > 15);
		for (const rule of rules) for (const locale of ["en", "zh-TW"] as const) assert.ok((catalogs[locale].recipe.rules as Record<string, string>)[rule], `${locale} rule ${rule}`);
	});

	it("keeps the page free of innerHTML", () => {
		for (const file of sourceFiles(renderer, [".ts"])) assert.doesNotMatch(readText(file), /innerHTML|insertAdjacentHTML|outerHTML/, file);
	});
});

describe("the application menu", () => {
	const deps = (over: Partial<Parameters<typeof menuTemplate>[0]> = {}) => ({ locale: "en" as const, platform: "win32" as NodeJS.Platform, settingsEnabled: true, openSettings: () => undefined, ...over });
	const settings = (items: ReturnType<typeof menuTemplate>) => items.find((i) => i.id === "settings")?.submenu as Array<{ id: string; label: string; enabled: boolean; click: () => void; accelerator?: string }>;

	it("has a Settings menu with the six sections, in the interface language", () => {
		const en = settings(menuTemplate(deps()));
		assert.deepEqual(en.map((i) => i.id), SETTINGS_SECTIONS.map((s) => `settings-${s}`));
		assert.deepEqual(en.map((i) => i.label), ["Accounts", "Team recipe", "Team guidance", "Updates", "Computer", "Diagnostics"]);
		const zh = settings(menuTemplate(deps({ locale: "zh-TW" })));
		assert.deepEqual(zh.map((i) => i.label), ["帳號", "團隊配方", "團隊指引", "更新", "電腦", "診斷"]);
		assert.equal(en[0]?.accelerator, "CmdOrCtrl+,");
	});

	it("opens the section clicked, and is disabled until the wizard is done", () => {
		const opened: string[] = [];
		const items = settings(menuTemplate(deps({ openSettings: (s) => opened.push(s) })));
		items[4]?.click();
		assert.deepEqual(opened, ["computer"]);
		assert.ok(settings(menuTemplate(deps({ settingsEnabled: false }))).every((i) => i.enabled === false));
	});

	it("keeps the roles of the app menu on macOS only", () => {
		assert.equal(menuTemplate(deps({ platform: "darwin" }))[0]?.role, "appMenu");
		assert.notEqual(menuTemplate(deps())[0]?.role, "appMenu");
	});
});
