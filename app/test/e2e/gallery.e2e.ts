// The page gallery (task 12): every state of the projects step and of the Team recipe card, drawn by the real pages of the packaged development build through the real shell preload, in zh-TW and in
// English, one picture each (artifact folder `gallery`). The views are scripted (`harness/views.ts`), so each state is there on purpose, not by luck of timing; the real flows (a real clone, a real
// update served by a local server) are `wizard.e2e.ts`'s. The app is started on a scratch data root and sits on its welcome page; the test then opens a second window of its own in the app's main
// process, with the app's shell preload, and answers that window's state calls itself (the app's handlers for those calls are replaced in this throw-away instance). It opens windows, so it runs on
// the CI runners only.
//   SBD_E2E=1 SBD_E2E_KIND=dev node --test test/e2e/gallery.e2e.ts
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { _electron as electron, type ElectronApplication, type Page } from "playwright-core";
import type { ProjectFailure, ProjectRow, ProjectsView } from "../../src/shared/projects.ts";
import type { FetchReason, RecipeCardState, RecipeCardView, RecipeChange } from "../../src/shared/recipe-update.ts";
import type { ForgeView } from "../../src/shared/accounts.ts";
import type { Locale } from "../../src/shared/locale.ts";
import type { UpdatesView } from "../../src/shared/updates.ts";
import { appRoot, locatePackaged, type Packaged } from "../harness/packaged.ts";
import { settingsView, wizardView } from "../harness/views.ts";

const enabled = process.env.SBD_E2E === "1" && process.env.SBD_E2E_KIND !== "release";
const skip = enabled ? false : "opens a real window: runs on the CI runners only (SBD_E2E=1, development kind)";
const packaged: Packaged | undefined = enabled ? locatePackaged("dev") : undefined;
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
	// SA-T12-1: long, unbroken link paths and a long address must wrap inside the card, the warning box and the panel.
	["symlinks-long", projects([done({ folder: "web", label: "Web app with a very long name that goes on", links: { paths: [".agents/skills/a-very-long-skill-folder-name-that-does-not-break-anywhere/and-then-another-nested-folder", ".claude/commands/an-equally-long-command-folder-name-without-any-break-in-it/with-a-file", ".pi/extensions/yet-another-long-extension-folder-name/index", ".agents/a", ".agents/b", ".agents/c", ".agents/d", ".agents/e", ".agents/f", ".agents/g"], more: 4 } })])],
	["trust-held", projects([row({ folder: "web", label: "Web app", phase: "trust" }), row({ folder: "api", label: "Api" })])],
	["clone-network", projects([failed({ kind: "clone", cause: "network" }, { folder: "web", label: "Web app", detail: "fatal: unable to access 'https://github.com/acme/web.git/': Could not resolve host: github.com" })])],
	["clone-network-private", projects([failed({ kind: "clone", cause: "network-private", host: "gitlab.moldplan.app" }, { folder: "web", label: "Web app", host: "gitlab.moldplan.app" })])],
	["queued", projects([row({ folder: "web", label: "Web app", phase: "working", step: "queued" }), row({ folder: "api", label: "Api" })])],
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
const SHA256 = "3f8a1c5e9b2d47f06a1e8c3b5d9f2a4c7e0b6d1a8f3c5e9b2d47f06a1e8c3b5d";
const RECIPE_STATES: Array<[string, RecipeCardState, ProjectsView?]> = [
	["idle", { phase: "idle", checkedAt: NOW }],
	["never-checked", { phase: "idle", checkedAt: null }],
	["checking", { phase: "checking" }],
	["offered", { phase: "offered", origin: "url", id: "team", name: "Team recipe", version: "1.1.0", replaces: false, changes: CHANGES, sha256: SHA256 }],
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
	["error-busy-project", { phase: "error", kind: "busy", detail: "the tools did not stop in time" }, projects([row({ folder: "web", label: "Web app", phase: "working", step: "opening" })])],
	["applying-waits-for-copy", { phase: "applying", step: "install" }, projects([row({ folder: "web", label: "Web app", phase: "working", step: "cloning" })])],
	["offered-branch-default", { phase: "offered", origin: "url", id: "team", name: "Team recipe", version: "1.1.0", replaces: false, changes: [{ kind: "repo-branch", folder: "web", from: null, to: "develop" }, { kind: "repo-label", folder: "web", from: "Web", to: "Web app" }], sha256: SHA256 }],
	["offered-file", { phase: "offered", origin: "file", id: "team", name: "Team recipe", version: "1.1.0", replaces: false, changes: [{ kind: "version", from: "1.0.0", to: "1.1.0" }], sha256: SHA256 }],
	["projects-failed", { phase: "idle", checkedAt: NOW }, projects([failed({ kind: "other-origin" }, { folder: "web", label: "Web app" }), done({ folder: "handbook", label: "Handbook", links: { paths: [".agents/skills"], more: 0 } })])],
];

