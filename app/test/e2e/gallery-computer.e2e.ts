// The Computer and Diagnostics gallery (task 14): every state of **Remove all data** (the button, the confirmation with and without entries that stay, the refusal, each step of the work, the stop that
// could not finish, the failure, the result with a foreign entry left and with steps that failed) and of the four Diagnostics cards, drawn by the real pages of the packaged development build through
// the real shell preload, in zh-TW and English, one picture each (artifact folder `gallery`, files `computer-*` and `diagnostics-*`). The views are scripted, so each state is there on purpose; the
// real removal, with a real store and a real folder, is `removal.e2e.ts`'s. Same window as `gallery.e2e.ts`: a second window of the test's own in the app's main process, answering its own state calls.
//   SBD_E2E=1 SBD_E2E_KIND=dev node --test test/e2e/gallery-computer.e2e.ts
// The failure of a pending removal at the next launch is a native error box (`dialog.showErrorBox`), which a page screenshot cannot take; its words are the catalog's `pending` group, which the
// locale parity tests and `pending-dialog` in `shell-pages.test.ts` cover.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { _electron as electron, type ElectronApplication, type Page } from "playwright-core";
import type { ComputerView, DiagnosticsView, LeftEntry, RemoveState, RemoveStep } from "../../src/shared/computer.ts";
import type { Locale } from "../../src/shared/locale.ts";
import { loadGalleryFile } from "../harness/gallery-load.ts";
import { appRoot, locatePackaged, type Packaged } from "../harness/packaged.ts";
import { shotWhole } from "../harness/shot-whole.ts";
import { settingsView } from "../harness/views.ts";

const enabled = process.env.SBD_E2E === "1" && process.env.SBD_E2E_KIND !== "release";
const skip = enabled ? false : "opens a real window: runs on the CI runners only (SBD_E2E=1, development kind)";
const packaged: Packaged | undefined = enabled ? locatePackaged("dev") : undefined;
const screenshotDir = join(process.env.SBD_SCREENSHOT_DIR ?? join(appRoot, "test-results", "screenshots"), "gallery");
const LOCALES: readonly Locale[] = ["zh-TW", "en"];
const isWin = process.platform === "win32";
/** The height of a PNG, read from its IHDR chunk. */
const PNG_HEIGHT = (file: string): number => readFileSync(file).readUInt32BE(20);

const ROOT = isWin ? "C:\\Users\\pm\\AppData\\Local\\Straw Boss Desk" : "/Users/pm/Library/Application Support/Straw Boss Desk";
const WORK = isWin ? "C:\\Users\\pm\\Straw Boss" : "/Users/pm/Straw Boss";
const LEFT: LeftEntry[] = [
	{ name: "gh:github.com", account: "pm", host: "github.com", why: "foreign" },
	{ name: "glab:gitlab.example.com:token", account: "", host: "gitlab.example.com", why: "changed" },
];
const PLAN = { root: ROOT, bytes: 2_254_857_830, workFolder: WORK, left: [] as LeftEntry[], pathEntry: isWin ? `${ROOT}\\tools\\shims` : null };
const STEPS: RemoveStep[] = ["stopping", "logins", "claude", "linear", "path", "safe-storage", "files"];

