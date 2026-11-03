// The task 9 anchor (`wizard-from-zero.yml`, first form): the packaged app's wizard from an empty data root to the GUI with every sign-in put off (Later). On a GitHub-hosted runner only.
//   - an invalid recipe is refused with its field and rule and without a value;
//   - a quit in the middle of the install and a relaunch open on the install step and finish it;
//   - with the WSL check stubbed to report (`SBD_TEST_WSL_BASH`, development build), the welcome screen has its line and the banner shows its sentence over the GUI at start, in both languages;
//   - a quit in the middle of the install leaves no process under <root>/tools (the engine is cancelled, not killed and forked again);
//   - a quit inside a package stage (while pi's `pi install` runs) leaves that stage `running`, so a start would be refused; a program left running under <root>/tools (a stand-in for the npm that
//     pi started) makes the relaunch's package stage wait for it, and the install then finishes (R9-F001, R9-F002);
//   - the language chosen on the last wizard step is the one the banner over the GUI is worded in, and the one the settings page changes;
//   - a later launch opens no wizard and reaches the GUI (the design says 30 s; the assertion allows 45 s, see the Build note on task 9), and a launch that cannot start shows the failure screen;
//   - a second, short run in English up to the trust screen, and a reduced-motion pass.
//   SBD_E2E=1 SBD_E2E_KIND=dev node --test test/e2e/wizard.e2e.ts        (a GitHub-hosted runner only; the six-signal check refuses anywhere else)
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, constants, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { _electron as electron, type ElectronApplication, type Page } from "playwright-core";
import { en } from "../../src/renderer/i18n/en.ts";
import { zhTW } from "../../src/renderer/i18n/zh-TW.ts";
import { readInstalled, isInstalled } from "../../src/main/runtime/readiness.ts";
import { appRoot, locatePackaged, type Packaged } from "../harness/packaged.ts";
import { statusSummary } from "../harness/status-summary.ts";
import { relaunchNotice } from "../harness/relaunch-time.ts";
import { createPlatform } from "../../src/main/platform/index.ts";
import { childEnvOf, createWorld, disposeWorld, isWindows, noteUserPath, run, seedDownloads, type World } from "../harness/e2e-light.ts";
import { assertElevatedRunner } from "../harness/elevation.ts";
import { developerToolsAsideScope } from "../harness/devtools-aside.ts";
import { hostedCase, type FixtureIO } from "../harness/hosted.ts";

const kind = process.env.SBD_E2E_KIND === "release" ? "release" : "dev";
const enabled = process.env.SBD_E2E === "1";
const hosted = hostedCase("the wizard from zero (task 9)");
// The wizard is the same in both builds, the WSL stub exists only in the development build, and each run installs a whole root: the development build carries it.
const skip = !enabled ? "opens real windows and installs a real stack: runs on the CI runners only (SBD_E2E=1)" : kind !== "dev" ? "the wizard is exercised by the development build" : hosted.run ? false : hosted.reason;
const packaged: Packaged | undefined = enabled && kind === "dev" ? locatePackaged(kind) : undefined;
const screenshotDir = process.env.SBD_SCREENSHOT_DIR ?? join(appRoot, "test-results", "screenshots");

