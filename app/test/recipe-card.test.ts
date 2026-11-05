import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { FetchReason, RecipeCardState, RecipeCardView, RecipeChange } from "../src/shared/recipe-update.ts";
import { isRecipeAction } from "../src/shared/recipe-update.ts";
import type { SettingsAction } from "../src/shared/wizard.ts";
import { catalogs } from "../src/renderer/i18n/index.ts";
import { makeSettingsCtx } from "../src/renderer/settings/common.ts";
import { recipe } from "../src/renderer/settings/recipe.ts";
import { installMiniDom, MiniElement } from "./harness/mini-dom.ts";
import { settingsView } from "./harness/views.ts";

// The Team recipe card drawn without a browser (task 12): a card per item, ids that do not repeat, one action row with the primary action first, the change list item by item, a sentence for each
// state and each fetch refusal in both languages, and the requests each button sends. The pictures of each state are the e2e gallery's.

let undo = (): void => undefined;
before(() => {
	undo = installMiniDom();
});
after(() => undo());

const active = { id: "team", name: "Team", version: "1.0.0", source: { kind: "file", fileName: "team.json" } as const, updateHost: "recipes.example.com" };
const card = (state: RecipeCardState, over: Partial<RecipeCardView> = {}): RecipeCardView => ({ active, state, projects: { rows: [], running: false, held: false }, enabled: true, ...over });

const draw = (view: RecipeCardView | undefined, locale: "en" | "zh-TW" = "en", acts: SettingsAction[] = []): MiniElement => {
	const settings = settingsView({ locale, ...(view === undefined ? {} : { recipeCard: view }) });
	return recipe(makeSettingsCtx(settings, locale, (a) => void acts.push(a))) as unknown as MiniElement;
};
const cardOf = (section: MiniElement, role: string): MiniElement => {
	const found = section.querySelector(`li[data-role="${role}"]`);
	assert.ok(found, `the ${role} card`);
	return found as MiniElement;
};
const buttons = (el: MiniElement): MiniElement[] => el.querySelectorAll("button");
const ids = (el: MiniElement): string[] => [el.id, ...el.children.flatMap(ids)].filter((i) => i !== "");

const CHANGES: RecipeChange[] = [
	{ kind: "name", from: "Team", to: "Team 2" },
	{ kind: "version", from: "1.0.0", to: "1.1.0" },
	{ kind: "forge-added", forge: "gitlab", host: "gitlab.example.com" },
	{ kind: "forge-removed", forge: "github", host: "github.com" },
	{ kind: "repo-added", folder: "web", host: "github.com", label: "Web", defaultBranch: null },
	{ kind: "repo-added", folder: "api", host: "github.com", label: "Api", defaultBranch: "develop" },
	{ kind: "repo-removed", folder: "old" },
	{ kind: "repo-branch", folder: "web", from: null, to: "develop" },
	{ kind: "repo-url", folder: "web", host: "gitlab.example.com" },
	{ kind: "repo-label", folder: "web", from: "Web", to: "Web app" },
	{ kind: "relay", from: null, to: "https://relay.example.com" },
	{ kind: "linear", to: true },
	{ kind: "linear", to: false },
	{ kind: "tool-added", name: "ttt", version: "1.2.3" },
	{ kind: "tool-added", name: "glab", version: null },
	{ kind: "tool-removed", name: "gh" },
	{ kind: "profile", from: null, to: "team-profile 1.0.0" },
	{ kind: "package-added", name: "pi-x", version: "1.0.0" },
	{ kind: "package-removed", name: "pi-y" },
	{ kind: "package-changed", name: "pi-z", from: "1.0.0", to: "1.1.0" },
	{ kind: "instructions", text: "- Always run the tests." },
	{ kind: "instructions", text: null },
	{ kind: "update-host", from: "a.example.com", to: null },
];