const REMOVE_STATES: Array<[string, RemoveState]> = [
	["idle", { phase: "idle" }],
	["planning", { phase: "planning" }],
	["confirm", { phase: "confirm", plan: PLAN }],
	["confirm-left", { phase: "confirm", plan: { ...PLAN, left: LEFT } }],
	["confirm-beside", { phase: "confirm", plan: { ...PLAN, left: [{ name: "glab:gitlab.com:token", account: "", host: "gitlab.com", why: "beside" }, { name: "glab:gitlab.com", account: "someone", host: "gitlab.com", why: "foreign" }] } }],
	["confirm-no-folder", { phase: "confirm", plan: { ...PLAN, workFolder: null, bytes: null } }],
	["refused-store", { phase: "refused", reason: "store", detail: "security: SecKeychainSearchCopyNext: User interaction is not allowed." }],
	...STEPS.map((step): [string, RemoveState] => [`working-${step}`, { phase: "working", step }]),
	["stop-failed", { phase: "stop-failed", leftovers: [{ pid: 4242, file: `${ROOT}${isWin ? "\\" : "/"}tools${isWin ? "\\" : "/"}node${isWin ? "\\" : "/"}24.22.1${isWin ? "\\" : "/"}node` }, { pid: 4310, file: "pi" }], detail: "" }],
	["busy", { phase: "busy" }],
	["failed", { phase: "failed", detail: "the data root is, or contains, the home folder" }],
	["done", { phase: "done", result: { root: ROOT, workFolder: WORK, left: [], problems: [] } }],
	["done-left", { phase: "done", result: { root: ROOT, workFolder: WORK, left: LEFT, problems: [] } }],
	["done-beside", { phase: "done", result: { root: ROOT, workFolder: WORK, left: [{ name: "glab:gitlab.com:token", account: "", host: "gitlab.com", why: "beside" }, { name: "glab:gitlab.com", account: "someone", host: "gitlab.com", why: "foreign" }], problems: [] } }],
	["done-problems", { phase: "done", result: { root: ROOT, workFolder: null, left: LEFT.slice(0, 1), problems: [{ step: "logins", detail: "gitlab.example.com: glab exited 1" }, { step: "files", detail: "tools: EBUSY: resource busy or locked" }] } }],
	// SA-T14-6: the sentence that sends the PM to the guide, with no entry that stays: the guide's button is under it.
	["done-problems-no-left", { phase: "done", result: { root: ROOT, workFolder: WORK, left: [], problems: [{ step: "logins", detail: "gitlab.example.com: glab exited 1" }, { step: "path", detail: "" }] } }],
	["done-problems-files", { phase: "done", result: { root: ROOT, workFolder: WORK, left: [], problems: [{ step: "files", detail: "electron: EBUSY: resource busy or locked" }] } }],
];

const diag = (over: Partial<DiagnosticsView> = {}): DiagnosticsView => ({ status: { phase: "idle" }, collect: { phase: "idle" }, repair: { phase: "idle" }, logsDir: `${ROOT}${isWin ? "\\" : "/"}logs`, wslBash: null, ...over });
const FIELDS = { state: "live", primary: true, desk: true, version: "0.59.0", keys: ["url", "token"] };
const DIAG_STATES: Array<[string, DiagnosticsView]> = [
	["idle", diag()],
	["status-reading", diag({ status: { phase: "reading" } })],
	["status-ok", diag({ status: { phase: "ok", fields: FIELDS, at: "2026-11-05T10:00:00.000Z" } })],
	["status-not-installed", diag({ status: { phase: "failed", reason: "not-installed", detail: "" } })],
	["status-package", diag({ status: { phase: "failed", reason: "package", detail: "" } })],
	["status-busy", diag({ status: { phase: "failed", reason: "busy", detail: "" } })],
	["status-failed", diag({ status: { phase: "failed", reason: "failed", detail: "no answer within 60 s" } })],
	["collect-working", diag({ collect: { phase: "working" } })],
	["collect-done", diag({ collect: { phase: "done", file: `${isWin ? "C:\\Users\\pm\\Downloads\\" : "/Users/pm/Downloads/"}straw-boss-diagnostics-20261105-143012.zip`, files: 41, skipped: 0 } })],
	["collect-done-skipped", diag({ collect: { phase: "done", file: `${isWin ? "C:\\Users\\pm\\Downloads\\" : "/Users/pm/Downloads/"}straw-boss-diagnostics-20261105-143012.zip`, files: 38, skipped: 3 } })],
	["collect-failed", diag({ collect: { phase: "failed", detail: "ENOSPC: no space left on device" } })],
	["repair-working", diag({ repair: { phase: "working" } })],
	["repair-done", diag({ repair: { phase: "done" } })],
	["repair-failed", diag({ repair: { phase: "failed", detail: "stage pkg:pi-lens failed: registry unreachable" } })],
	["wsl", diag({ wslBash: "C:\\Windows\\System32\\bash.exe" })],
];