const UPDATES = (shell: UpdatesView["shell"], stack: UpdatesView["stack"] = { phase: "idle", checkedAt: NOW }): UpdatesView => ({ appVersion: "0.0.1", generation: 7, shell, stack, checking: false, checkedAt: NOW, platform: "win32" });
const UPDATE_STATES: Array<[string, UpdatesView]> = [
	["install-failed", UPDATES({ phase: "ready", version: "0.0.2", installFailed: "No update filepath provided, can't quit and install" })],
	["install-failed-agents-stopped", UPDATES({ phase: "ready", version: "0.0.2", installFailed: "No update filepath provided, can't quit and install", agentsStopped: true })],
	["installer-refused", UPDATES({ phase: "refused", version: "0.0.2", reason: "hash-mismatch" })],
	["stack-rolled-back", UPDATES({ phase: "ready", version: "0.0.2" }, { phase: "rolled-back", generation: 8, stage: "interrupted", category: "other", restored: true, at: NOW })],
];
const forge = (kind: "github" | "gitlab", host: string, flow: ForgeView["flow"], state: ForgeView["state"] = "not-signed-in"): ForgeView => ({ kind, host, state, entries: [], flow });
const FORGE_STATES: Array<[string, ForgeView[]]> = [
	["not-signed-in", [forge("github", "github.com", { phase: "idle" }), forge("gitlab", "gitlab.com", { phase: "idle" })]],
	["ready", [forge("github", "github.com", { phase: "ready" }), forge("gitlab", "gitlab.example.com", { phase: "ready" })]],
];

