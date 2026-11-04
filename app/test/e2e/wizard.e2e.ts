// The task 9 anchor (`wizard-from-zero.yml`, first form): the packaged app's wizard from an empty data root to the GUI with every sign-in put off (Later). On a GitHub-hosted runner only.
//   - an invalid recipe is refused with its field and rule and without a value;
//   - a quit in the middle of the install and a relaunch open on the install step and finish it;
//   - with the WSL check stubbed to report (`SBD_TEST_WSL_BASH`, development build), the welcome screen has its line and the banner shows its sentence over the GUI at start, in both languages;
//   - a quit in the middle of the install leaves no process under <root>/tools (the engine is cancelled, not killed and forked again);
//   - a quit inside a package stage (while pi's `pi install` runs) leaves that stage `running`, so a start would be refused; a program left running under <root>/tools (a stand-in for the npm that
//     pi started) makes the relaunch's package stage wait for it, and the install then finishes (R9-F001, R9-F002);
//   - the language chosen on the last wizard step is the one the banner over the GUI is worded in, and the one the settings page changes;
//   - a later launch opens no wizard and reaches the GUI (the design says 30 s; the assertion allows 45 s, see the Build note on task 9), and a launch that cannot start shows the failure screen;
//   - a second, short run in English up to the trust screen, and a reduced-motion pass;
//   - the code-host sign-ins (task 10): a seeded foreign gh:github.com entry stops the GitHub step before any device code, a seeded foreign glab entry stops the GitLab step before the token field
//     (each unchanged afterwards); with SBD_GITLAB_TEST_TOKEN the GitLab token login (verdict, record, token search, a git push through the stored token), settings' Sign out for an owned login and for
//     a foreign one, a foreign write over the app's own entry, and Sign in again; on macOS, a relaunch with a HOME that has no keychain stops at the store probe.
//   SBD_E2E=1 SBD_E2E_KIND=dev node --test test/e2e/wizard.e2e.ts        (a GitHub-hosted runner only; the six-signal check refuses anywhere else)
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, constants, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { _electron as electron, type ElectronApplication, type Page } from "playwright-core";
import { en } from "../../src/renderer/i18n/en.ts";
import { format, t } from "../../src/renderer/i18n/index.ts";
import { zhTW } from "../../src/renderer/i18n/zh-TW.ts";
import { entryNames, readAccountsRecord, writeAccountsRecord } from "../../src/main/accounts/existing.ts";
import { scan } from "../../src/main/accounts/token-search.ts";
import { openForgeRig, type ForgeRig } from "../harness/forge-e2e.ts";
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
// The CI GitLab account (boss decision 2026-11-04): a PAT with `api` scope in the Actions secret SBD_GITLAB_TEST_TOKEN, on push and workflow_dispatch only. It is never printed, never put in a message,
// and kept out of the environment of the app and of every child (the launch below removes it); the test process alone holds it.
const GITLAB_TOKEN = (process.env.SBD_GITLAB_TEST_TOKEN ?? "").trim();
const hasToken = GITLAB_TOKEN.length > 0;
const noToken = hasToken ? false : "SBD_GITLAB_TEST_TOKEN is not set (a pull request, or a repository without the secret)";
/** The private empty project that belongs to the account; the push check pushes one branch there and deletes it. */
const GITLAB_TEST_PROJECT = "https://gitlab.com/wayne930242/sbd-ci-login-test.git";
/** Foreign entries: another program's sign-in, as `gh` and `glab` name theirs. The accounts are not the ones the CLIs use, so the seeds never collide with the app's own. */
const GH_FOREIGN = { name: "gh:github.com", account: "sbd-foreign-user" };
const GL_FOREIGN = { name: "glab:gitlab.com:token", account: "sbd-foreign-user" };
const tr = (locale: "en" | "zh-TW", key: string, vars: Record<string, string> = {}): string => format(t(locale, key), vars);
const EXCLUDED_FROM_APP_ENV = /^(PI_|HERDR_|ELECTRON_RUN_AS_NODE$|SBD_GITLAB_TEST_TOKEN$)/;
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
		for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !EXCLUDED_FROM_APP_ENV.test(k)) base[k] = v;
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

	// ---- the code-host sign-ins (task 10) ----------------------------------------------------------------------------------------------------------------------------------------------
	let rig: ForgeRig;
	let foreignGh: { secret: string | null; modified: string | null };
	let foreignGl: { secret: string | null; modified: string | null };
	const logEvents = (): Array<Record<string, unknown>> =>
		logText()
			.split("\n")
			.flatMap((line) => {
				try {
					return [JSON.parse(line) as Record<string, unknown>];
				} catch {
					return [];
				}
			});
	const eventsNamed = (event: string, cli?: string) => logEvents().filter((e) => e.event === event && (cli === undefined || e.cli === cli));
	const panelOf = (p: Page, host: string, phase?: string) => p.locator(`.forge-panel[data-forge="${host}"]${phase === undefined ? "" : `[data-phase="${phase}"]`}`);
	const waitPhase = (p: Page, host: string, phase: string, ms = 60_000) => panelOf(p, host, phase).waitFor({ timeout: ms });
	const rowOf = (p: Page, host: string, state?: string) => p.locator(`li.forge-row[data-forge="${host}"]${state === undefined ? "" : `[data-state="${state}"]`}`);
	const recordOf = () => readAccountsRecord(world.layout);
	const ownFolders = (): string[] => [world.layout.state, world.layout.logs, join(world.root, "config")];
	const under = (dir: string, path: string): boolean => path.replace(/\\/g, "/").toLowerCase().startsWith(dir.replace(/\\/g, "/").toLowerCase());
	/** Settings in one language: the language buttons live in Computer, so the page goes there and back (which also asks main for the rows afresh). */
	const settingsIn = async (s: Page, locale: "en" | "zh-TW"): Promise<void> => {
		await s.locator('button.nav-item[data-section="computer"]').click();
		await s.locator(`.language-button[data-locale="${locale}"]`).click();
		await until(`${locale} in settings`, 10_000, async () => (await s.evaluate(() => document.documentElement.lang)) === locale, 100);
		await s.locator('button.nav-item[data-section="accounts"]').click();
		await s.locator("#accounts-forges").waitFor({ timeout: 10_000 });
	};
	const shotSettingsBoth = async (s: Page, name: string): Promise<void> => {
		await settingsIn(s, "zh-TW");
		await shot(s, `${name}-zh-TW`);
		await settingsIn(s, "en");
		await shot(s, `${name}-en`);
		await settingsIn(s, "zh-TW");
	};
	const gitExecutable = (): { git: string; env: Record<string, string> } => {
		const env = { ...childEnvOf(world), GIT_TERMINAL_PROMPT: "0" } as Record<string, string>;
		const git = env.PATH?.split(isWindows ? ";" : ":").map((dir) => join(dir, isWindows ? "git.exe" : "git")).find((f) => existsSync(f));
		assert.ok(git, "the app's Git is on the constructed PATH");
		return { git, env };
	};

	before(async () => {
		assertElevatedRunner();
		if (aside.state === "refused") throw new Error(aside.reason);
		if (aside.state === "active") await aside.enter(ioForSudo);
		world = createWorld("wiz");
		await noteUserPath(world);
		// The CI cache holds the pinned downloads; the engine hashes every file it finds there, so a bad one is replaced, not trusted.
		seedDownloads(world);
		// The store the app will use: on macOS a keychain of its own in the world's HOME (the app gets the same HOME), on Windows the runner's Credential Manager. One foreign GitHub sign-in is in
		// it before the first launch (spec: Workflows, wizard-from-zero).
		rig = await openForgeRig(world);
		await rig.seeder.write(GH_FOREIGN.name, GH_FOREIGN.account, rig.dummy("gh-foreign"));
		foreignGh = await rig.snapshot(GH_FOREIGN.name, GH_FOREIGN.account);
		assert.ok(foreignGh.secret !== null && foreignGh.modified !== null, "the foreign gh entry is in the store");
	});

	after(async () => {
		for (const app of apps) await close(app);
		// Entries of this run that a failed test left behind (the runner is ephemeral, so this is tidiness, not safety).
		for (const e of [GH_FOREIGN, GL_FOREIGN, { name: "gh:github.com", account: "" }]) await rig?.seeder.remove(e.name, e.account).catch(() => undefined);
		await rig?.dispose().catch((error: Error) => console.log(`forge rig: ${error.message.slice(0, 200)}`));
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

	it("GitHub step: a foreign gh:github.com entry stops it before any device code, and stays as it was", async () => {
		assert.equal(await stepOf(page), "claude");
		await page.locator("#later").click();
		await waitStep(page, "hosts");
		await waitPhase(page, "github.com", "foreign");
		assert.equal((await page.locator("#forge-foreign").innerText()).trim(), tr("zh-TW", "forge.foreign", { host: "github.com", tool: t("zh-TW", "forge.tool.github") }));
		for (const id of ["#device-code", "#forge-sign-in", "#forge-token"]) assert.equal(await page.locator(id).count(), 0, `${id} is not on the refused step`);
		await page.locator("#forge-details summary").click();
		assert.ok((await page.locator("#forge-details .forge-entries").innerText()).includes(GH_FOREIGN.name), "Details names the entry");
		await shotBoth(page, "accounts-github-refused");
		assert.deepEqual(await rig.snapshot(GH_FOREIGN.name, GH_FOREIGN.account), foreignGh, "the entry has the same secret and the same modification time");
		assert.deepEqual(eventsNamed("forge-login-start"), [], "no gh login was started");
		assert.ok(eventsNamed("forge-probe", "gh").some((e) => e.ok === true), "the store probe passed first");
		assert.ok(eventsNamed("forge-existing-check", "gh").some((e) => e.foreign === 1), "and the existing-sign-in check found the entry");
		assert.deepEqual(recordOf(), { schema: 1, entries: [], left: [] }, "the app records nothing for an entry it did not make");
	});

	it("GitLab step: a foreign glab:gitlab.com:token entry stops it before the token field; once it is gone the check passes", async () => {
		await rig.seeder.write(GL_FOREIGN.name, GL_FOREIGN.account, rig.dummy("gl-foreign"));
		foreignGl = await rig.snapshot(GL_FOREIGN.name, GL_FOREIGN.account);
		assert.ok(foreignGl.secret !== null && foreignGl.modified !== null, "the foreign glab entry is in the store");
		await page.locator("#later").click();
		await waitPhase(page, "gitlab.com", "foreign");
		assert.equal((await page.locator("#forge-foreign").innerText()).trim(), tr("zh-TW", "forge.foreign", { host: "gitlab.com", tool: t("zh-TW", "forge.tool.gitlab") }));
		assert.equal(await page.locator("#forge-token").count(), 0, "the token field is not shown");
		assert.equal(await page.locator("#forge-sign-in").count(), 0);
		await shotBoth(page, "accounts-gitlab-refused");
		assert.deepEqual(await rig.snapshot(GL_FOREIGN.name, GL_FOREIGN.account), foreignGl, "the entry has the same secret and the same modification time");
		assert.deepEqual(eventsNamed("forge-login-start"), []);
		// The PM removes their own entry; Try again passes the check and shows the token field (the "not signed in" state).
		await rig.seeder.remove(GL_FOREIGN.name, GL_FOREIGN.account);
		await page.locator("#forge-retry").click();
		await waitPhase(page, "gitlab.com", "ready");
		const field = page.locator("#forge-token");
		assert.equal(await field.getAttribute("type"), "password", "the field is masked");
		assert.equal(await field.getAttribute("autocomplete"), "off");
		assert.equal(await page.locator("#forge-token-reveal, .reveal").count(), 0, "there is no reveal toggle");
		await shotBoth(page, "accounts-gitlab-not-signed-in");
	});

	it("GitLab token login: verdict PASS, the created entries are recorded with their times, the token is nowhere on disk, in a log or in the page, and git pushes through it (SBD_GITLAB_TEST_TOKEN)", { skip: noToken }, async () => {
		await page.locator("#forge-token").fill(GITLAB_TOKEN);
		await page.locator("#forge-sign-in").click();
		await waitPhase(page, "gitlab.com", "done", 180_000);
		assert.equal(await page.locator("#forge-token").count(), 0, "the field is gone");
		assert.equal(await page.evaluate(() => [...document.querySelectorAll("input")].every((i) => i.value === "")), true, "no field holds a value");
		await shotBoth(page, "accounts-gitlab-signed-in");

		// The verdict passed, and the entries the login created are recorded with the times the store reports.
		const verdict = eventsNamed("forge-verdict", "glab").at(-1);
		assert.ok(verdict, "the verdict ran");
		assert.equal(verdict.plain, false);
		assert.equal(verdict.verified, true);
		const record = recordOf();
		const mine = record.entries.filter((e) => e.kind === "gitlab" && e.host === "gitlab.com");
		assert.ok(mine.length >= 1, "the login's entries are recorded");
		assert.deepEqual(record.left, []);
		const listed = await rig.list(entryNames("gitlab", "gitlab.com"));
		assert.deepEqual(
			mine.map((e) => [e.name, e.account, e.modified]).sort(),
			listed.map((e) => [e.name, e.account, e.modified]).sort(),
			"the record holds exactly the store's entries for the host, with their modification times",
		);
		for (const e of mine) assert.match(e.modified, /^\d{4}-\d\d-\d\dT/);

		// Followup R3-F003: a token search over everything the app and its children wrote (the whole data root, and the home it lies in). The keychain file of the scratch HOME is the store itself.
		const found = scan([world.home], GITLAB_TOKEN, { skipDirs: [join(world.home, "Library", "Keychains")] });
		console.log(`token search: ${found.files} files, ${Math.round(found.bytes / 1_000_000)} MB, ${found.hits.length} hits, ${found.unread.length} listed as not read (links, files in use)`);
		assert.equal(found.hits.length, 0, `the token is in ${found.hits.length} file(s) under the home`);
		assert.deepEqual(found.unread.filter((u) => ownFolders().some((d) => under(d, u.path))).map((u) => u.reason), [], "every file of the app's own folders was read");
		assert.equal(logText().includes(GITLAB_TOKEN), false, "no log holds the token");
		assert.equal(
			await page.evaluate((needle) => [document.documentElement.outerHTML, JSON.stringify({ ...localStorage }), JSON.stringify({ ...sessionStorage }), document.cookie].some((part) => part.includes(needle)), GITLAB_TOKEN),
			false,
			"the page, its storage and its cookies do not hold the token",
		);
		assert.equal(logText().includes(`${GITLAB_TOKEN}`), false);

		// The stored token works through Git's credential helper: one branch to the account's private test project, deleted again in every case.
		const { git, env } = gitExecutable();
		const dir = join(world.base, "push-check");
		mkdirSync(dir, { recursive: true });
		const branch = `sbd-ci-${Date.now().toString(36)}-${process.pid}`;
		const g = (args: string[], timeoutMs = 120_000) => run(git, args, { env, cwd: dir, timeoutMs });
		assert.equal((await g(["init", "-q", "-b", branch])).code, 0);
		const committed = await g(["-c", "user.name=Straw Boss CI", "-c", "user.email=ci@example.invalid", "commit", "--allow-empty", "-q", "-m", "login check"]);
		assert.equal(committed.code, 0, `commit exited ${committed.code}`);
		let pushed = false;
		try {
			const head = await g(["ls-remote", GITLAB_TEST_PROJECT, "HEAD"]);
			assert.equal(head.code, 0, `ls-remote of the private test project exited ${head.code} (the credential helper gave no token)`);
			const push = await g(["push", GITLAB_TEST_PROJECT, `HEAD:refs/heads/${branch}`]);
			pushed = push.code === 0;
			assert.equal(push.code, 0, `push exited ${push.code}`);
			const there = await g(["ls-remote", "--heads", GITLAB_TEST_PROJECT, branch]);
			assert.ok(there.stdout.includes(branch), "the branch is on the project");
		} finally {
			const present = (await g(["ls-remote", "--heads", GITLAB_TEST_PROJECT, branch])).stdout.includes(branch);
			if (pushed || present) {
				const removed = await g(["push", GITLAB_TEST_PROJECT, "--delete", branch]);
				assert.equal(removed.code, 0, `deleting the pushed branch exited ${removed.code}`);
			}
		}
		assert.equal((await g(["ls-remote", "--heads", GITLAB_TEST_PROJECT, branch])).stdout.trim(), "", "no branch of this run is left on the project");

		await page.locator("#hosts-next").click();
		await waitStep(page, "linear");
	});

	it("puts off what is left and ends on the done step naming it", async () => {
		if (!hasToken) {
			await page.locator("#later").click();
			await waitStep(page, "linear");
		}
		assert.equal(await stepOf(page), "linear");
		await shotBoth(page, "wizard-linear");
		await page.locator("#later").click();
		await waitStep(page, "done");
		assert.deepEqual(readWizard().later.map((l) => l.item), hasToken ? ["claude", "github", "linear"] : ["claude", "github", "gitlab", "linear"]);
		const pending = await page.locator("#done-pending").innerText();
		assert.ok(pending.includes("github.com"), pending);
		assert.equal(pending.includes("gitlab.com"), !hasToken, "GitLab is named only when it was put off");
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
		assert.ok(later.includes("github.com") && later.includes("gitlab.com") === !hasToken, later);
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
		assert.match(laterZh, hasToken ? /Claude、GitHub（github\.com）和 Linear。$/ : /Claude、GitHub（github\.com）、GitLab（gitlab\.com）和 Linear。$/, laterZh);
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

	let settings: Page;
	const GH_OWNED = { name: "gh:github.com", account: "" };

	it("settings' Accounts rows: a foreign GitHub sign-in, the app's own GitLab one, and a GitHub row the app owns (a seeded entry and record: no device approval exists in CI)", async () => {
		const notices = await pageOf(first, "screen.html");
		await notices.locator("#open-settings").click();
		settings = await pageOf(first, "settings.html");
		await settings.locator('button.nav-item[data-section="accounts"]').click();
		await settings.locator("#accounts-forges").waitFor({ timeout: 10_000 });
		await rowOf(settings, "github.com", "foreign").waitFor({ timeout: 30_000 });
		if (hasToken) await rowOf(settings, "gitlab.com", "signed-in").waitFor({ timeout: 30_000 });
		else await rowOf(settings, "gitlab.com", "not-signed-in").waitFor({ timeout: 30_000 });
		await shotSettingsBoth(settings, "accounts-rows-foreign");

		// A row the app owns: the foreign entry goes, an entry and its record take its place (the record holds the time the store reports), and the page asks again.
		await rig.seeder.remove(GH_FOREIGN.name, GH_FOREIGN.account);
		await rig.seeder.write(GH_OWNED.name, GH_OWNED.account, rig.dummy("gh-owned"));
		const owned = (await rig.list([GH_OWNED.name])).find((e) => e.account === GH_OWNED.account);
		assert.ok(owned, "the seeded entry is listed");
		const held = recordOf();
		writeAccountsRecord(world.layout, { ...held, entries: [...held.entries, { name: GH_OWNED.name, account: GH_OWNED.account, host: "github.com", kind: "github", modified: owned.modified }] });
		await settingsIn(settings, "en");
		await rowOf(settings, "github.com", "signed-in").waitFor({ timeout: 30_000 });
		await shotSettingsBoth(settings, "accounts-rows-github-signed-in");

		// Back to a foreign entry for the Sign out cases: the owned one and its record go, the foreign one returns.
		await rig.seeder.remove(GH_OWNED.name, GH_OWNED.account);
		writeAccountsRecord(world.layout, { ...held, entries: held.entries.filter((e) => e.host !== "github.com") });
		await rig.seeder.write(GH_FOREIGN.name, GH_FOREIGN.account, rig.dummy("gh-foreign-2"));
		foreignGh = await rig.snapshot(GH_FOREIGN.name, GH_FOREIGN.account);
		await settingsIn(settings, "zh-TW");
		await rowOf(settings, "github.com", "foreign").waitFor({ timeout: 30_000 });
	});

	it("settings' GitHub Sign out beside a foreign entry runs no logout, says it was left alone, and leaves the entry unchanged", async () => {
		const logouts = eventsNamed("forge-logout", "gh").length;
		await rowOf(settings, "github.com").locator(".forge-sign-out").click();
		await waitPhase(settings, "github.com", "left-alone");
		const text = await panelOf(settings, "github.com", "left-alone").innerText();
		assert.ok(text.includes(GH_FOREIGN.name), text);
		assert.equal(eventsNamed("forge-logout", "gh").length, logouts, "no gh logout ran");
		assert.ok(eventsNamed("forge-logout-skipped", "gh").length >= 1, "the skip is logged");
		assert.deepEqual(await rig.snapshot(GH_FOREIGN.name, GH_FOREIGN.account), foreignGh, "same secret, same modification time");
		await shotSettingsBoth(settings, "accounts-github-sign-out-left-alone");

		// The PM removes their entry; Sign in passes the check and offers GitHub's own button (the "not signed in" state). The button is not pressed: approval needs a person.
		await rig.seeder.remove(GH_FOREIGN.name, GH_FOREIGN.account);
		await rowOf(settings, "github.com").locator(".forge-sign-in-again").click();
		await waitPhase(settings, "github.com", "ready");
		await rowOf(settings, "github.com", "not-signed-in").waitFor({ timeout: 30_000 });
		assert.equal(await settings.locator("#forge-sign-in").count(), 1);
		assert.deepEqual(eventsNamed("forge-login-start", "gh"), []);
		await shotSettingsBoth(settings, "accounts-github-not-signed-in");
	});

	it("settings' GitLab Sign out of the app's own login runs glab auth logout and empties the record; signing in again works (SBD_GITLAB_TEST_TOKEN)", { skip: noToken }, async () => {
		await rowOf(settings, "gitlab.com").locator(".forge-sign-out").click();
		await waitPhase(settings, "gitlab.com", "signed-out", 90_000);
		const logout = eventsNamed("forge-logout", "glab").at(-1);
		assert.ok(logout && logout.exit === 0, "glab auth logout ran and succeeded");
		assert.deepEqual(recordOf().entries.filter((e) => e.host === "gitlab.com"), [], "the record is empty for the host");
		assert.deepEqual(await rig.list(entryNames("gitlab", "gitlab.com")), [], "the logout took the entries out of the store");
		await shotSettingsBoth(settings, "accounts-gitlab-sign-out");

		await rowOf(settings, "gitlab.com").locator(".forge-sign-in-again").click();
		await waitPhase(settings, "gitlab.com", "ready");
		await settings.locator("#forge-token").fill(GITLAB_TOKEN);
		await settings.locator("#forge-sign-in").click();
		await waitPhase(settings, "gitlab.com", "done", 180_000);
		await rowOf(settings, "gitlab.com", "signed-in").waitFor({ timeout: 30_000 });
		assert.ok(recordOf().entries.some((e) => e.host === "gitlab.com"));
		assert.equal(logText().includes(GITLAB_TOKEN), false, "no log holds the token");
	});

	it("a foreign write over the app's GitLab entry: Sign out runs no logout and keeps the PM's secret, the row says changed, Sign in again stops at the check, and after the entry is deleted it passes (SBD_GITLAB_TEST_TOKEN)", { skip: noToken }, async () => {
		const mine = recordOf().entries.filter((e) => e.host === "gitlab.com");
		assert.ok(mine.length >= 1);
		const target = mine.find((e) => e.name === "glab:gitlab.com:token") ?? (mine[0] as (typeof mine)[number]);
		// At least 2 s after the login: macOS keeps the modification time to the second.
		await new Promise((resolve) => setTimeout(resolve, 2500));
		const pmSecret = rig.dummy("pm-own");
		await rig.seeder.write(target.name, target.account, pmSecret);
		const written = await rig.snapshot(target.name, target.account);
		assert.equal(written.secret, pmSecret);
		assert.notEqual(written.modified, target.modified, "the write changed the time the store reports");

		const logouts = eventsNamed("forge-logout", "glab").length;
		await rowOf(settings, "gitlab.com").locator(".forge-sign-out").click();
		await waitPhase(settings, "gitlab.com", "left-alone", 60_000);
		assert.equal(eventsNamed("forge-logout", "glab").length, logouts, "no glab logout ran");
		assert.deepEqual(await rig.snapshot(target.name, target.account), written, "the entry keeps the dummy secret and its new time");
		await rowOf(settings, "gitlab.com", "left").waitFor({ timeout: 30_000 });
		assert.ok(recordOf().left.some((e) => e.name === target.name && e.host === "gitlab.com"), "the entry is marked left");
		assert.deepEqual(recordOf().entries.filter((e) => e.host === "gitlab.com"), []);
		await shotSettingsBoth(settings, "accounts-gitlab-changed-left");

		await rowOf(settings, "gitlab.com").locator(".forge-sign-in-again").click();
		await waitPhase(settings, "gitlab.com", "foreign");
		assert.equal((await settings.locator("#forge-foreign").innerText()).trim(), tr("zh-TW", "forge.changed", { host: "gitlab.com", tool: t("zh-TW", "forge.tool.gitlab") }));
		await settings.locator("#forge-details summary").click();
		assert.ok((await settings.locator("#forge-details .forge-entries").innerText()).includes(target.name), "Details names the entry");
		assert.equal(await settings.locator("#forge-token").count(), 0);
		await shotSettingsBoth(settings, "accounts-gitlab-changed-refused");

		// The test deletes the PM's entry (and whatever else of the login is left); the record drops it and Sign in again passes the check.
		for (const e of await rig.list(entryNames("gitlab", "gitlab.com"))) await rig.seeder.remove(e.name, e.account);
		await settings.locator("#forge-retry").click();
		await waitPhase(settings, "gitlab.com", "ready");
		assert.deepEqual(recordOf(), { schema: 1, entries: [], left: [] });
		await shotSettingsBoth(settings, "accounts-gitlab-after-removal");
	});

	it("macOS: a launch whose HOME has no keychain stops Sign in again at the store probe at once, and no token reaches the disk", { skip: isWindows ? "macOS only" : false }, async () => {
		await close(first);
		const empty = mkdtempSync("/tmp/sbd-nokc-");
		const app = await launch("zh-TW", { HOME: empty, STRAW_BOSS_DESK_ROOT: world.root, SBD_TEST_WSL_BASH: WSL_BASH });
		first = app;
		await pageOf(app, "screen.html");
		await app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById("settings-accounts")?.click());
		const s = await pageOf(app, "settings.html");
		await s.locator("#accounts-forges").waitFor({ timeout: 30_000 });
		await rowOf(s, "gitlab.com").locator(".forge-sign-in-again").click();
		await waitPhase(s, "gitlab.com", "store-unavailable", 30_000);
		assert.equal((await s.locator("#forge-refusal p").first().innerText()).trim(), t("zh-TW", "forge.storeUnavailable"));
		assert.equal(await s.locator("#forge-token").count(), 0, "no token field is offered");
		await shotSettingsBoth(s, "accounts-store-unavailable");
		if (hasToken) {
			const found = scan([empty, world.root], GITLAB_TOKEN);
			assert.equal(found.hits.length, 0, "no token is on disk");
		}
		await close(app);
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
		for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !EXCLUDED_FROM_APP_ENV.test(k)) base[k] = v;
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