describe("Team recipe: cards", () => {
	it("draws the recipe and the update as cards of their own, ids that never repeat, and at most one action row each", () => {
		const section = draw(card({ phase: "idle", checkedAt: null }));
		assert.deepEqual(section.querySelectorAll("li.update-card").map((c) => c.getAttribute("data-role")), ["recipe", "update"]);
		const all = ids(section);
		assert.equal(new Set(all).size, all.length, `no id repeats: ${all.join(", ")}`);
		for (const c of section.querySelectorAll("li.update-card")) assert.ok(c.querySelectorAll(".update-buttons").length <= 1);
		assert.equal(section.querySelector("#recipe-name")?.textContent, "Team");
		assert.equal(section.querySelector("#recipe-version")?.textContent, "Version 1.0.0");
		assert.equal(section.querySelector("#recipe-source")?.textContent, "From the file team.json");
	});

	it("says where an update came from: the host it was fetched from", () => {
		const section = draw(card({ phase: "idle", checkedAt: null }, { active: { ...active, source: { kind: "url", host: "recipes.example.com" } } }));
		assert.equal(section.querySelector("#recipe-source")?.textContent, "From recipes.example.com");
	});

	it("puts Replace in the recipe's card as its primary action, and Check now in the update's card", () => {
		const section = draw(card({ phase: "idle", checkedAt: null }));
		assert.deepEqual(buttons(cardOf(section, "recipe")).map((b) => [b.id, b.className, b.textContent]), [["recipe-replace", "primary", "Replace with another file…"]]);
		assert.deepEqual(buttons(cardOf(section, "update")).map((b) => [b.id, b.className, b.textContent]), [["recipe-check", "primary", "Check now"]]);
	});

	it("has no Check now for a recipe without an address to ask, and says so", () => {
		const section = draw(card({ phase: "idle", checkedAt: null }, { active: { ...active, updateHost: null } }));
		assert.deepEqual(buttons(cardOf(section, "update")), []);
		assert.equal(section.querySelector("#recipe-update-note")?.textContent, catalogs.en.settings.recipe.noUpdates);
	});

	it("draws what is in use for a machine with no recipe, with Replace still there", () => {
		const section = draw(card({ phase: "idle", checkedAt: null }, { active: null }));
		assert.equal(section.querySelector("#recipe-current")?.textContent, "No recipe is in use.");
		assert.deepEqual(buttons(cardOf(section, "recipe")).map((b) => b.id), ["recipe-replace"]);
	});

	it("disables the actions before the wizard is over and while a check or an apply runs", () => {
		const before = draw(card({ phase: "idle", checkedAt: null }, { enabled: false }));
		assert.deepEqual(buttons(before).map((b) => [b.id, b.disabled]), [["recipe-replace", true], ["recipe-check", true]]);
		const checking = draw(card({ phase: "checking" }));
		assert.deepEqual(buttons(checking).map((b) => [b.id, b.disabled]), [["recipe-replace", true], ["recipe-check", true]]);
		assert.equal(cardOf(checking, "update").querySelector("#recipe-update-note")?.textContent, catalogs.en.settings.recipe.checking);
	});

	it("falls back to the one line without a view", () => {
		const section = draw(undefined);
		assert.equal(section.querySelector("#recipe-current")?.textContent, "No recipe is in use.");
	});
});

