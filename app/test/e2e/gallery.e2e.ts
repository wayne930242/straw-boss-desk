// The page gallery (task 12): every state of the projects step and of the Team recipe card, drawn by the real pages from `dist/renderer` through the real shell preload, in zh-TW and in English, one
// picture each (artifact `gallery-screenshots-<os>`). The views are scripted (`harness/views.ts`), so each state is there on purpose, not by luck of timing; the real flows (a real clone, a real update
// served by a local server) are `wizard.e2e.ts`'s. The test opens a window, so it runs on the CI runners only; it needs `npm run build` first and no packaged app.
//   SBD_E2E=1 SBD_E2E_KIND=dev node --test test/e2e/gallery.e2e.ts
import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { _electron as electron, type ElectronApplication, type Page } from "playwright-core";
import type { ProjectFailure, ProjectRow, ProjectsView } from "../../src/shared/projects.ts";
import type { FetchReason, RecipeCardState, RecipeCardView, RecipeChange } from "../../src/shared/recipe-update.ts";
import type { Locale } from "../../src/shared/locale.ts";
import { appRoot } from "../harness/packaged.ts";
import { settingsView, wizardView } from "../harness/views.ts";

const enabled = process.env.SBD_E2E === "1" && process.env.SBD_E2E_KIND !== "release";
const skip = enabled ? false : "opens a real window: runs on the CI runners only (SBD_E2E=1, development kind)";
const dist = join(appRoot, "dist");
const screenshotDir = join(process.env.SBD_SCREENSHOT_DIR ?? join(appRoot, "test-results", "screenshots"), "gallery");
const LOCALES: readonly Locale[] = ["zh-TW", "en"];

const row = (over: Partial<ProjectRow> = {}): ProjectRow => ({ folder: "web", label: "Web", host: "github.com", defaultBranch: null, phase: "waiting", step: null, reused: false, opened: false, links: null, failure: null, detail: "", ...over });
const failed = (failure: ProjectFailure, over: Partial<ProjectRow> = {}): ProjectRow => row({ phase: "failed", failure, ...over });
const done = (over: Partial<ProjectRow> = {}): ProjectRow => row({ phase: "done", opened: true, ...over });
const projects = (rows: ProjectRow[], over: Partial<ProjectsView> = {}): ProjectsView => ({ rows, running: rows.some((r) => r.phase === "working"), held: rows.some((r) => r.phase === "trust"), ...over });

const PROJECT_STATES: Array<[string, ProjectsView]> = [
	["cloning", projects([row({ folder: "web", label: "Web app", phase: "working", step: "cloning" }), row({ folder: "api", label: "Api" })])],
	["fetching-head", projects([row({ folder: "web", label: "Web app", defaultBranch: "develop", phase: "working", step: "head" }), done({ folder: "handbook", label: "Handbook" })])],
	["done", projects([done({ folder: "web", label: "Web app", defaultBranch: "develop" }), done({ folder: "handbook", label: "Handbook", reused: true })])],
	["other-origin", projects([failed({ kind: "other-origin" }, { folder: "web", label: "Web app" }), done({ folder: "handbook", label: "Handbook" })])],
	["not-empty", projects([failed({ kind: "not-empty" }, { folder: "web", label: "Web app" })])],
	["branch-missing", projects([failed({ kind: "branch-missing", branch: "develop" }, { folder: "web", label: "Web app", defaultBranch: "develop" })])],
	["reserved-folder", projects([failed({ kind: "reserved-folder" }, { folder: "Straw Boss", label: "Docs" })])],
	["symlinks", projects([done({ folder: "web", label: "Web app", links: { paths: [".agents/skills", ".claude/commands"], more: 0 } }), done({ folder: "api", label: "Api", links: { paths: [".agents/a", ".agents/b", ".agents/c", ".agents/d", ".agents/e", ".agents/f", ".agents/g", ".agents/h", ".agents/i", ".agents/j"], more: 3 } })])],
	["trust-held", projects([row({ folder: "web", label: "Web app", phase: "trust" }), row({ folder: "api", label: "Api" })])],
	["clone-network", projects([failed({ kind: "clone", cause: "network" }, { folder: "web", label: "Web app", detail: "fatal: unable to access 'https://github.com/acme/web.git/': Could not resolve host: github.com" })])],
	["clone-auth", projects([failed({ kind: "clone", cause: "auth" }, { folder: "web", label: "Web app" })])],
	["clone-not-found", projects([failed({ kind: "clone", cause: "not-found" }, { folder: "web", label: "Web app" })])],
	["open-refused", projects([failed({ kind: "open", cause: "settings-unsafe" }, { folder: "web", label: "Web app" }), failed({ kind: "open", cause: "gui-unavailable" }, { folder: "api", label: "Api" })])],
	["interrupted", projects([failed({ kind: "interrupted" }, { folder: "web", label: "Web app" })])],
];