describe("every state of Remove all data and of Diagnostics (gallery)", { skip }, () => {
	let app: ElectronApplication;
	let page: Page;
	let parent = "";

	const shot = async (name: string, locale: Locale): Promise<void> => {
		mkdirSync(screenshotDir, { recursive: true });
		await shotWhole(page, join(screenshotDir, `${name}-${locale}.png`));
	};
	const settled = async (locale: Locale): Promise<void> => {
		const deadline = Date.now() + 10_000;
		while (Date.now() < deadline && (await page.evaluate(() => document.documentElement.lang)) !== locale) await new Promise((r) => setTimeout(r, 50));
		assert.equal(await page.evaluate(() => document.documentElement.lang), locale);
		await new Promise((r) => setTimeout(r, 150));
	};
	/** The shot holds the panel's last button, however long the panel is (T14-F010): the whole page was taken, not the window. */
	const belowTheFold = async (name: string, locale: Locale, state: RemoveState): Promise<void> => {
		const last = state.phase === "confirm" ? "#remove-cancel" : state.phase === "done" ? "#remove-quit" : null;
		if (last === null) return;
		const png = join(screenshotDir, `computer-${name}-${locale}.png`);
		const { bottom, ratio } = await page.evaluate((sel) => ({ bottom: document.querySelector(sel)?.getBoundingClientRect().bottom ?? 0, ratio: window.devicePixelRatio }), last);
		assert.ok(bottom > 0, `${name} ${locale}: ${last} is on the page`);
		const height = PNG_HEIGHT(png);
		assert.ok(height >= Math.floor((bottom - 2) * ratio), `${name} ${locale}: the picture is ${height}px high, and ${last} ends at ${Math.round(bottom * ratio)}px`);
	};
	/** No unfilled placeholder, no sideways scroll, no duplicate id, nothing past the right edge of the panel. */
	const sound = async (what: string): Promise<void> => {
		const text = await page.locator("body").innerText();
		assert.doesNotMatch(text, /\{[A-Za-z]+\}/, `${what}: an unfilled placeholder`);
		const facts = await page.evaluate(() => {
			const ids = [...document.querySelectorAll("[id]")].map((e) => e.id);
			const panel = document.querySelector("main") ?? document.body;
			const edge = panel.getBoundingClientRect().right + 1;
			const out: string[] = [];
			for (const el of panel.querySelectorAll("*")) if (el.getBoundingClientRect().right > edge) out.push(`${el.tagName}.${el.className}`);
			return { overflow: document.documentElement.scrollWidth > window.innerWidth + 1, duplicates: ids.filter((id, i) => ids.indexOf(id) !== i), past: out };
		});
		assert.equal(facts.overflow, false, `${what}: the page scrolls sideways`);
		assert.deepEqual(facts.duplicates, [], `${what}: an id repeats`);
		assert.deepEqual(facts.past, [], `${what}: elements past the right edge`);
	};
	const computerView = (locale: Locale, remove: RemoveState): ReturnType<typeof settingsView> => {
		const computer: ComputerView = { platform: isWin ? "win32" : "darwin", keepAwake: true, remove };
		return settingsView({ locale, section: "computer", computer });
	};
	const load = (view: unknown): Promise<void> => loadGalleryFile(app, page, "settings", view);
	const push = (view: unknown): Promise<unknown> =>
		app.evaluate(
			(_, input: { view: unknown }) => {
				const g = globalThis as unknown as { __gallery: { state: Record<string, unknown>; win: { webContents: { send(c: string, v: unknown): void } } } };
				g.__gallery.state.settings = input.view;
				g.__gallery.state.locale = (input.view as { locale: string }).locale;
				g.__gallery.win.webContents.send("sbd:settings-changed", input.view);
			},
			{ view },
		);

	before(async () => {
		assert.ok(packaged, "no packaged development build in app/out/dev");
		parent = mkdtempSync(join(tmpdir(), "sbd-gallery-c-"));
		const env: Record<string, string> = {};
		for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(PI_|HERDR_|ELECTRON_RUN_AS_NODE$)/.test(k)) env[k] = v;
		app = await electron.launch({ executablePath: packaged?.executable, args: ["--lang=en-US"], env: { ...env, STRAW_BOSS_DESK_ROOT: join(parent, "sbd 測試") }, timeout: 90_000 });
		const first = computerView("zh-TW", { phase: "idle" });
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

	it("draws each state of Remove all data in both languages", async () => {
		await load(computerView("zh-TW", { phase: "idle" }));
		await page.waitForLoadState("domcontentloaded");
		for (const [name, state] of REMOVE_STATES) {
			for (const locale of LOCALES) {
				await push(computerView(locale, state));
				await settled(locale);
				await page.locator("#remove-panel").waitFor({ timeout: 10_000 });
				assert.equal(await page.locator("#remove-panel").getAttribute("data-state"), state.phase, name);
				await sound(`remove ${name} ${locale}`);
				await shot(`computer-${name}`, locale);
				await belowTheFold(name, locale, state);
				// The sentence that points to the guide has the guide's button in its own box, and the screen has one such button (SA-T14-6).
				if (state.phase === "done" && state.result.problems.some((p) => p.step !== "files")) {
					assert.equal(await page.locator("#remove-problems #remove-guide-problems").count(), 1, `${name} ${locale}: the guide's button sits with its sentence`);
					assert.equal(await page.locator('[id^="remove-guide"]').count(), 1, `${name} ${locale}: one guide button on the screen`);
				}
			}
		}
	});

	it("names the entries that stay on the confirmation and in the result, in both languages", async () => {
		for (const locale of LOCALES) {
			await push(computerView(locale, { phase: "confirm", plan: { ...PLAN, left: LEFT } }));
			await settled(locale);
			assert.deepEqual(await page.locator('#remove-confirm-panel [data-role="leaves"] li').evaluateAll((els) => els.map((e) => [e.getAttribute("data-entry"), e.getAttribute("data-why")])), [["gh:github.com", "foreign"], ["glab:gitlab.example.com:token", "changed"]]);
			await push(computerView(locale, { phase: "done", result: { root: ROOT, workFolder: WORK, left: LEFT, problems: [] } }));
			await settled(locale);
			assert.equal(await page.locator("#remove-left li").count(), 2);
			assert.equal(await page.locator("#remove-quit").count(), 1);
			// While the root is deleted nothing may offer to save a setting in it.
			assert.equal(await page.locator(".language-button").count(), 0);
			assert.equal(await page.locator("#keep-awake").isDisabled(), true);
		}
	});

	it("draws each state of Diagnostics in both languages", async () => {
		await load(settingsView({ locale: "zh-TW", section: "diagnostics", diagnostics: DIAG_STATES[0]?.[1] as DiagnosticsView }));
		await page.waitForLoadState("domcontentloaded");
		for (const [name, view] of DIAG_STATES) {
			for (const locale of LOCALES) {
				await push(settingsView({ locale, section: "diagnostics", diagnostics: view }));
				await settled(locale);
				await page.locator("#diag-cards").waitFor({ timeout: 10_000 });
				assert.equal(await page.locator("li.update-card").count(), 4, name);
				await sound(`diagnostics ${name} ${locale}`);
				await shot(`diagnostics-${name}`, locale);
			}
		}
	});
});