describe("Team recipe: an offered update", () => {
	const offered = (over: Partial<Extract<RecipeCardState, { phase: "offered" }>> = {}): RecipeCardState => ({ phase: "offered", origin: "url", id: "team", name: "Team", version: "1.1.0", replaces: false, changes: CHANGES, sha256: "ab", ...over });

	it("offers Apply first as the primary action and Keep mine beside it, and no Check now", () => {
		const update = cardOf(draw(card(offered())), "update");
		assert.deepEqual(buttons(update).map((b) => [b.id, b.className, b.textContent]), [["recipe-apply", "primary", "Apply"], ["recipe-keep", "", "Keep mine"]]);
	});

	it("lists every change in words, in both languages, with no placeholder left", () => {
		for (const locale of ["en", "zh-TW"] as const) {
			const items = draw(card(offered()), locale).querySelectorAll("#recipe-changes li");
			assert.equal(items.length, CHANGES.length);
			for (const item of items) {
				assert.ok(item.textContent.length > 4, item.getAttribute("data-change") ?? "");
				assert.doesNotMatch(item.textContent.replace(/- Always run the tests\./, ""), /\{[A-Za-z]+\}/, `${locale} ${item.getAttribute("data-change")}`);
			}
		}
	});

	it("words the changes the way the PM reads them", () => {
		const texts = draw(card(offered())).querySelectorAll("#recipe-changes li").map((l) => l.textContent);
		assert.ok(texts.includes("Version: 1.0.0 to 1.1.0"));
		assert.ok(texts.includes("Signs in to GitLab at gitlab.example.com"));
		assert.ok(texts.includes("New project Web: copied from github.com into the folder web"));
		assert.ok(texts.includes("New project Api: copied from github.com into the folder api, starting branch develop"));
		assert.ok(texts.includes("web: starting branch the code host's own becomes develop"));
		assert.ok(texts.includes("Package pi-z: 1.0.0 becomes 1.1.0. It installs third-party code."));
		assert.ok(texts.some((t) => t.startsWith("The team instructions change.")));
		assert.ok(texts.includes("The team instructions are removed"));
		assert.ok(texts.includes("Updates come from none instead of a.example.com"));
	});

	it("shows new team instructions in full, as text and never as markup", () => {
		const section = draw(card(offered()));
		assert.equal(section.querySelector("#recipe-changes pre")?.textContent, "- Always run the tests.");
	});

	it("tells which kind of offer it is: an update, another recipe, or a file the PM chose", () => {
		const note = (o: Partial<Extract<RecipeCardState, { phase: "offered" }>>) => draw(card(offered(o))).querySelector("#recipe-update-note")?.textContent ?? "";
		assert.match(note({}), /^Version 1\.1\.0 of Team is ready\./);
		assert.match(note({ replaces: true, origin: "file", name: "Other" }), /Other, version 1\.1\.0, is another recipe\. Applying it replaces the one you have/);
		assert.match(note({ origin: "file" }), /from the file you chose/);
		assert.match(draw(card(offered())).querySelector("#recipe-install-note")?.textContent ?? "", /stops your agents for a few minutes/);
	});

	it("sends the request each button stands for", () => {
		const acts: SettingsAction[] = [];
		const section = draw(card(offered()), "en", acts);
		for (const b of buttons(section)) b.fire("click");
		assert.deepEqual(acts, [{ type: "recipe-replace" }, { type: "recipe-apply" }, { type: "recipe-keep" }]);
		for (const a of acts) assert.equal(isRecipeAction(a), true);
		assert.equal(isRecipeAction({ type: "recipe-apply", extra: 1 }), true);
		assert.equal(isRecipeAction({ type: "project-retry" }), false);
		assert.equal(isRecipeAction({ type: "recipe-wipe" }), false);
	});
});