if (enabled && kind === "dev" && !hosted.run && hosted.fail) {
	it("runs on a hosted runner", () => {
		assert.fail(`${hosted.reason} (SBD_REQUIRE_HOSTED_FIXTURES=1)`);
	});
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until<T>(what: string, ms: number, probe: () => T | Promise<T>, every = 400): Promise<NonNullable<T>> {
	const deadline = Date.now() + ms;
	let last: unknown;
	while (Date.now() < deadline) {
		try {
			const value = await probe();
			if (value) return value as NonNullable<T>;
		} catch (error) {
			last = error;
		}
		await sleep(every);
	}
	throw new Error(`timed out after ${ms / 1000} s waiting for ${what}${last ? `: ${(last as Error).message}` : ""}`);
}

const exampleDir = fileURLToPath(new URL("../../../recipe/examples/invalid/", import.meta.url));
const ciRecipe = fileURLToPath(new URL("../fixtures/ci.strawboss.json", import.meta.url));
const PLANTED = "LEAKCHECK123";
/** A path that is a WSL launcher on Windows and only a name on macOS, where nothing runs it. */
const WSL_BASH = isWindows ? "C:\\Windows\\System32\\bash.exe" : "/mnt/wsl/bash.exe";

/** The developer-tools fixture runs its commands through this (a PATH of system folders only); a guarded fixture, hosted macOS only. */
const ioForSudo: FixtureIO = {
	run: (command, args, options) => run(command, args, { env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" }, timeoutMs: options?.timeoutMs ?? 60_000 }),
	writeFile: (path, data) => writeFileSync(path, data),
	removeFile: () => {},
};

const shot = async (page: Page, name: string): Promise<void> => {
	mkdirSync(screenshotDir, { recursive: true });
	await page.screenshot({ path: join(screenshotDir, `${name}.png`) });
};

/** The wizard page's current state in zh-TW, then in English (the language buttons), and back; the PM sees both, so a reviewer should too. */
const shotBoth = async (page: Page, name: string): Promise<void> => {
	const heading = () => page.evaluate(() => document.documentElement.lang);
	if ((await heading()) !== "zh-TW") await page.locator('.language-button[data-locale="zh-TW"]').click();
	await until("zh-TW", 10_000, async () => (await heading()) === "zh-TW", 100);
	await shot(page, `${name}-zh-TW`);
	await page.locator('.language-button[data-locale="en"]').click();
	await until("en", 10_000, async () => (await heading()) === "en", 100);
	await shot(page, `${name}-en`);
	await page.locator('.language-button[data-locale="zh-TW"]').click();
	await until("zh-TW again", 10_000, async () => (await heading()) === "zh-TW", 100);
};

describe("the wizard from zero to the GUI (e2e, task 9)", { skip }, () => {
	assert.ok(!enabled || kind !== "dev" || packaged, "no packaged development build in app/out/dev");
	let world: World;
	const apps: ElectronApplication[] = [];
	// macOS: the Xcode tools are moved aside for the whole run, so a call into `/usr/bin/git`'s stub would fail loudly (spec: Fixtures that change the machine).
	const aside = developerToolsAsideScope();

	const env = (extra: Record<string, string> = {}): Record<string, string> => {
		const base: Record<string, string> = {};
		for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(PI_|HERDR_|ELECTRON_RUN_AS_NODE$)/.test(k)) base[k] = v;
		// macOS: no STRAW_BOSS_DESK_ROOT, so the app takes its default root, `<home>/Library/Application Support/straw-boss-desk`, under the scratch home. Windows: the root named in the spec.
		return { ...base, ...world.appEnv, ...(isWindows ? { STRAW_BOSS_DESK_ROOT: world.root } : {}), ...extra };
	};
	const launch = async (lang: string, extra: Record<string, string> = {}): Promise<ElectronApplication> => {
		const app = await electron.launch({ executablePath: packaged?.executable, args: [`--lang=${lang}`], env: env(extra), timeout: 60_000 });
		apps.push(app);
		return app;
	};
	const pageOf = async (app: ElectronApplication, file: "wizard.html" | "screen.html" | "settings.html"): Promise<Page> => {
		const page = await until(`the ${file} page`, 60_000, () => app.windows().find((w) => w.url().endsWith(file)), 250);
		await page.waitForLoadState("domcontentloaded");
		return page;
	};
	const stepOf = (page: Page): Promise<string> => page.evaluate(() => document.body.dataset.step ?? "");
	const waitStep = (page: Page, step: string, ms = 60_000) => until(`the ${step} step`, ms, async () => (await stepOf(page)) === step, 200);
	const guiUrl = (app: ElectronApplication): Promise<string | undefined> => app.evaluate(({ webContents }) => webContents.getAllWebContents().map((w) => w.getURL()).find((u) => /^http:\/\/127\.0\.0\.1:\d+\//.test(u)));
	const inGui = (app: ElectronApplication, source: string): Promise<unknown> =>
		app.evaluate(({ webContents }, code) => webContents.getAllWebContents().find((w) => /^http:\/\/127\.0\.0\.1:\d+\//.test(w.getURL()))?.executeJavaScript(code, true), source);
	const stubDialog = (app: ElectronApplication, file: string) =>
		app.evaluate(({ dialog }, f) => {
			dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [f] })) as unknown as typeof dialog.showOpenDialog;
		}, file);
	const wizardFile = () => join(world.layout.state, "wizard.json");
	const readWizard = () => JSON.parse(readFileSync(wizardFile(), "utf8")) as { step: string; done: boolean; locale?: string; workFolder?: string; later: Array<{ item: string; host?: string }> };
	const logText = (): string => {
		if (!existsSync(world.layout.logs)) return "";
		return readdirSync(world.layout.logs).map((f) => readFileSync(join(world.layout.logs, f), "utf8")).join("\n");
	};
	const close = async (app: ElectronApplication) => {
		await app.close().catch(() => undefined);
	};

	before(async () => {
		assertElevatedRunner();
		if (aside.state === "refused") throw new Error(aside.reason);
		if (aside.state === "active") await aside.enter(ioForSudo);
		world = createWorld("wiz");
		await noteUserPath(world);
		// The CI cache holds the pinned downloads; the engine hashes every file it finds there, so a bad one is replaced, not trusted.
		seedDownloads(world);
	});

	after(async () => {
		for (const app of apps) await close(app);
		await disposeWorld(world);
		if (aside.state === "active") await aside.leave(ioForSudo);
	});

	let first: ElectronApplication;
	let page: Page;

	it("opens on the welcome screen in zh-TW from an empty root, with no WSL line", async () => {
		assert.deepEqual(["wizard.json", "bootstrap.json", "current.json"].filter((f) => existsSync(join(world.layout.state, f))), [], "the root starts with no wizard or install record");
		first = await launch("zh-TW");
		page = await pageOf(first, "wizard.html");
		await waitStep(page, "welcome");
		assert.equal(await page.locator("h1").innerText(), zhTW.welcome.title);
		assert.equal(await page.locator("#finding-wsl").count(), 0);
		await shotBoth(page, "wizard-welcome");
	});

	it("shows the WSL line on the welcome screen, in both languages, once the check reports it", async () => {
		await first.evaluate((_, bash) => void (process.env.SBD_TEST_WSL_BASH = bash), WSL_BASH);
		await page.locator("#welcome-rescan").click();
		await page.locator("#finding-wsl").waitFor({ timeout: 30_000 });
		assert.equal(await page.locator("#finding-wsl p").first().innerText(), zhTW.welcome.wsl);
		await shot(page, "wizard-welcome-wsl-zh-TW");
		await page.locator('.language-button[data-locale="en"]').click();
		await until("the English line", 10_000, async () => (await page.locator("#finding-wsl p").first().innerText()) === en.welcome.wsl);
		await shot(page, "wizard-welcome-wsl-en");
		await page.locator('.language-button[data-locale="zh-TW"]').click();
		await until("the zh-TW line", 10_000, async () => (await page.locator("#finding-wsl p").first().innerText()) === zhTW.welcome.wsl);
	});

	it("refuses an invalid recipe with its field and rule and no value, and writes nothing", async () => {
		await page.locator("#welcome-next").click();
		await waitStep(page, "recipe");
		await shotBoth(page, "wizard-recipe");
		// The drop zone is a button: focus and Enter open the file dialog, as Choose does (T9-F004).
		await stubDialog(first, join(exampleDir, "url-scheme.strawboss.json"));
		await page.locator("#recipe-drop").focus();
		await page.keyboard.press("Enter");
		await page.locator("#recipe-refused").waitFor({ timeout: 15_000 });
		for (const [file, rule] of [["secret-pattern.strawboss.json", "secret-pattern"], ["url-scheme.strawboss.json", "url-scheme"]] as const) {
			await stubDialog(first, join(exampleDir, file));
			await page.locator("#recipe-choose").click();
			await page.locator("#recipe-refused").waitFor({ timeout: 15_000 });
			const rules = await page.locator("#recipe-refused td.rule").allInnerTexts();
			const fields = await page.locator("#recipe-refused td.field").allInnerTexts();
			assert.ok(rules.includes(rule), `${file}: ${rules.join(",")}`);
			assert.ok(fields.every((f) => f !== ""), "every refusal names its field");
			assert.equal((await page.locator("body").innerText()).includes(PLANTED), false, "the planted value is not on the page");
			assert.equal(await stepOf(page), "recipe");
		}
		assert.deepEqual(await page.locator("#recipe-refused th").allInnerTexts(), [zhTW.recipe.field, zhTW.recipe.rule, zhTW.recipe.explanation], "every column has a header");
		await shotBoth(page, "wizard-recipe-refused");
		assert.equal(logText().includes(PLANTED), false, "no log holds the planted value");
		const saved = existsSync(world.layout.recipe) ? readdirSync(world.layout.recipe) : [];
		assert.deepEqual(saved, [], "nothing is written to the recipe folder");
	});

	it("shows the CI recipe on the trust screen before writing anything, and the default work folder", async () => {
		await stubDialog(first, ciRecipe);
		await page.locator("#recipe-choose").click();
		await waitStep(page, "trust");
		const text = await page.locator("#trust-list").innerText();
		for (const part of ["CI 測試團隊", "gitlab.com", "github.com", "octocat/Hello-World"]) assert.ok(text.includes(part), `the trust list names ${part}`);
		await shotBoth(page, "wizard-trust");
		assert.deepEqual(existsSync(world.layout.recipe) ? readdirSync(world.layout.recipe) : [], [], "nothing is written before Apply");
		await page.locator("#trust-apply").click();
		await waitStep(page, "folder");
		assert.ok(readdirSync(world.layout.recipe).length === 1, "Apply saved the recipe");
		assert.equal(await page.locator("#folder-path").innerText(), join(world.home, "StrawBoss"));
		await shotBoth(page, "wizard-folder");
		await page.locator("#folder-next").click();
		await waitStep(page, "install", 30_000);
	});

	it("runs a spinner on the install step and none under reduced motion", async () => {
		const infinite = () => page.evaluate(() => document.getAnimations().filter((a) => a.playState === "running" && a.effect?.getComputedTiming().iterations === Infinity).length);
		await until("a working stage with its spinner", 120_000, async () => (await page.locator("#install-stages li[data-badge='working']").count()) > 0 || undefined, 200);
		assert.ok((await infinite()) >= 1, "the working spinner animates");
		await page.emulateMedia({ reducedMotion: "reduce" });
		assert.equal(await infinite(), 0, "no infinite animation runs under reduced motion");
		await page.emulateMedia({ reducedMotion: null });
		// The step is rebuilt at every engine event, but focus stays where the PM put it and the step is not a live region (T9-F004).
		assert.equal(await page.locator("#step").getAttribute("aria-live"), null);
		await page.locator('.language-button[data-locale="zh-TW"]').focus();
		const before = await page.locator("#install-stages li[data-badge='done']").count();
		await until("another stage to finish", 120_000, async () => (await page.locator("#install-stages li[data-badge='done']").count()) > before || undefined, 200);
		assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("data-locale") ?? ""), "zh-TW", "focus survived the redraw");
		await shotBoth(page, "wizard-install");
	});

	it("quit in the middle of the install: the relaunch opens on the install step", async () => {
		await until("two stages done", 600_000, async () => (await page.locator("#install-stages li[data-badge='done']").count()) >= 2 || undefined, 200);
		await close(first);
		assert.equal(readWizard().step, "install", "wizard.json holds the install step");
		// The quit cancelled the engine: nothing it started is left under <root>/tools, and no second engine was forked to carry on (T9-F002).
		const processes = createPlatform().processes;
		const left = await until("no process under tools", 20_000, async () => ((await processes.listUnder(world.layout.tools.root)).filter((p) => p.pid !== process.pid).length === 0 ? true : undefined), 500);
		assert.ok(left);
		assert.equal(logText().includes('"event":"engine-crashed"'), false, "the quit is not a crash of the engine");
		// The stub is set at launch: a process started now would otherwise start the stack before a test could set it.
		const second = await launch("zh-TW", { SBD_TEST_WSL_BASH: WSL_BASH });
		const again = await pageOf(second, "wizard.html");
		await until("the install step on the relaunch", 60_000, async () => ["install", "start", "claude"].includes(await stepOf(again)) || undefined, 200);
		page = again;
		first = second;
	});

	it("quit inside a package stage: the record says the install was interrupted, a program left under <root>/tools makes the relaunch wait, and the install then finishes (R9-F001, R9-F002)", async () => {
		const events = (): Array<Record<string, unknown>> =>
			logText()
				.split("\n")
				.flatMap((line) => {
					try {
						return [JSON.parse(line) as Record<string, unknown>];
					} catch {
						return [];
					}
				});
		/** The `pi install` and `pi remove` calls of the package stages, as the stage logs recorded them. */
		const piCalls = () => events().filter((e) => e.event === "exec" && Array.isArray(e.args) && (e.args.includes("install") || e.args.includes("remove")) && typeof e.stage === "string" && /^(profile|pkg:|team-pkg:)/.test(e.stage));
		const before = piCalls().length;
		await until("a package stage's pi install to start", 20 * 60_000, () => piCalls().length > before || undefined, 100);
		await close(first);
		assert.equal(readWizard().step, "install", "wizard.json holds the install step");
		assert.equal(logText().includes('"event":"engine-crashed"'), false, "the quit is not a crash of the engine");
		const recorded = JSON.parse(readFileSync(join(world.layout.state, "bootstrap.json"), "utf8")) as { stages: Record<string, { status: string }> };
		const interrupted = Object.entries(recorded.stages).filter(([name, r]) => /^(profile|pkg:|team-pkg:)/.test(name) && r.status === "running").map(([name]) => name);
		assert.ok(interrupted.length >= 1, `a package stage is still recorded as running after the quit (${JSON.stringify(Object.fromEntries(Object.entries(recorded.stages).map(([n, r]) => [n, r.status])))})`);
		// The npm that pi started may have outlived the quit (the runner ends only the child it holds); whether it did is not up to the test. A stand-in for it runs out of a copy of this Node under
		// <root>/tools for 75 s, so the relaunch's package stage has something to wait for in every run (its own limit is 90 s).
		const bin = join(world.layout.tools.root, "e2e-leftover");
		mkdirSync(bin, { recursive: true });
		const exe = join(bin, isWindows ? "node.exe" : "node");
		copyFileSync(process.execPath, exe, constants.COPYFILE_FICLONE);
		chmodSync(exe, 0o755);
		const standIn = spawn(exe, ["-e", "setTimeout(() => {}, 75000)"], { stdio: "ignore", windowsHide: true });
		const standInPid = standIn.pid;
		assert.ok(standInPid !== undefined);
		const exited = new Promise<number>((resolve) => standIn.once("exit", () => resolve(Date.now())));
		const processes = createPlatform().processes;
		await until("the stand-in to be visible under tools", 30_000, async () => (await processes.listUnder(world.layout.tools.root)).some((p) => p.pid === standInPid) || undefined, 250);
		const relaunchedAt = new Date().toISOString();
		const third = await launch("zh-TW", { SBD_TEST_WSL_BASH: WSL_BASH });
		const again = await pageOf(third, "wizard.html");
		// The relaunch resumes: it ends on the first sign-in step with the stack started.
		await waitStep(again, "claude", 25 * 60_000);
		page = again;
		first = third;
		const exitedAt = await exited;
		const since = events().filter((e) => typeof e.t === "string" && e.t >= relaunchedAt);
		const busy = since.find((e) => e.event === "tools-busy");
		assert.ok(busy, "the relaunch's package stage found the program under tools and waited");
		assert.ok(((busy.programs as string[]) ?? []).some((p) => p.includes(`(pid ${standInPid})`)), `the stand-in is named by its file name and pid: ${JSON.stringify(busy.programs)}`);
		assert.equal(since.some((e) => e.event === "tools-locked"), false, "the wait ended before its limit");
		assert.ok(since.some((e) => e.event === "tools-quiet"), "and it ended because the program was gone");
		const firstCall = since.filter((e) => e.event === "exec" && Array.isArray(e.args) && (e.args.includes("install") || e.args.includes("remove")) && typeof e.stage === "string" && /^(profile|pkg:|team-pkg:)/.test(e.stage))[0];
		assert.ok(firstCall, "the relaunch ran pi for a package stage");
		assert.ok(Date.parse(String(firstCall.t)) >= exitedAt - 1_500, `pi was started (${String(firstCall.t)}) only after the stand-in had gone (${new Date(exitedAt).toISOString()})`);
		const bootstrap = JSON.parse(readFileSync(join(world.layout.state, "bootstrap.json"), "utf8")) as { stages: Record<string, { status: string }> };
		const names = Object.keys(bootstrap.stages);
		for (const stage of ["preflight", "node", "git", "herdr", "pi", "profile"]) assert.ok(names.includes(stage), `${stage} is recorded`);
		assert.deepEqual(names.filter((n) => bootstrap.stages[n]?.status !== "ok"), [], "every stage is verified");
		await shotBoth(page, "wizard-claude");
	});

	it("walks every sign-in step with Later and ends on the done step naming what was put off", async () => {
		const signature = () => page.evaluate(() => `${document.body.dataset.step ?? ""}|${document.querySelector(".lead")?.textContent ?? ""}`);
		const seen: string[] = [];
		for (let i = 0; i < 4; i++) {
			const before = await signature();
			seen.push(await stepOf(page));
			if (i === 1) await shotBoth(page, "wizard-hosts");
			await page.locator("#later").click();
			await until("the next step", 15_000, async () => (await signature()) !== before || undefined, 150);
		}
		assert.equal(await stepOf(page), "done");
		assert.deepEqual(seen, ["claude", "hosts", "hosts", "linear"]);
		assert.deepEqual(readWizard().later.map((l) => l.item), ["claude", "github", "gitlab", "linear"]);
		const pending = await page.locator("#done-pending").innerText();
		assert.ok(pending.includes("gitlab.com") && pending.includes("github.com"), pending);
		await shotBoth(page, "wizard-done");
	});

	it("opens the GUI with the banner in the language chosen on the last step, and settings change it (T9-F003)", async () => {
		// The window opened in zh-TW; the PM picks English on the done step, so the runtime page, loaded after that, must be worded in English.
		await page.locator('.language-button[data-locale="en"]').click();
		await until("English on the done step", 10_000, async () => (await page.locator("h1").innerText()) === en.done.title, 100);
		await page.locator("#finish").click();
		const url = await until("the GUI view to load the server's address", 120_000, () => guiUrl(first));
		assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{16,}\/?/);
		assert.equal(await inGui(first, `document.querySelector('meta[name="sb-desk"]')?.content`), "1");
		assert.equal(readWizard().done, true);
		assert.equal(readWizard().locale, "en");
		const notices = await pageOf(first, "screen.html");
		await notices.locator('[data-notice="wsl"]').waitFor({ timeout: 30_000 });
		assert.equal(await notices.locator('[data-notice="wsl"] .notice-text').innerText(), en.welcome.wsl);
		const later = await notices.locator('[data-notice="later"] .notice-text').innerText();
		assert.ok(later.includes("gitlab.com") && later.includes("github.com"), later);
		assert.match(later, /, and Linear\.$/, "the list is joined the way English joins it");
		await shot(notices, "wizard-banner-en");
		// Settings, from the banner's own button, in English and then in zh-TW; the language is changed in the Computer section.
		await notices.locator("#open-settings").click();
		const settings = await pageOf(first, "settings.html");
		await settings.locator('[data-section="accounts"]').first().waitFor({ timeout: 30_000 });
		await shot(settings, "wizard-settings-en");
		await settings.locator('button.nav-item[data-section="computer"]').click();
		await settings.locator('.language-button[data-locale="zh-TW"]').click();
		await until("zh-TW in settings", 10_000, async () => (await settings.evaluate(() => document.documentElement.lang)) === "zh-TW", 100);
		await settings.locator('button.nav-item[data-section="accounts"]').click();
		await settings.locator('#accounts-later').waitFor({ timeout: 10_000 });
		await shot(settings, "wizard-settings-zh-TW");
		await settings.locator("#settings-back").click();
		// Back over the GUI: the notices follow the language chosen meanwhile.
		const again = await pageOf(first, "screen.html");
		await until("the zh-TW banner", 30_000, async () => (await again.locator('[data-notice="wsl"] .notice-text').innerText()) === zhTW.welcome.wsl, 250);
		const laterZh = await again.locator('[data-notice="later"] .notice-text').innerText();
		assert.match(laterZh, /Claude、GitHub（github\.com）、GitLab（gitlab\.com）和 Linear。$/, laterZh);
		await shot(again, "wizard-banner-zh-TW");
		const installed = readInstalled(world.layout);
		assert.ok(isInstalled(installed), "the install is complete");
		const status = await run(installed.node, [installed.sbCli, "status"], { env: childEnvOf(world), timeoutMs: 120_000 });
		// The status JSON holds the GUI's token and address: only named fields reach the public log (T9-F005).
		console.log(`cli.mjs status: ${statusSummary(status.stdout)} (exit ${status.code})`);
		assert.equal(status.code, 0);
		assert.match(status.stdout, /live/i);
		assert.ok(existsSync(join(world.home, "StrawBoss", "Straw Boss")), "the home base folder exists under the work folder");
	});

	it("quits, and a later launch opens no wizard, reaches the GUI, and shows the banner in the language chosen", async () => {
		await close(first);
		const file = readWizard();
		writeFileSync(wizardFile(), JSON.stringify({ ...file, locale: "zh-TW" }));
		const began = Date.now();
		const again = await launch("en-US", { SBD_TEST_WSL_BASH: WSL_BASH });
		// The design says 30 s. The Windows runner took 26.7 s once, so the assertion allows 45 s and the time is logged (Build note, task 9).
		const url = await until("the GUI view to load the server's address", 45_000, () => guiUrl(again));
		console.log(relaunchNotice(Date.now() - began));
		assert.ok(url);
		assert.equal(readWizard().done, true);
		const notices = await pageOf(again, "screen.html");
		await notices.locator('[data-notice="wsl"]').waitFor({ timeout: 30_000 });
		assert.equal(await notices.locator('[data-notice="wsl"] .notice-text').innerText(), zhTW.welcome.wsl, "the saved language wins over the OS language");
		assert.equal(await again.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows().length), 1);
		await close(again);
	});

	it("a launch that cannot start shows the failure screen, in both languages", async () => {
		// Without its record the install cannot be trusted (`state-unreadable`, offering Repair): the runtime page shows it as a whole screen.
		const record = join(world.layout.state, "bootstrap.json");
		const held = `${record}.held`;
		renameSync(record, held);
		try {
			for (const [locale, words] of [["zh-TW", zhTW], ["en", en]] as const) {
				writeFileSync(wizardFile(), JSON.stringify({ ...readWizard(), locale }));
				const app = await launch(locale === "en" ? "en-US" : "zh-TW", { SBD_TEST_WSL_BASH: WSL_BASH });
				const screen = await pageOf(app, "screen.html");
				await screen.locator('#card[data-screen="failed"]').waitFor({ state: "visible", timeout: 60_000 });
				assert.equal(await screen.locator("#card").getAttribute("data-failure-kind"), "state-unreadable");
				assert.equal(await screen.locator("#sentence").innerText(), words.start.failure["state-unreadable"]);
				assert.equal(await screen.locator("#repair").isVisible(), true, "Repair is offered");
				// The sentence tells the PM to run Repair, so Repair is the primary button and Try again is not (SA-10).
				assert.equal(await screen.locator("#repair").evaluate((el) => el.classList.contains("primary")), true);
				assert.equal(await screen.locator("#retry").evaluate((el) => el.classList.contains("primary")), false);
				await shot(screen, `wizard-failure-${locale}`);
				await close(app);
			}
		} finally {
			renameSync(held, record);
		}
	});
});