const ACTIVE: RecipeCardView["active"] = { id: "team", name: "Team recipe", version: "1.0.0", source: { kind: "url", host: "recipes.example.com" }, updateHost: "recipes.example.com" };
const CHANGES: RecipeChange[] = [
	{ kind: "version", from: "1.0.0", to: "1.1.0" },
	{ kind: "forge-added", forge: "gitlab", host: "gitlab.example.com" },
	{ kind: "repo-added", folder: "docs", host: "github.com", label: "Docs", defaultBranch: "develop" },
	{ kind: "repo-branch", folder: "web", from: null, to: "develop" },
	{ kind: "tool-added", name: "bun", version: "1.3.0" },
	{ kind: "package-changed", name: "pi-example", from: "1.0.0", to: "1.1.0" },
	{ kind: "instructions", text: "- Run the tests before you open a request.\n- Ask the PM before you change a price." },
];
const fetchRefusal = (fetch: FetchReason, status?: number): RecipeCardState => ({ phase: "refused", reason: "fetch", fetch, ...(status !== undefined ? { status } : {}) });
const NOW = "2026-11-05T10:00:00.000Z";
const RECIPE_STATES: Array<[string, RecipeCardState, ProjectsView?]> = [
	["idle", { phase: "idle", checkedAt: NOW }],
	["never-checked", { phase: "idle", checkedAt: null }],
	["checking", { phase: "checking" }],
	["offered", { phase: "offered", origin: "url", id: "team", name: "Team recipe", version: "1.1.0", replaces: false, changes: CHANGES, sha256: "ab" }],
	["offered-file", { phase: "offered", origin: "file", id: "other", name: "Other team", version: "2.0.0", replaces: true, changes: CHANGES.slice(0, 3), sha256: "cd" }],
	["applying", { phase: "applying", step: "install" }],
	["applied", { phase: "applied", version: "1.1.0", at: NOW }, projects([done({ folder: "web", label: "Web app" }), row({ folder: "docs", label: "Docs", phase: "working", step: "cloning" })])],
	["kept", { phase: "kept", version: "1.1.0" }],
	["failed", { phase: "failed", stage: "opt:bun", category: "download", restored: true, at: NOW }],
	["failed-partly", { phase: "failed", stage: "opt:bun", category: "download", restored: false, at: NOW }],
	["refused-scheme", fetchRefusal("scheme")],
	["refused-credentials", fetchRefusal("credentials")],
	["refused-host", fetchRefusal("host")],
	["refused-redirects", fetchRefusal("redirects")],
	["refused-too-large", fetchRefusal("too-large")],
	["refused-status", fetchRefusal("status", 404)],
	["refused-network", fetchRefusal("network")],
	["refused-invalid", { phase: "refused", reason: "invalid", fields: [{ field: "repos[0].folder", rule: "reserved-folder" }, { field: "updateUrl", rule: "url-scheme" }] }],
	["refused-other-id", { phase: "refused", reason: "other-id", version: "9.0.0" }],
	["refused-not-newer", { phase: "refused", reason: "not-newer", version: "0.9.0" }],
	["refused-unreadable", { phase: "refused", reason: "unreadable" }],
	["error-busy", { phase: "error", kind: "busy", detail: "the tools did not stop in time" }],
	["projects-failed", { phase: "idle", checkedAt: NOW }, projects([failed({ kind: "other-origin" }, { folder: "web", label: "Web app" }), done({ folder: "handbook", label: "Handbook", links: { paths: [".agents/skills"], more: 0 } })])],
];

