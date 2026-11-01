// Launches the packaged app with Playwright. It opens real windows, so it runs on the CI runners only (SBD_E2E=1) and never as part of `npm test`.
//   SBD_E2E=1 SBD_E2E_KIND=dev|release npm run test:e2e
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { _electron as electron, type ElectronApplication, type Page } from "playwright-core";
import { en } from "../../src/renderer/i18n/en.ts";
import { zhTW } from "../../src/renderer/i18n/zh-TW.ts";
import { appRoot, locatePackaged, type Packaged } from "../harness/packaged.ts";

const kind = process.env.SBD_E2E_KIND === "release" ? "release" : "dev";
const enabled = process.env.SBD_E2E === "1";
const skip = enabled ? false : "opens real windows: runs on the CI runners only (SBD_E2E=1)";
const packaged: Packaged | undefined = enabled ? locatePackaged(kind) : undefined;
const screenshotDir = process.env.SBD_SCREENSHOT_DIR ?? join(appRoot, "test-results", "screenshots");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const cleanEnv = (extra: Record<string, string>): Record<string, string> => {
	const env: Record<string, string> = {};
	for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(PI_|HERDR_|ELECTRON_RUN_AS_NODE$)/.test(k)) env[k] = v;
	return { ...env, ...extra };
};

/** A data root with a space and CJK characters, the quoting trap the spec wants both platforms to meet from day one. */
function makeRoot(): { parent: string; root: string } {
	const parent = mkdtempSync(join(tmpdir(), "sbd-e2e-"));
	return { parent, root: join(parent, "sbd 測試") };
}

async function shellPage(app: ElectronApplication): Promise<Page> {
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		const page = app.windows().find((w) => w.url().endsWith("welcome.html"));
		if (page) { await page.waitForLoadState("domcontentloaded"); return page; }
		await sleep(250);
	}
	throw new Error(`the shell page never opened; windows: ${app.windows().map((w) => w.url()).join(", ")}`);
}

const launch = (root: string, args: string[] = []) => electron.launch({
	executablePath: packaged?.executable,
	args,
	env: cleanEnv({ STRAW_BOSS_DESK_ROOT: root }),
	timeout: 90_000,
});

const shot = async (page: Page, name: string) => {
	mkdirSync(screenshotDir, { recursive: true });
	await page.screenshot({ path: join(screenshotDir, `${name}-${kind}.png`) });
};

describe(`packaged ${kind} app`, { skip }, () => {
	assert.ok(!enabled || packaged, `no packaged ${kind} build in app/out/${kind}`);
	const { parent, root } = makeRoot();
	let app: ElectronApplication;
	let page: Page;
	const pageErrors: string[] = [];

	before(async () => {
		app = await launch(root, ["--lang=en-US"]);
		page = await shellPage(app);
		page.on("pageerror", (e) => pageErrors.push(String(e)));
	});

	after(async () => {
		await app?.close().catch(() => {});
		rmSync(parent, { recursive: true, force: true });
	});

	it(`reports the product name of the ${kind} build and keeps Chromium's profile inside the data root`, async () => {
		const name = await app.evaluate(({ app: a }) => a.getName());
		assert.equal(name, kind === "release" ? "Straw Boss Desk" : "Straw Boss Desk Dev");
		const userData = await app.evaluate(({ app: a }) => a.getPath("userData"));
		assert.equal(userData, join(root, "electron"));
		await sleep(1000);
		assert.ok(existsSync(join(root, "electron")) && readdirSync(join(root, "electron")).length > 0, "Chromium wrote nothing under <root>/electron");
	});

	it("has one window holding the GUI view and the shell view", async () => {
		const shape = await app.evaluate(({ BaseWindow }) => {
			const windows = BaseWindow.getAllWindows();
			return { windows: windows.length, views: windows[0]?.contentView.children.length ?? 0 };
		});
		assert.deepEqual(shape, { windows: 1, views: 2 });
	});

	it("opens on the welcome screen in the OS language and switches language", async () => {
		assert.equal(await page.locator("h1").innerText(), en.welcome.title);
		assert.equal(await page.locator("html").getAttribute("lang"), "en");
		assert.equal(await page.locator("button[data-locale='en']").getAttribute("aria-pressed"), "true");
		await shot(page, "welcome-en");

		await page.locator("button[data-locale='zh-TW']").click();
		assert.equal(await page.locator("h1").innerText(), zhTW.welcome.title);
		assert.equal(await page.locator("html").getAttribute("lang"), "zh-TW");
		assert.equal(await page.title(), zhTW.app.name);
		assert.equal(await page.locator("button[data-locale='zh-TW']").getAttribute("aria-pressed"), "true");
		await shot(page, "welcome-zh-TW");

		await page.locator("button[data-locale='en']").click();
		assert.equal(await page.locator("h1").innerText(), en.welcome.title);
	});

	it("shows the development badge only in a development build", async () => {
		assert.equal(await page.locator("#dev-badge").isVisible(), kind === "dev");
	});

	it("gives the page a bridge without Node, and a strict CSP", async () => {
		const seen = await page.evaluate(() => ({
			build: window.sbdShell?.build,
			product: window.sbdShell?.productName,
			require: typeof (window as unknown as { require?: unknown }).require,
			process: typeof (window as unknown as { process?: unknown }).process,
		}));
		assert.deepEqual(seen, { build: kind, product: kind === "release" ? "Straw Boss Desk" : "Straw Boss Desk Dev", require: "undefined", process: "undefined" });
		const csp = await page.locator("meta[http-equiv='Content-Security-Policy']").getAttribute("content");
		assert.match(csp ?? "", /default-src 'none'/);
		assert.deepEqual(pageErrors, []);
	});

	it("runs no infinite animation under reduced motion, and has one without it", async () => {
		const running = () => page.evaluate(() => document.getAnimations().filter((a) => a.playState === "running" && a.effect?.getComputedTiming().iterations === Infinity).length);
		await page.emulateMedia({ reducedMotion: "no-preference" });
		assert.ok((await running()) >= 1, "the welcome screen should pulse when motion is allowed");
		await page.emulateMedia({ reducedMotion: "reduce" });
		assert.equal(await running(), 0);
		await page.emulateMedia({ reducedMotion: null });
	});

	it("lets a second launch hand over to the running instance and exit", async () => {
		const child = spawn(packaged!.executable, [], { env: cleanEnv({ STRAW_BOSS_DESK_ROOT: root }), stdio: "ignore" });
		const code = await new Promise<number | null>((resolve) => {
			const timer = setTimeout(() => { child.kill(); resolve(-1); }, 30_000);
			child.on("exit", (c) => { clearTimeout(timer); resolve(c); });
		});
		assert.equal(code, 0, "the second instance should exit 0 on its own");
		const windows = await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows().length);
		assert.equal(windows, 1);
	});
});

describe(`packaged ${kind} app, Traditional Chinese system`, { skip }, () => {
	const { parent, root } = makeRoot();
	let app: ElectronApplication;

	before(async () => { app = await launch(root, ["--lang=zh-TW"]); });
	after(async () => {
		await app?.close().catch(() => {});
		rmSync(parent, { recursive: true, force: true });
	});

	it("opens on the welcome screen in zh-TW", async () => {
		const page = await shellPage(app);
		assert.equal(await page.locator("h1").innerText(), zhTW.welcome.title);
		assert.equal(await page.locator("html").getAttribute("lang"), "zh-TW");
		await shot(page, "welcome-os-zh-TW");
	});
});