describe("Team recipe: the other states", () => {
	const note = (state: RecipeCardState, locale: "en" | "zh-TW" = "en", over: Partial<RecipeCardView> = {}): string => draw(card(state, over), locale).querySelector("#recipe-update-note")?.textContent ?? "";

	it("words every fetch refusal in both languages, and the status the server answered", () => {
		const reasons: FetchReason[] = ["scheme", "credentials", "host", "redirects", "too-large", "status", "network"];
		for (const locale of ["en", "zh-TW"] as const) {
			for (const fetch of reasons) {
				const text = note({ phase: "refused", reason: "fetch", fetch, ...(fetch === "status" ? { status: 404 } : {}) }, locale);
				assert.ok(text.length > 10, `${locale} ${fetch}`);
				assert.doesNotMatch(text, /\{[A-Za-z]+\}/, `${locale} ${fetch}`);
			}
		}
		assert.match(note({ phase: "refused", reason: "fetch", fetch: "status", status: 404 }), /answered 404/);
		assert.equal(note({ phase: "refused", reason: "fetch", fetch: "status" }), catalogs.en.settings.recipe.fetch.statusPlain);
		assert.equal(note({ phase: "refused", reason: "fetch", fetch: "host" }), catalogs.en.settings.recipe.fetch.host);
	});

	it("words the other refusals, and draws the field and rule of an invalid file without its contents", () => {
		for (const reason of ["other-id", "not-newer", "unreadable"] as const) assert.equal(note({ phase: "refused", reason }), catalogs.en.settings.recipe.refused[reason]);
		const section = draw(card({ phase: "refused", reason: "invalid", fields: [{ field: "repos[0].folder", rule: "reserved-folder" }] }));
		assert.deepEqual(section.querySelectorAll("#recipe-refusals tbody tr").map((r) => r.children.map((c) => c.textContent)), [["repos[0].folder", "reserved-folder"]]);
		assert.equal(section.querySelector("#recipe-update-note")?.textContent, catalogs.en.settings.recipe.refused.invalid);
	});

	it("says what a failed update undid, naming the stage, and what is left to repair", () => {
		assert.match(note({ phase: "failed", stage: "opt:glab", category: "download", restored: true, at: "2026-11-05T10:00:00.000Z" }), /stopped at “.+” and was undone\. Your old recipe is back/);
		assert.match(note({ phase: "failed", stage: "opt:glab", category: "download", restored: false, at: "2026-11-05T10:00:00.000Z" }), /Run Repair in Diagnostics/);
	});

	it("says applied, kept, busy and other, in both languages", () => {
		for (const locale of ["en", "zh-TW"] as const) {
			for (const state of [{ phase: "applied", version: "1.1.0", at: "2026-11-05T10:00:00.000Z" }, { phase: "kept", version: "1.1.0" }, { phase: "error", kind: "busy", detail: "x" }, { phase: "error", kind: "other", detail: "x" }, { phase: "applying", step: "install" }] as RecipeCardState[]) {
				const text = note(state, locale);
				assert.ok(text.length > 10);
				assert.doesNotMatch(text, /\{[A-Za-z]+\}/);
			}
		}
		assert.equal(draw(card({ phase: "error", kind: "other", detail: "boom" })).querySelector("details p")?.textContent, "boom");
	});

	it("shows the badge of each state, and the time of the last check", () => {
		assert.equal(draw(card({ phase: "idle", checkedAt: "2026-11-05T10:00:00.000Z" })).querySelector("#recipe-checked")?.textContent?.startsWith("Last checked at"), true);
		assert.equal(draw(card({ phase: "idle", checkedAt: null })).querySelector("#recipe-never")?.textContent, catalogs.en.settings.recipe.never);
		for (const phase of ["idle", "checking", "offered", "applying", "applied", "kept", "refused", "failed", "error"] as const) {
			const state = { idle: { phase: "idle", checkedAt: null }, checking: { phase: "checking" }, offered: { phase: "offered", origin: "url", id: "t", name: "T", version: "2", replaces: false, changes: [], sha256: "" }, applying: { phase: "applying", step: "recipe" }, applied: { phase: "applied", version: "2", at: "" }, kept: { phase: "kept", version: "2" }, refused: { phase: "refused", reason: "not-newer" }, failed: { phase: "failed", stage: "x", category: "y", restored: true, at: "" }, error: { phase: "error", kind: "other", detail: "" } }[phase] as RecipeCardState;
			assert.equal(draw(card(state)).querySelector("[data-badge]")?.getAttribute("data-badge"), phase);
		}
	});

	it("lists the recipe's projects as cards beneath, and says when there are none", () => {
		const none = draw(card({ phase: "idle", checkedAt: null }));
		assert.equal(none.querySelector("#recipe-projects-none")?.textContent, catalogs.en.settings.recipe.projectsNone);
		const some = draw(card({ phase: "idle", checkedAt: null }, { projects: { rows: [{ folder: "web", label: "Web", host: "github.com", defaultBranch: null, phase: "failed", step: null, reused: false, opened: false, links: null, failure: { kind: "other-origin" }, detail: "" }], running: false, held: false } }));
		const acts: SettingsAction[] = [];
		const again = draw(card({ phase: "idle", checkedAt: null }, { projects: { rows: [{ folder: "web", label: "Web", host: "github.com", defaultBranch: null, phase: "failed", step: null, reused: false, opened: false, links: null, failure: { kind: "other-origin" }, detail: "" }], running: false, held: false } }), "en", acts);
		assert.equal(some.querySelectorAll("#recipe-projects li.project-card").length, 1);
		again.querySelector("#project-0-retry")?.fire("click");
		assert.deepEqual(acts, [{ type: "project-retry", folder: "web" }]);
	});
});