describe("a second, short run in English (e2e, task 9)", { skip }, () => {
	let world: World;
	let app: ElectronApplication | undefined;

	before(async () => {
		world = createWorld("wiz2");
	});
	after(async () => {
		await app?.close().catch(() => undefined);
		await disposeWorld(world);
	});

	it("walks to the trust screen in English with a screenshot of each screen, and runs no infinite animation under reduced motion", async () => {
		const base: Record<string, string> = {};
		for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(PI_|HERDR_|ELECTRON_RUN_AS_NODE$)/.test(k)) base[k] = v;
		app = await electron.launch({ executablePath: packaged?.executable, args: ["--lang=en-US"], env: { ...base, ...world.appEnv, STRAW_BOSS_DESK_ROOT: world.root }, timeout: 60_000 });
		const open = app;
		const page = await until("the wizard page", 60_000, () => open.windows().find((w) => w.url().endsWith("wizard.html")), 250);
		await page.waitForLoadState("domcontentloaded");
		const stepOf = () => page.evaluate(() => document.body.dataset.step ?? "");
		await until("the welcome step", 30_000, async () => (await stepOf()) === "welcome");
		assert.equal(await page.locator("h1").innerText(), en.welcome.title);
		await page.emulateMedia({ reducedMotion: "reduce" });
		const infinite = () => page.evaluate(() => document.getAnimations().filter((a) => a.playState === "running" && a.effect?.getComputedTiming().iterations === Infinity).length);
		assert.equal(await infinite(), 0);
		await page.locator("#welcome-next").click();
		await until("the recipe step", 15_000, async () => (await stepOf()) === "recipe");
		await open.evaluate(({ dialog }, f) => {
			dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [f] })) as unknown as typeof dialog.showOpenDialog;
		}, ciRecipe);
		await page.locator("#recipe-choose").click();
		await until("the trust step", 15_000, async () => (await stepOf()) === "trust");
		assert.ok((await page.locator("#trust-list").innerText()).includes("gitlab.com"));
		assert.equal(await infinite(), 0);
		await page.locator("#trust-apply").click();
		await until("the folder step", 15_000, async () => (await stepOf()) === "folder");
	});
});