describe("every state of the projects step and the Team recipe card (gallery)", { skip }, () => {
	let app: ElectronApplication;
	let page: Page;

	const shot = async (name: string, locale: Locale): Promise<void> => {
		mkdirSync(screenshotDir, { recursive: true });
		await page.screenshot({ path: join(screenshotDir, `${name}-${locale}.png`), fullPage: true });
	};
	const settled = async (locale: Locale): Promise<void> => {
		const deadline = Date.now() + 10_000;
		while (Date.now() < deadline && (await page.evaluate(() => document.documentElement.lang)) !== locale) await new Promise((r) => setTimeout(r, 50));
		assert.equal(await page.evaluate(() => document.documentElement.lang), locale);
		// The page redraws on the next frame after a view arrives.
		await new Promise((r) => setTimeout(r, 150));
	};
	/** The facts every picture must meet: no unfilled placeholder, no sideways scroll, no duplicate id. */
	const sound = async (what: string): Promise<void> => {
		const text = await page.locator("body").innerText();
		assert.doesNotMatch(text, /\{[A-Za-z]+\}/, `${what}: an unfilled placeholder`);
		const facts = await page.evaluate(() => {
			const ids = [...document.querySelectorAll("[id]")].map((e) => e.id);
			return { overflow: document.documentElement.scrollWidth > window.innerWidth + 1, duplicates: ids.filter((id, i) => ids.indexOf(id) !== i) };
		});
		assert.equal(facts.overflow, false, `${what}: the page scrolls sideways`);
		assert.deepEqual(facts.duplicates, [], `${what}: an id repeats`);
	};

	before(async () => {
		assert.ok(existsSync(join(dist, "renderer", "wizard.html")), "run `npm run build` first");
		const electronPath = createRequire(import.meta.url)("electron") as string;
		app = await electron.launch({ executablePath: electronPath, args: [join(import.meta.dirname, "..", "harness", "gallery-main.cjs")], env: { ...process.env, SBD_GALLERY_DIST: dist } as Record<string, string>, timeout: 60_000 });
		page = await app.firstWindow();
	});
	after(async () => {
		await app?.close().catch(() => undefined);
	});

	it("draws each state of the projects step in both languages", async () => {
		const first = wizardView({ locale: "zh-TW", projects: PROJECT_STATES[0]?.[1] as ProjectsView });
		await app.evaluate((_, v) => (globalThis as unknown as { __gallery: { load: (p: string, k: string, v: unknown) => Promise<void> } }).__gallery.load("wizard", "wizard", v), first);
		await page.waitForLoadState("domcontentloaded");
		for (const [name, view] of PROJECT_STATES) {
			for (const locale of LOCALES) {
				await app.evaluate((_, v) => (globalThis as unknown as { __gallery: { push: (k: string, v: unknown) => void } }).__gallery.push("wizard", v), wizardView({ locale, projects: view }));
				await settled(locale);
				assert.equal(await page.evaluate(() => document.body.dataset.step), "projects");
				const cards = await page.locator("li.project-card").count();
				assert.equal(cards, view.rows.length, name);
				await sound(`projects ${name} ${locale}`);
				await shot(`projects-${name}`, locale);
			}
		}
	});

	it("draws each state of the Team recipe card in both languages", async () => {
		const first = settingsView({ locale: "zh-TW", section: "recipe", recipeCard: { active: ACTIVE, state: RECIPE_STATES[0]?.[1] as RecipeCardState, projects: projects([]), enabled: true } });
		await app.evaluate((_, v) => (globalThis as unknown as { __gallery: { load: (p: string, k: string, v: unknown) => Promise<void> } }).__gallery.load("settings", "settings", v), first);
		await page.waitForLoadState("domcontentloaded");
		for (const [name, state, rows] of RECIPE_STATES) {
			for (const locale of LOCALES) {
				const view = settingsView({ locale, section: "recipe", recipeCard: { active: ACTIVE, state, projects: rows ?? projects([done({ folder: "web", label: "Web app" })]), enabled: true } });
				await app.evaluate((_, v) => (globalThis as unknown as { __gallery: { push: (k: string, v: unknown) => void } }).__gallery.push("settings", v), view);
				await settled(locale);
				await page.locator("#recipe-cards").waitFor({ timeout: 10_000 });
				assert.equal(await page.locator('li[data-role="update"]').getAttribute("data-state"), state.phase, name);
				await sound(`recipe ${name} ${locale}`);
				await shot(`recipe-${name}`, locale);
			}
		}
	});
});
