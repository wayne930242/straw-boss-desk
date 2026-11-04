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
//   - Claude and Linear (task 11): step 7 against a stand-in `claude` (SBD_TEST_CLAUDE_CMD): the code field, a planted code that reaches the stand-in's standard input and is in no log, no command line, no file
//     and no page storage, a refused code; step 9 with a dummy key: saved encrypted, `ttt` installed, the restart offer, **Restart now**, `LINEAR_API_KEY` in a new pane after it and not before, in no file under the
//     root; a relaunch with SBD_TEST_NO_ENCRYPTION=1 (`isEncryptionAvailable()` false) refuses the key at step 9; the Claude and Linear cards of settings; the shipped product's Safe Storage item unchanged.
//   SBD_E2E=1 SBD_E2E_KIND=dev node --test test/e2e/wizard.e2e.ts        (a GitHub-hosted runner only; the six-signal check refuses anywhere else)
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
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
import { BRANCH_OF, runPushCheck, type GitRun } from "../harness/ci-push-check.ts";
import { openForgeRig, type ForgeRig } from "../harness/forge-e2e.ts";
import { readInstalled, isInstalled } from "../../src/main/runtime/readiness.ts";
import { appRoot, locatePackaged, type Packaged } from "../harness/packaged.ts";
import { statusSummary } from "../harness/status-summary.ts";
import { relaunchNotice } from "../harness/relaunch-time.ts";
import { createPlatform } from "../../src/main/platform/index.ts";
import { childEnvOf, createWorld, disposeWorld, isWindows, noteUserPath, run, seedDownloads, WorldHerdr, type World } from "../harness/e2e-light.ts";
import { tttCommand } from "../../src/main/accounts/linear.ts";
import { parseStack } from "../../src/main/bootstrap/stack.ts";
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
/** The stand-in `claude` (task 11) and the code planted in the Claude screen's field. */
const FAKE_CLAUDE = fileURLToPath(new URL("../harness/fake-claude.mjs", import.meta.url));
const CLAUDE_CODE = `planted-code-${randomBytes(6).toString("hex")}`;
/** A dummy Linear key, of the shape Linear's are; it is no account's. */
const LINEAR_KEY = `lin_api_${randomBytes(20).toString("hex")}`;
const STACK_JSON = fileURLToPath(new URL("../../../stack.json", import.meta.url));
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
/** This OS's own branch on the test project: one fixed name per OS (T10R-F004). */
const BRANCH = isWindows ? BRANCH_OF.win32 : BRANCH_OF.darwin;
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
		// The stand-in `claude` answers in a development build only; its notes go to a folder beside the root, never into it.
		const claude = { SBD_TEST_CLAUDE_CMD: JSON.stringify([process.execPath, FAKE_CLAUDE, "--out", join(world.base, "claude-standin")]) };
		return { ...base, ...world.appEnv, ...claude, ...(isWindows ? { STRAW_BOSS_DESK_ROOT: world.root } : {}), ...extra };
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
	const rowOf = (p: Page, host: string, state?: string) => p.locator(`li.forge-card[data-forge="${host}"]${state === undefined ? "" : `[data-state="${state}"]`}`);
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

	// ---- Claude and Linear (task 11) ---------------------------------------------------------------------------------------------------------------------------------------------------
	const standIn = (): string => join(world.base, "claude-standin");
	const standInCalls = (): Array<{ argv: string[]; config: string; secureStorageDir: string | null }> => {
		const file = join(standIn(), "calls.jsonl");
		return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { argv: string[]; config: string; secureStorageDir: string | null }) : [];
	};
	/** Everything a search for a planted value must cover: the whole home (the data root lies in it on macOS) and the temp folder beside it, and the root itself where it does not. */
	const searchRoots = (): string[] => [world.home, join(world.base, "tmp"), ...(under(world.home, world.root) ? [] : [world.root])];
	/** The page, its storage, its cookies and its databases hold no `needle`, and no field holds a value. */
	const pageHolds = (p: Page, needle: string): Promise<boolean> =>
		p.evaluate(async (n) => {
			const dbs = typeof indexedDB.databases === "function" ? JSON.stringify(await indexedDB.databases()) : "";
			return [document.documentElement.outerHTML, JSON.stringify({ ...localStorage }), JSON.stringify({ ...sessionStorage }), document.cookie, dbs].some((part) => part.includes(n));
		}, needle);
	const fieldsEmpty = (p: Page): Promise<boolean> => p.evaluate(() => [...document.querySelectorAll("input")].every((i) => i.value === ""));
	/** `shell.openExternal` of the app records what it was asked to open (a runner must not open a browser). */
	const recordExternal = (app: ElectronApplication) =>
		app.evaluate(({ shell }) => {
			const g = globalThis as unknown as { __opened?: string[] };
			g.__opened = [];
			shell.openExternal = (async (url: string) => void g.__opened?.push(url)) as unknown as typeof shell.openExternal;
		});
	const openedExternal = (app: ElectronApplication): Promise<string[]> => app.evaluate(() => (globalThis as unknown as { __opened?: string[] }).__opened ?? []);
	/** What a new pane of the stack sees of `LINEAR_API_KEY`, in brackets (an unset variable is `[]`). */
	const paneLinearKey = async (): Promise<string> => {
		const h = new WorldHerdr(world);
		const text = await h.inPane(
			"linear-env",
			(out) => (isWindows ? `[IO.File]::WriteAllText('${out}', '[' + $env:LINEAR_API_KEY + ']')` : `printf '[%s]' "$LINEAR_API_KEY" > '${out}'`),
			world.home,
			120_000,
		);
		return text.trim();
	};
	const workFolderNow = (): string => readWizard().workFolder ?? join(world.home, "StrawBoss");
	/** The Safe Storage items of the shipped product and of this development build in the scratch keychain (macOS; Windows keeps the key in Local State). */
	const safeStorageItems = async (): Promise<{ shipped: unknown[]; dev: unknown[] }> =>
		isWindows ? { shipped: [], dev: [] } : { shipped: await rig.list(["Straw Boss Desk Safe Storage"]), dev: await rig.list(["Straw Boss Desk Dev Safe Storage"]) };
	let shippedSafeStorage: unknown[] = [];

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
		// The shipped product's Safe Storage item, if the scratch keychain holds one, must keep its modification time through the whole run (a local run never has the shipped name; the CI keychain starts empty).
		shippedSafeStorage = (await safeStorageItems()).shipped;
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

	it("Claude step: a refused code, then a planted code that reaches the stand-in's standard input and nowhere else, and the CLI's status says signed in (task 11)", async () => {
		assert.equal(await stepOf(page), "claude");
		// The status is read when the step opens: not signed in, Sign in first, and Later stays a choice.
		await page.locator("#claude-sign-in").waitFor({ timeout: 60_000 });
		assert.equal(await page.locator("#later").isVisible(), true, "Later is a choice");
		assert.equal(await page.locator("#step-next").count(), 0, "Next waits for a sign-in");
		assert.equal(await page.locator("#claude-sign-in").evaluate((el) => el.classList.contains("primary")), true);
		assert.equal(await page.locator('#claude-storage, [data-role="storage"]').count(), isWindows ? 1 : 0, "Windows says the sign-in is a plain-text file; macOS says nothing");
		await shotBoth(page, "claude-not-signed-in");
		await recordExternal(first);

		await page.locator("#claude-sign-in").click();
		await page.locator("#claude-code").waitFor({ timeout: 60_000 });
		const field = page.locator("#claude-code");
		assert.equal(await field.getAttribute("type"), "password", "the code field is masked");
		assert.equal(await field.getAttribute("autocomplete"), "off");
		assert.equal(await page.locator("form").count(), 0, "the field sits outside any form");
		const address = (await page.locator("#claude-url").innerText()).trim();
		assert.match(address, /^https:\/\/claude\.ai\/oauth\/authorize\?/, "the page shows the address the CLI printed");
		await shotBoth(page, "claude-code-field");
		// Open hands the CLI's own address to the OS; the page never opens one itself.
		await page.locator("#claude-open").click();
		await until("the address to be opened", 10_000, async () => (await openedExternal(first)).length === 1 || undefined, 100);
		assert.deepEqual(await openedExternal(first), [address]);

		// A code the stand-in refuses: the screen says so, with the CLI's line in Details, and Try again starts a new login.
		await field.fill("WRONG-CODE");
		await page.locator("#claude-send-code").click();
		await page.locator('[data-role="failed"]').waitFor({ timeout: 30_000 });
		assert.equal(await fieldsEmpty(page), true, "the field was cleared when the code was sent");
		await page.locator('[data-role="details"] summary').click();
		assert.match(await page.locator('[data-role="details"] pre').innerText(), /Invalid code/);
		assert.equal(await page.locator("#claude-retry").evaluate((el) => el.classList.contains("primary")), true);
		await shotBoth(page, "claude-refused");

		// The planted code.
		await page.locator("#claude-retry").click();
		await field.waitFor({ timeout: 60_000 });
		await field.fill(CLAUDE_CODE);
		assert.equal(await pageHolds(page, CLAUDE_CODE), false, "a typed value is not in the markup, storage or cookies");
		await page.locator("#claude-send-code").click();
		await page.locator("#step-next").waitFor({ timeout: 60_000 });
		assert.equal(await page.locator("#later").count(), 0, "Next replaces Later");
		assert.equal(await page.locator('[data-role="done"]').count(), 1);
		assert.equal(await fieldsEmpty(page), true);
		await shotBoth(page, "claude-signed-in");

		// The code went to the stand-in's standard input, once, and to nothing else.
		assert.equal(readFileSync(join(standIn(), "code.txt"), "utf8"), CLAUDE_CODE, "the stand-in read the planted code from its standard input");
		const calls = standInCalls();
		assert.ok(calls.some((c) => c.argv.join(" ") === "auth login"), "the login ran as `auth login`");
		assert.ok(calls.some((c) => c.argv.join(" ") === "auth status --json"), "and the status was read");
		for (const c of calls) {
			assert.equal(JSON.stringify(c).includes(CLAUDE_CODE), false, "no command line carries the code");
			assert.equal(c.config, world.layout.claude, "the app's own CLAUDE_CONFIG_DIR");
			assert.equal(c.secureStorageDir, null, "the variable that would move the Keychain item is never set");
		}
		assert.equal(logText().includes(CLAUDE_CODE), false, "no log holds the code");
		const found = scan(searchRoots(), CLAUDE_CODE, { skipDirs: [join(world.home, "Library", "Keychains")] });
		assert.equal(found.hits.length, 0, `the code is in ${found.hits.length} file(s) under the home or the temp folder`);
		assert.equal(await pageHolds(page, CLAUDE_CODE), false, "and not in the page, its storage or its cookies");
		assert.equal(eventsNamed("claude-code-sent").length, 2, "main logged that two codes were sent, never what they were");
		await page.locator("#step-next").click();
		await waitStep(page, "hosts");
	});

	it("GitHub step: a foreign gh:github.com entry stops it before any device code, and stays as it was", async () => {
		assert.equal(await stepOf(page), "hosts");
		await waitPhase(page, "github.com", "foreign");
		assert.equal((await page.locator('[data-role="foreign"]').innerText()).trim(), tr("zh-TW", "forge.foreign", { host: "github.com", tool: t("zh-TW", "forge.tool.github") }));
		for (const id of ['[data-role="device-code"]', '[data-role="sign-in"]', '[data-role="token"]']) assert.equal(await page.locator(id).count(), 0, `${id} is not on the refused step`);
		await page.locator('[data-role="details"] summary').click();
		assert.ok((await page.locator('[data-role="details"] .forge-entries').innerText()).includes(GH_FOREIGN.name), "Details names the entry");
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
		assert.equal((await page.locator('[data-role="foreign"]').innerText()).trim(), tr("zh-TW", "forge.foreign", { host: "gitlab.com", tool: t("zh-TW", "forge.tool.gitlab") }));
		assert.equal(await page.locator('[data-role="token"]').count(), 0, "the token field is not shown");
		assert.equal(await page.locator('[data-role="sign-in"]').count(), 0);
		await shotBoth(page, "accounts-gitlab-refused");
		assert.deepEqual(await rig.snapshot(GL_FOREIGN.name, GL_FOREIGN.account), foreignGl, "the entry has the same secret and the same modification time");
		assert.deepEqual(eventsNamed("forge-login-start"), []);
		// The PM removes their own entry; Try again passes the check and shows the token field (the "not signed in" state).
		await rig.seeder.remove(GL_FOREIGN.name, GL_FOREIGN.account);
		await page.locator('[data-role="retry"]').click();
		await waitPhase(page, "gitlab.com", "ready");
		const field = page.locator('[data-role="token"]');
		assert.equal(await field.getAttribute("type"), "password", "the field is masked");
		assert.equal(await field.getAttribute("autocomplete"), "off");
		assert.equal(await page.locator("#forge-token-reveal, .reveal").count(), 0, "there is no reveal toggle");
		await shotBoth(page, "accounts-gitlab-not-signed-in");
	});

	const finishHosts = async (): Promise<void> => {
		await page.locator("#hosts-next").click();
		await waitStep(page, "linear");
	};

	it("GitLab token login: verdict PASS, the created entries are recorded with their times, the token is nowhere on disk, in a log or in the page, and git pushes through it (SBD_GITLAB_TEST_TOKEN)", { skip: noToken }, async () => {
		await page.locator('[data-role="token"]').fill(GITLAB_TOKEN);
		await page.locator('[data-role="sign-in"]').click();
		await waitPhase(page, "gitlab.com", "done", 180_000);
		assert.equal(await page.locator('[data-role="token"]').count(), 0, "the field is gone");
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
		console.log(`accounts e2e: glab login verdict PASS, ${mine.length} entries recorded (${mine.map((e) => e.name).join(", ")})`);

		// Followup R3-F003: a token search over everything the app and its children wrote (the whole data root, the home it lies in, and the temp folder the app and every child were given, which lies
		// beside the home). The keychain file of the scratch HOME is the store itself. Seven forms are looked for (UTF-8, UTF-16LE, go-keyring's, base64, and HTTP Basic's base64 of oauth2:token).
		const found = scan([world.home, join(world.base, "tmp")], GITLAB_TOKEN, { skipDirs: [join(world.home, "Library", "Keychains")] });
		console.log(`token search: ${found.files} files, ${Math.round(found.bytes / 1_000_000)} MB, ${found.hits.length} hits, ${found.unread.length} listed as not read (links, files in use)`);
		// The files that could not be read, by path and the error code alone (never a content), so a reviewer sees what the search did not cover. Links are not followed by design (the tools folders
		// are full of them), so they are counted; every other unread path is listed.
		const links = found.unread.filter((u) => u.reason.startsWith("link:"));
		const others = found.unread.filter((u) => !u.reason.startsWith("link:"));
		console.log(`token search: ${links.length} links were not followed; ${others.length} other path(s) could not be read`);
		for (const u of others.slice(0, 40)) console.log(`token search: not read: ${u.path} (${/\b(EPERM|EBUSY|EACCES|ENOENT|EISDIR|EMFILE)\b/.exec(u.reason)?.[0] ?? u.reason.split(":")[0]})`);
		if (others.length > 40) console.log(`token search: not read: ... and ${others.length - 40} more`);
		assert.equal(found.hits.length, 0, `the token is in ${found.hits.length} file(s) under the home or the temp folder`);
		assert.deepEqual(found.unread.filter((u) => ownFolders().some((d) => under(d, u.path))).map((u) => u.reason), [], "every file of the app's own folders was read");
		assert.equal(logText().includes(GITLAB_TOKEN), false, "no log holds the token");
		assert.equal(
			await page.evaluate((needle) => [document.documentElement.outerHTML, JSON.stringify({ ...localStorage }), JSON.stringify({ ...sessionStorage }), document.cookie].some((part) => part.includes(needle)), GITLAB_TOKEN),
			false,
			"the page, its storage and its cookies do not hold the token",
		);
		assert.equal(logText().includes(`${GITLAB_TOKEN}`), false);

		// The stored token works through Git's credential helper: old sbd-ci-* branches swept, then one fixed branch per OS pushed and deleted in a `finally` (T10R-F004); the project's default branch is never touched.
		const { git, env } = gitExecutable();
		const dir = join(world.base, "push-check");
		mkdirSync(dir, { recursive: true });
		const g: GitRun = async (args, timeoutMs = 120_000) => run(git, args, { env, cwd: dir, timeoutMs });
		assert.equal((await g(["init", "-q", "-b", BRANCH])).code, 0);
		const committed = await g(["-c", "user.name=Straw Boss CI", "-c", "user.email=ci@example.invalid", "commit", "--allow-empty", "-q", "-m", "login check"]);
		assert.equal(committed.code, 0, `commit exited ${committed.code}`);
		const checked = await runPushCheck({ git: g, project: GITLAB_TEST_PROJECT, branch: BRANCH, log: (line) => console.log(`accounts e2e: ${line}`) });
		if (!checked.skipped) console.log(`accounts e2e: git pushed ${BRANCH} to the test project through the stored token and deleted it again`);

		await finishHosts();
	});

	it("Linear step with isEncryptionAvailable() false: the key is refused before it can be typed, nothing is written, and Later is still a choice (task 11)", async () => {
		if (!hasToken) {
			await page.locator("#later").click();
			await waitStep(page, "linear");
		}
		assert.equal(await stepOf(page), "linear");
		// The OS can encrypt here; a development build is told it cannot (SBD_TEST_NO_ENCRYPTION=1), as it is told the WSL bash.
		await close(first);
		first = await launch("zh-TW", { SBD_TEST_WSL_BASH: WSL_BASH, SBD_TEST_NO_ENCRYPTION: "1" });
		page = await pageOf(first, "wizard.html");
		await waitStep(page, "linear", 25 * 60_000);
		await page.locator("#linear-refusal").waitFor({ timeout: 30_000 });
		assert.equal((await page.locator("#linear-refusal p").innerText()).trim(), t("zh-TW", "linear.refused"));
		assert.equal(await page.locator("#linear-key").count(), 0, "there is no field to type a key into");
		assert.equal(await page.locator("#linear-save").count(), 0);
		assert.equal(await page.locator("#later").isVisible(), true, "Later is a choice");
		assert.equal(existsSync(join(world.layout.secrets, "linear.bin")), false, "nothing was written");
		await shotBoth(page, "linear-encryption-unavailable");
		assert.equal(eventsNamed("linear-key-saved").length, 0);
		// Back to a normal launch for the rest of the run.
		await close(first);
		first = await launch("zh-TW", { SBD_TEST_WSL_BASH: WSL_BASH });
		page = await pageOf(first, "wizard.html");
		await waitStep(page, "linear", 25 * 60_000);
	});

	it("Linear step: a key that is not a key is refused, a dummy key is saved encrypted, ttt is installed, the restart is offered, and after Restart now a new pane has LINEAR_API_KEY (task 11)", async () => {
		await page.locator("#linear-key").waitFor({ timeout: 60_000 });
		const field = page.locator("#linear-key");
		assert.equal(await field.getAttribute("type"), "password");
		assert.equal(await page.locator("form").count(), 0);
		assert.equal(await page.locator("#later").isVisible(), true, "Later is a choice");
		await shotBoth(page, "linear-not-saved");
		await field.fill("short");
		await page.locator("#linear-save").click();
		await page.locator('[data-role="invalid"]').waitFor({ timeout: 10_000 });
		await shotBoth(page, "linear-invalid");
		assert.equal(existsSync(join(world.layout.secrets, "linear.bin")), false, "an invalid key writes nothing");

		// A work folder that holds a `ttt` setup already is kept as it is, so `ttt init` makes no call to Linear (there is no Linear account here); `ttt` itself is installed for real.
		const work = workFolderNow();
		mkdirSync(join(work, ".ttt"), { recursive: true });
		writeFileSync(join(work, ".ttt", "config.toon"), "team: ci-stand-in\n");
		await page.locator("#linear-key").fill(LINEAR_KEY);
		assert.equal(await pageHolds(page, LINEAR_KEY), false, "a typed key is not in the markup, storage or cookies");
		await page.locator("#linear-save").click();
		await page.locator('[data-role="restart-offer"]').waitFor({ timeout: 300_000 });
		assert.equal(await fieldsEmpty(page), true, "the field was cleared when the key was sent");
		assert.equal(await page.locator('#linear-restart').evaluate((el) => el.classList.contains("primary")), true, "Restart now is the primary action");
		assert.equal(await page.locator("#linear-restart-later").isVisible(), true);
		assert.equal(await page.locator('[data-role="done"]').count(), 1);
		await shotBoth(page, "linear-restart-offered");

		// The key is encrypted on disk and nowhere else; ttt is installed and runs.
		const blob = readFileSync(join(world.layout.secrets, "linear.bin"));
		assert.equal(blob.includes(Buffer.from(LINEAR_KEY)), false, "linear.bin is encrypted");
		assert.ok(blob.length > LINEAR_KEY.length, "and holds something");
		const installed = readInstalled(world.layout);
		assert.ok(isInstalled(installed));
		const ttt = tttCommand(world.layout, installed.current, parseStack(JSON.parse(readFileSync(STACK_JSON, "utf8")) as unknown));
		assert.ok(ttt, "ttt is installed under the app's prefix");
		const version = await run((ttt as { file: string }).file, [...(ttt as { args: readonly string[] }).args, "--version"], { env: childEnvOf(world), timeoutMs: 120_000 });
		assert.equal(version.code, 0, `ttt --version: ${version.stderr.slice(0, 200)}`);
		assert.equal(eventsNamed("linear-init-kept").length, 1);
		assert.equal(logText().includes(LINEAR_KEY), false, "no log holds the key");

		// Herdr's environment is fixed for its lifetime: a pane opened now does not have the key; after Restart now it does.
		assert.equal(await paneLinearKey(), "[]", "a pane opened before the restart has no key");
		await page.locator("#linear-restart").click();
		await page.locator('#linear-restarted, [data-restart="restarted"]').first().waitFor({ timeout: 300_000 });
		await shotBoth(page, "linear-restarted");
		assert.equal(await paneLinearKey(), `[${LINEAR_KEY}]`, "a pane opened after the restart has LINEAR_API_KEY");
		const found = scan(searchRoots(), LINEAR_KEY, { skipDirs: [join(world.home, "Library", "Keychains")] });
		assert.equal(found.hits.length, 0, `the key is in ${found.hits.length} file(s) under the home or the temp folder`);
		assert.equal(logText().includes(LINEAR_KEY), false);
		assert.equal(await pageHolds(page, LINEAR_KEY), false);

		// The Safe Storage item of this development build exists on macOS; the shipped product's item is as it was.
		const items = await safeStorageItems();
		if (!isWindows) assert.ok(items.dev.length >= 1, "this build's Safe Storage item is in the scratch keychain");
		assert.deepEqual(items.shipped, shippedSafeStorage, "the shipped product's Safe Storage item, if any, has the same modification time");

		await page.locator("#step-next").click();
		await waitStep(page, "done");
	});

	it("puts off what is left and ends on the done step naming it", async () => {
		assert.equal(await stepOf(page), "done");
		assert.deepEqual(readWizard().later.map((l) => l.item), hasToken ? ["github"] : ["github", "gitlab"], "Claude and Linear are signed in, so only the code hosts are left");
		const pending = await page.locator("#done-pending").innerText();
		assert.ok(pending.includes("github.com"), pending);
		assert.equal(pending.includes("gitlab.com"), !hasToken, "GitLab is named only when it was put off");
		assert.equal(pending.includes("Claude") || pending.includes("Linear"), false, pending);
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
		assert.match(later, hasToken ? /GitHub \(github\.com\)\.$/ : /GitHub \(github\.com\) and GitLab \(gitlab\.com\)\.$/, "the list is joined the way English joins it");
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
		await settings.locator('#accounts-claude').waitFor({ timeout: 10_000 });
		await shot(settings, "wizard-settings-zh-TW");
		await settings.locator("#settings-back").click();
		// Back over the GUI: the notices follow the language chosen meanwhile.
		const again = await pageOf(first, "screen.html");
		await until("the zh-TW banner", 30_000, async () => (await again.locator('[data-notice="wsl"] .notice-text').innerText()) === zhTW.welcome.wsl, 250);
		const laterZh = await again.locator('[data-notice="later"] .notice-text').innerText();
		assert.match(laterZh, hasToken ? /GitHub（github\.com）。$/ : /GitHub（github\.com）和 GitLab（gitlab\.com）。$/, laterZh);
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
		const note = panelOf(settings, "github.com", "left-alone");
		assert.equal((await note.locator("p").first().innerText()).trim(), tr("zh-TW", "forge.leftAlone", { host: "github.com" }));
		assert.equal((await note.locator("p").first().innerText()).includes(GH_FOREIGN.name), false, "the sentence names no store key");
		await note.locator('[data-role="details"] summary').click();
		assert.ok((await note.locator('[data-role="details"] .forge-entries').innerText()).includes(GH_FOREIGN.name), "Details names the entry");
		// One card per host, with the flow inside it, and no id repeated on the page (T10R-F003, SA-T10-1).
		assert.equal(await settings.locator("li.forge-card").count(), 2, "one card per code host");
		assert.equal(await rowOf(settings, "github.com").locator(".forge-panel").count(), 1, "the flow is inside its host's card");
		assert.equal(await settings.evaluate(() => { const ids = [...document.querySelectorAll("[id]")].map((e) => e.id); return ids.length === new Set(ids).size; }), true, "no id repeats on the page");
		assert.equal(eventsNamed("forge-logout", "gh").length, logouts, "no gh logout ran");
		assert.ok(eventsNamed("forge-logout-skipped", "gh").length >= 1, "the skip is logged");
		assert.deepEqual(await rig.snapshot(GH_FOREIGN.name, GH_FOREIGN.account), foreignGh, "same secret, same modification time");
		await shotSettingsBoth(settings, "accounts-github-sign-out-left-alone");

		// The PM removes their entry; Sign in passes the check and offers GitHub's own button (the "not signed in" state). The button is not pressed: approval needs a person.
		await rig.seeder.remove(GH_FOREIGN.name, GH_FOREIGN.account);
		await rowOf(settings, "github.com").locator(".forge-sign-in-again").click();
		await waitPhase(settings, "github.com", "ready");
		await rowOf(settings, "github.com", "not-signed-in").waitFor({ timeout: 30_000 });
		assert.equal(await panelOf(settings, "github.com").locator('[data-role="sign-in"]').count(), 1);
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
		await panelOf(settings, "gitlab.com").locator('[data-role="token"]').fill(GITLAB_TOKEN);
		await panelOf(settings, "gitlab.com").locator('[data-role="sign-in"]').click();
		await waitPhase(settings, "gitlab.com", "done", 180_000);
		await rowOf(settings, "gitlab.com", "signed-in").waitFor({ timeout: 30_000 });
		assert.ok(recordOf().entries.some((e) => e.host === "gitlab.com"));
		assert.equal(logText().includes(GITLAB_TOKEN), false, "no log holds the token");
		console.log("accounts e2e: Sign out of the owned GitLab login ran glab auth logout and emptied the record; Sign in again worked");
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
		assert.equal((await panelOf(settings, "gitlab.com").locator('[data-role="foreign"]').innerText()).trim(), tr("zh-TW", "forge.changed", { host: "gitlab.com", tool: t("zh-TW", "forge.tool.gitlab") }));
		await panelOf(settings, "gitlab.com").locator('[data-role="details"] summary').click();
		assert.ok((await panelOf(settings, "gitlab.com").locator('[data-role="details"] .forge-entries').innerText()).includes(target.name), "Details names the entry");
		assert.equal(await panelOf(settings, "gitlab.com").locator('[data-role="token"]').count(), 0);
		await shotSettingsBoth(settings, "accounts-gitlab-changed-refused");

		// The test deletes the PM's entry (and whatever else of the login is left); the record drops it and Sign in again passes the check.
		for (const e of await rig.list(entryNames("gitlab", "gitlab.com"))) await rig.seeder.remove(e.name, e.account);
		await panelOf(settings, "gitlab.com").locator('[data-role="retry"]').click();
		await waitPhase(settings, "gitlab.com", "ready");
		assert.deepEqual(recordOf(), { schema: 1, entries: [], left: [] });
		await shotSettingsBoth(settings, "accounts-gitlab-after-removal");
		console.log("accounts e2e: foreign write over the owned entry: Sign out ran no logout, row said changed, record has it left, Sign in again stopped at the check and passed after the entry was deleted");
	});

	const claudeCard = (p: Page, state?: string) => p.locator(`li.account-card[data-account="claude"]${state === undefined ? "" : `[data-state="${state}"]`}`);
	const linearCard = (p: Page, state?: string) => p.locator(`li.account-card[data-account="linear"]${state === undefined ? "" : `[data-state="${state}"]`}`);

	it("settings' Claude card: signed in, Sign out through the CLI, Sign in again with the code field inside the card (task 11)", async () => {
		await settingsIn(settings, "zh-TW");
		await claudeCard(settings, "signed-in").waitFor({ timeout: 60_000 });
		assert.equal(await claudeCard(settings).locator(".claude-sign-out").count(), 1);
		assert.equal(await settings.evaluate(() => { const ids = [...document.querySelectorAll("[id]")].map((e) => e.id); return ids.length === new Set(ids).size; }), true, "no id repeats on the page");
		await shotSettingsBoth(settings, "claude-card-signed-in");

		await claudeCard(settings).locator(".claude-sign-out").click();
		await claudeCard(settings, "not-signed-in").waitFor({ timeout: 60_000 });
		assert.ok(standInCalls().some((c) => c.argv.join(" ") === "auth logout"), "the CLI's own logout ran");
		assert.equal(await claudeCard(settings).locator(".claude-sign-out").count(), 0, "Sign out is offered only while signed in");
		await shotSettingsBoth(settings, "claude-card-not-signed-in");

		await claudeCard(settings).locator(".claude-sign-in").click();
		await claudeCard(settings).locator("#claude-code").waitFor({ timeout: 60_000 });
		await shotSettingsBoth(settings, "claude-card-code-field");
		const code = `${CLAUDE_CODE}-again`;
		await claudeCard(settings).locator("#claude-code").fill(code);
		await claudeCard(settings).locator("#claude-send-code").click();
		await claudeCard(settings, "signed-in").waitFor({ timeout: 60_000 });
		assert.equal(readFileSync(join(standIn(), "code.txt"), "utf8"), code);
		assert.equal(logText().includes(code), false);
		assert.equal(scan(searchRoots(), code, { skipDirs: [join(world.home, "Library", "Keychains")] }).hits.length, 0);
		assert.equal(await pageHolds(settings, code), false);
		assert.equal(await fieldsEmpty(settings), true);
	});

	it("settings' Linear card: saved, Sign out deletes the key and offers a restart, Sign in saves a new one (task 11)", async () => {
		await settingsIn(settings, "zh-TW");
		await linearCard(settings, "saved").waitFor({ timeout: 60_000 });
		await shotSettingsBoth(settings, "linear-card-saved");

		await linearCard(settings).locator(".linear-sign-out").click();
		await linearCard(settings, "not-saved").waitFor({ timeout: 60_000 });
		assert.equal(existsSync(join(world.layout.secrets, "linear.bin")), false, "the key file is gone");
		await settings.locator('[data-role="restart-offer"]').waitFor({ timeout: 30_000 });
		await shotSettingsBoth(settings, "linear-card-removed-restart-offered");
		await settings.locator("#linear-restart-later").click();
		await settings.locator('[data-role="restart-later-note"]').waitFor({ timeout: 10_000 });

		await linearCard(settings).locator(".linear-sign-in").click();
		await settings.locator("#linear-key").waitFor({ timeout: 30_000 });
		await shotSettingsBoth(settings, "linear-card-key-field");
		const second = `lin_api_${randomBytes(20).toString("hex")}`;
		await settings.locator("#linear-key").fill(second);
		await settings.locator("#linear-save").click();
		await linearCard(settings, "saved").waitFor({ timeout: 300_000 });
		await settings.locator('[data-role="restart-offer"]').waitFor({ timeout: 300_000 });
		await shotSettingsBoth(settings, "linear-card-saved-restart-offered");
		await settings.locator("#linear-restart-later").click();
		assert.equal(readFileSync(join(world.layout.secrets, "linear.bin")).includes(Buffer.from(second)), false, "encrypted");
		assert.equal(logText().includes(second), false);
		assert.equal(scan(searchRoots(), second, { skipDirs: [join(world.home, "Library", "Keychains")] }).hits.length, 0);
		assert.equal(await pageHolds(settings, second), false);
		const items = await safeStorageItems();
		assert.deepEqual(items.shipped, shippedSafeStorage, "the shipped product's Safe Storage item is as it was");
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
		assert.equal((await panelOf(s, "gitlab.com").locator('[data-role="refusal"] p').first().innerText()).trim(), t("zh-TW", "forge.storeUnavailable"));
		assert.equal(await s.locator('[data-role="token"]').count(), 0, "no token field is offered");
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