describe("every state of the projects step and the Team recipe card (gallery)", { skip }, () => {
	let app: ElectronApplication;
	let page: Page;
	let parent = "";

	const shot = async (name: string, locale: Locale): Promise<void> => {
		mkdirSync(screenshotDir, { recursive: true });
		await page.screenshot({ path: join(screenshotDir, `${name}-${locale}.png`), fullPage: true });
	};
	/** SA-T12-1: no card, and nothing inside a card, sticks out past the list that holds it (a long unbroken path used to push the card wider than the panel). */
	const insideList = async (name: string): Promise<void> => {
		const outside = await page.evaluate(() => {
			const out: string[] = [];
			for (const list of document.querySelectorAll("ul.accounts")) {
				const edge = list.getBoundingClientRect().right + 1;
				for (const el of list.querySelectorAll("li, li *")) if (el.getBoundingClientRect().right > edge) out.push(`${el.tagName}.${el.className}`);
			}
			return out;
		});
		assert.deepEqual(outside, [], `${name}: elements past the right edge of their list`);
	};
	/**
	 * SA-T12-6: a path wraps only after a 「/」, never inside a name that would fit on a line of its own. For every character of every `.path-item` the line it sits on is read from its rect; where the line
	 * changes after anything but a slash, the name around that point is measured unbroken, and it must be wider than the paragraph (then there is nowhere else to break it).
	 */
	const pathsBreakAtSeparators = async (name: string): Promise<void> => {
		const bad = await page.evaluate(() => {
			const out: string[] = [];
			for (const item of document.querySelectorAll(".path-item")) {
				const chars: Array<{ ch: string; top: number }> = [];
				const walker = document.createTreeWalker(item, NodeFilter.SHOW_TEXT);
				for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
					const text = node.textContent ?? "";
					for (let i = 0; i < text.length; i++) {
						const range = document.createRange();
						range.setStart(node, i);
						range.setEnd(node, i + 1);
						const rect = range.getClientRects()[0];
						if (rect !== undefined) chars.push({ ch: text.charAt(i), top: Math.round(rect.top) });
					}
				}
				const full = chars.map((c) => c.ch).join("");
				const paragraph = item.closest("p") as HTMLElement;
				for (let i = 1; i < chars.length; i++) {
					if (Math.abs((chars[i] as { top: number }).top - (chars[i - 1] as { top: number }).top) <= 4 || ["/", "-"].includes((chars[i - 1] as { ch: string }).ch)) continue;
					const start = full.lastIndexOf("/", i - 1) + 1;
					const slash = full.indexOf("/", i);
					const segment = full.slice(start, slash === -1 ? full.length : slash + 1);
					const probe = document.createElement("span");
					probe.className = "path-item";
					probe.style.whiteSpace = "nowrap";
					probe.style.position = "absolute";
					probe.style.visibility = "hidden";
					probe.textContent = segment;
					paragraph.appendChild(probe);
					const width = probe.getBoundingClientRect().width;
					probe.remove();
					if (width <= paragraph.clientWidth) out.push(`${full}: broke inside "${segment}" (${Math.round(width)}px fits in ${paragraph.clientWidth}px)`);
				}
			}
			return out;
		});
		assert.deepEqual(bad, [], `${name}: a path broke mid-name`);
	};
	const settled = async (locale: Locale): Promise<void> => {
		const deadline = Date.now() + 10_000;
		while (Date.now() < deadline && (await page.evaluate(() => document.documentElement.lang)) !== locale) await new Promise((r) => setTimeout(r, 50));
		assert.equal(await page.evaluate(() => document.documentElement.lang), locale);
		// The page redraws as soon as a view arrives; a short pause lets the layout settle before the picture.
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
	/** Loads a page in the gallery window with `view`, and returns once it has loaded. */
	const load = (file: "wizard" | "settings", view: unknown): Promise<unknown> =>
		app.evaluate(
			async (_, input: { file: string; view: unknown }) => {
				const g = globalThis as unknown as { __gallery: { state: Record<string, unknown>; win: { loadFile(p: string): Promise<void> }; dist: string } };
				g.__gallery.state[input.file] = input.view;
				g.__gallery.state.locale = (input.view as { locale: string }).locale;
				await g.__gallery.win.loadFile(`${g.__gallery.dist}/renderer/${input.file}.html`);
			},
			{ file, view },
		);
	const push = (file: "wizard" | "settings", view: unknown): Promise<unknown> =>
		app.evaluate(
			(_, input: { file: string; view: unknown }) => {
				const g = globalThis as unknown as { __gallery: { state: Record<string, unknown>; win: { webContents: { send(c: string, v: unknown): void } } } };
				g.__gallery.state[input.file] = input.view;
				g.__gallery.state.locale = (input.view as { locale: string }).locale;
				g.__gallery.win.webContents.send(input.file === "wizard" ? "sbd:wizard-changed" : "sbd:settings-changed", input.view);
			},
			{ file, view },
		);

	before(async () => {
		assert.ok(packaged, "no packaged development build in app/out/dev");
		parent = mkdtempSync(join(tmpdir(), "sbd-gallery-"));
		const env: Record<string, string> = {};
		for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(PI_|HERDR_|ELECTRON_RUN_AS_NODE$)/.test(k)) env[k] = v;
		app = await electron.launch({ executablePath: packaged?.executable, args: ["--lang=en-US"], env: { ...env, STRAW_BOSS_DESK_ROOT: join(parent, "sbd 測試") }, timeout: 90_000 });
		// A window of the test's own, in the app's main process, with the app's shell preload. It opens on the settings page (the app itself sits on its welcome page, so that address is the window's alone).
		const first = settingsView({ locale: "zh-TW", section: "recipe", recipeCard: { active: ACTIVE, state: RECIPE_STATES[0]?.[1] as RecipeCardState, projects: projects([]), enabled: true } });
		await app.evaluate(
			({ app: electronApp, BrowserWindow, ipcMain }, initial: unknown) => {
				const dist = `${electronApp.getAppPath()}/dist`;
				const state: Record<string, unknown> = { wizard: null, settings: initial, locale: "zh-TW" };
				for (const channel of ["sbd:wizard-state", "sbd:settings-state", "sbd:locale", "sbd:wizard-act", "sbd:settings-act"]) ipcMain.removeHandler(channel);
				ipcMain.handle("sbd:wizard-state", () => state.wizard);
				ipcMain.handle("sbd:settings-state", () => state.settings);
				ipcMain.handle("sbd:locale", () => state.locale);
				ipcMain.handle("sbd:wizard-act", () => undefined);
				ipcMain.handle("sbd:settings-act", () => undefined);
				const win = new BrowserWindow({
					width: 1000,
					height: 900,
					show: true,
					webPreferences: { preload: `${dist}/preload/shell.cjs`, sandbox: true, contextIsolation: true, nodeIntegration: false, additionalArguments: ["--sbd-locale=zh-TW", "--sbd-build=dev", "--sbd-product=Gallery"] },
				});
				(globalThis as unknown as { __gallery: unknown }).__gallery = { state, win, dist };
				return win.loadFile(`${dist}/renderer/settings.html`);
			},
			first,
		);
		const deadline = Date.now() + 60_000;
		let found: Page | undefined;
		while (found === undefined && Date.now() < deadline) {
			found = app.windows().find((w) => w.url().endsWith("/renderer/settings.html"));
			if (found === undefined) await new Promise((r) => setTimeout(r, 250));
		}
		assert.ok(found, `the gallery window never opened; windows: ${app.windows().map((w) => w.url()).join(", ")}`);
		page = found;
		await page.waitForLoadState("domcontentloaded");
	});
	after(async () => {
		await app?.close().catch(() => undefined);
		if (parent !== "") rmSync(parent, { recursive: true, force: true });
	});

	it("draws each state of the Team recipe card in both languages", async () => {
		await load("settings", settingsView({ locale: "zh-TW", section: "recipe", recipeCard: { active: ACTIVE, state: RECIPE_STATES[0]?.[1] as RecipeCardState, projects: projects([]), enabled: true } }));
		await page.waitForLoadState("domcontentloaded");
		for (const [name, state, rows] of RECIPE_STATES) {
			for (const locale of LOCALES) {
				await push("settings", settingsView({ locale, section: "recipe", recipeCard: { active: ACTIVE, state, projects: rows ?? projects([done({ folder: "web", label: "Web app" })]), enabled: true } }));
				await settled(locale);
				await page.locator("#recipe-cards").waitFor({ timeout: 10_000 });
				assert.equal(await page.locator('li[data-role="update"]').getAttribute("data-state"), state.phase, name);
				await insideList(`recipe ${name} ${locale}`);
				await pathsBreakAtSeparators(`recipe ${name} ${locale}`);
				await sound(`recipe ${name} ${locale}`);
				await shot(`recipe-${name}`, locale);
			}
		}
	});

	it("draws each state of the projects step in both languages", async () => {
		await load("wizard", wizardView({ locale: "zh-TW", projects: PROJECT_STATES[0]?.[1] as ProjectsView }));
		await page.waitForLoadState("domcontentloaded");
		for (const [name, view] of PROJECT_STATES) {
			for (const locale of LOCALES) {
				await push("wizard", wizardView({ locale, projects: view }));
				await settled(locale);
				assert.equal(await page.evaluate(() => document.body.dataset.step), "projects");
				assert.equal(await page.locator("li.project-card").count(), view.rows.length, name);
				await insideList(`projects ${name} ${locale}`);
				await pathsBreakAtSeparators(`projects ${name} ${locale}`);
				await sound(`projects ${name} ${locale}`);
				await shot(`projects-${name}`, locale);
			}
		}
	});

	it("draws the Updates card after a failed installer start and the Accounts cards of a host that is not signed in, in both languages (carry-ins: one Sign in per host)", async () => {
		await load("settings", settingsView({ locale: "zh-TW", section: "updates", updates: UPDATE_STATES[0]?.[1] as UpdatesView }));
		await page.waitForLoadState("domcontentloaded");
		for (const [name, updates] of UPDATE_STATES) {
			for (const locale of LOCALES) {
				await push("settings", settingsView({ locale, section: "updates", updates }));
				await settled(locale);
				await page.locator("#update-app-note").waitFor({ timeout: 10_000 });
				await sound(`updates ${name} ${locale}`);
				await shot(`updates-${name}`, locale);
			}
		}
		for (const [name, forges] of FORGE_STATES) {
			for (const locale of LOCALES) {
				await push("settings", settingsView({ locale, section: "accounts", forges, claude: { state: "not-signed-in", storage: "keychain", flow: { phase: "idle" } } }));
				await settled(locale);
				await page.locator("#accounts-forges").waitFor({ timeout: 10_000 });
				// One Sign in per host: the header's until the checks pass, then the flow's own.
				const counts = await page.evaluate(() => [...document.querySelectorAll("li.forge-card")].map((card) => card.querySelectorAll(".forge-sign-in-again, [data-role=\"sign-in\"]").length));
				assert.deepEqual(counts, forges.map(() => 1), `accounts ${name} ${locale}: one sign-in button per host`);
				await sound(`accounts ${name} ${locale}`);
				await shot(`accounts-${name}`, locale);
			}
		}
	});
});
