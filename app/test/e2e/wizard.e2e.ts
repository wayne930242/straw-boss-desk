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
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { request as httpRequest } from "node:http";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { _electron as electron, type ElectronApplication, type Locator, type Page } from "playwright-core";
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
import { CLOCK_SKEW_MS, eventsSince as lineEventsSince } from "../harness/log-events.ts";
import { rpcPanes, strings, type RpcPanes, type RpcPi } from "../harness/rpc-pane.ts";
import { CHILD_NAME, LOOKUP_COMMAND, modelsJson, RESULT_PREFIX, startStubModel, SUBAGENT_MARKER, type StubModel } from "../harness/stub-model.ts";
import { createPlatform } from "../../src/main/platform/index.ts";
import { childEnvOf, createWorld, disposeWorld, isWindows, noteUserPath, plantShellStartupDecoy, run, seedDownloads, WorldHerdr, type World } from "../harness/e2e-light.ts";
import { tttCommand } from "../../src/main/accounts/linear.ts";
import { parseStack } from "../../src/main/bootstrap/stack.ts";
import { assertElevatedRunner } from "../harness/elevation.ts";
import { developerToolsAsideScope } from "../harness/devtools-aside.ts";
import { hostedCase, type FixtureIO } from "../harness/hosted.ts";
import { createTestCa } from "../harness/test-ca.ts";
import { credUrl } from "../harness/cred-url.ts";

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
/** The update the repository serves for the raw-URL check of the Team recipe card (task 15): the same team at a higher version. */
const ciUpdateRecipe = fileURLToPath(new URL("../fixtures/ci-update.strawboss.json", import.meta.url));
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
	/**
	 * What to print when a project card did not end done (CIN-F002): its text, its Details (a closed `<details>` hides them from `innerText`, which is why two Windows failures left no reason), and
	 * the last `project-*` events of the runtime log, which carry the server's reason and the step it failed at.
	 */
	const projectProblem = async (card: Locator): Promise<string> => {
		const text = await card.innerText().catch(() => "(the card is gone)");
		const details = await card.locator(".update-detail").evaluateAll((items) => items.map((i) => i.textContent ?? "")).catch(() => [] as string[]);
		const events = logEvents()
			.filter((e) => typeof e.event === "string" && e.event.startsWith("project-") && e.event !== "project-git")
			.slice(-8)
			.map((e) => JSON.stringify(e).slice(0, 400));
		return `${text} | details: ${JSON.stringify(details)} | last project events: ${events.join(" / ")}`;
	};
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
		// The rows ask the store and the CLIs again when the section opens; a picture is taken once they have answered.
		await s.locator('.forge-panel[data-phase="checking"]').first().waitFor({ state: "detached", timeout: 60_000 });
	};
	/** `focus` is a card that the picture must show: it is scrolled into view (the Linear card lies below the fold). */
	const shotSettingsBoth = async (s: Page, name: string, focus?: string): Promise<void> => {
		const framed = async (locale: "en" | "zh-TW"): Promise<void> => {
			await settingsIn(s, locale);
			// Not `scrollIntoViewIfNeeded`: it waits for the element to hold still, and a card that is drawn again while its row answers never does.
			if (focus !== undefined) await s.evaluate((selector) => document.querySelector(selector)?.scrollIntoView({ block: "center" }), focus);
			await shot(s, `${name}-${locale}`);
		};
		await framed("zh-TW");
		await framed("en");
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
		panes = rpcPanes(world, hostPlatform);
		await noteUserPath(world);
		// macOS: the PM's own startup file, with a fake gh and git ahead of the real ones and GH_TOKEN=fake (a guarded fixture: written into the scratch home only, before the first launch).
		if (!isWindows) plantShellStartupDecoy(world);
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
		await stub?.close().catch(() => undefined);
		const pathBefore = world.userPathBefore;
		const realPath = world.realUserPath;
		await disposeWorld(world);
		if (aside.state === "active") await aside.leave(ioForSudo);
		// Windows: the entry the app added is off again, and the value is what it was, type included (spec: step 7).
		if (realPath) assert.deepEqual(await world.userPath.read(), pathBefore ?? null, "the user PATH is as it was before the run");
	});

	let first: ElectronApplication;
	let page: Page;

	// ---- steps 3 and 5 to 9 of the spec's list (task 15) ---------------------------------------------------------------------------------------------------------------------------
	let panes: RpcPanes;
	let stub: StubModel | undefined;
	const hostPlatform = createPlatform();
	const slotFile = (name: string) => join(world.layout.agent, "straw-boss", name);
	const readJsonFile = <T>(file: string): T | undefined => {
		try {
			return JSON.parse(readFileSync(file, "utf8")) as T;
		} catch {
			return undefined;
		}
	};
	interface Proc {
		pid: number;
		startTime: string | null;
	}
	const startRecord = () => readJsonFile<{ herdr: Proc | null; sb: Proc | null }>(join(world.layout.state, "start.json"));
	const serverRecord = () => readJsonFile<{ pid: number; started?: string; gui?: { stopped?: boolean } }>(slotFile("server.json"));
	const startLines = (): Array<Record<string, unknown>> => {
		const file = join(world.layout.logs, "start.jsonl");
		return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l) as Record<string, unknown>]; } catch { return []; } }) : [];
	};
	const startEventsSince = (event: string, since: number, skewMs = 0) => lineEventsSince(startLines(), event, since, skewMs);
	/** On a failed step, the tail of the start log (events and their short details only): the CI log is all there is of a runner. */
	const withStartTail = (fn: () => Promise<void>, name: string) => async (): Promise<void> => {
		try {
			await fn();
		} catch (error) {
			const tail = startLines().slice(-40).map((l) => `${String(l.t).slice(11, 23)} ${String(l.event)} ${["detail", "which", "pid", "kind", "exit"].filter((k) => l[k] !== undefined).map((k) => `${k}=${JSON.stringify(l[k]).slice(0, 120)}`).join(" ")}`);
			console.log(`--- start.jsonl tail after "${name}" failed ---\n${tail.join("\n")}\n---`);
			throw error;
		}
	};
	const httpStatus = (url: string): Promise<number> =>
		new Promise((resolve) => {
			const req = httpRequest(url, { method: "GET", timeout: 5000 }, (res) => {
				res.resume();
				resolve(res.statusCode ?? 0);
			});
			req.on("timeout", () => req.destroy());
			req.on("error", () => resolve(0));
			req.end();
		});
	const inScreen = (app: ElectronApplication, code: string): Promise<unknown> =>
		app.evaluate(({ webContents }, source) => webContents.getAllWebContents().find((w) => w.getURL().endsWith("screen.html"))?.executeJavaScript(source, true), code);
	const shellView = () =>
		inScreen(first, `(() => { const c = document.getElementById('card'); return { mode: document.body.dataset.mode, screen: c.hidden ? null : c.dataset.screen ?? null }; })()`) as Promise<{ mode: string; screen: string | null } | undefined>;
	const shellVisible = () => first.evaluate(({ BaseWindow }) => (BaseWindow.getAllWindows()[0]?.contentView.children[1] as unknown as { getVisible(): boolean } | undefined)?.getVisible());
	const sbCli = (...args: string[]) => {
		const found = readInstalled(world.layout);
		assert.ok(isInstalled(found));
		return run(found.node, [found.sbCli, ...args], { env: childEnvOf(world), timeoutMs: 180_000 });
	};
	/** The sb server's pid, killed the way a crash would, after the platform confirms it is the app's own program. */
	const killSb = async (): Promise<number> => {
		const rec = serverRecord();
		assert.ok(rec?.pid, "server.json names the sb server");
		const info = (await hostPlatform.processes.inspect([rec.pid]))[0];
		assert.ok(info?.executable?.startsWith(world.layout.tools.root), `the sb server runs from the tools folder: ${info?.executable}`);
		process.kill(rec.pid, "SIGKILL");
		return rec.pid;
	};
	/** A workspace of Herdr by its label, and one of its panes (a pi in a split of that pane is a member of the base, as a PM's own is). */
	const baseOf = async (label: string): Promise<{ workspace: string; pane: string }> => {
		const h = new WorldHerdr(world);
		const parse = (text: string, key: "workspaces" | "panes"): Array<Record<string, unknown>> => ((JSON.parse(text) as { result: Record<string, Array<Record<string, unknown>>> }).result[key] ?? []);
		const workspaces = parse((await h.cli(["workspace", "list"])).stdout, "workspaces");
		const found = workspaces.find((w) => JSON.stringify(w).includes(label));
		assert.ok(found, `no workspace labelled ${label}: ${workspaces.length} workspaces`);
		const workspace = String(found.workspace_id);
		const mine = (list: Array<Record<string, unknown>>) => list.filter((p) => p.workspace_id === workspace || p.workspace === workspace);
		let inBase = mine(parse((await h.cli(["pane", "list"])).stdout, "panes"));
		if (inBase.length === 0) inBase = parse((await h.cli(["pane", "list", "--workspace", workspace])).stdout, "panes");
		assert.ok(inBase.length > 0, `no pane in ${workspace}: the workspace has the keys ${Object.keys(found).join(",")}`);
		return { workspace, pane: String(inBase[0]?.pane_id) };
	};
	/** The quit: nothing is left under <root>/tools, Herdr's socket does not answer, and the stop sequence ran to its end and was ok (spec: step 8). */
	const assertQuitClean = async (app: ElectronApplication, what: string): Promise<void> => {
		const began = Date.now();
		await app.close();
		const deadline = Date.now() + 180_000;
		while (Date.now() < deadline && ((await panes.underTools()).length > 0 || (await panes.herdrAnswers()))) await sleep(1000);
		assert.deepEqual((await panes.underTools()).map((p) => `${p.pid} ${basename(p.executable ?? "")}`), [], `${what}: a program is left under <root>/tools`);
		assert.equal(await panes.herdrAnswers(), false, `${what}: Herdr's socket still answers`);
		const quit = lineEventsSince(logEvents(), "quit-stop", began, CLOCK_SKEW_MS).at(-1);
		const stop = lineEventsSince(logEvents(), "stop-end", began, CLOCK_SKEW_MS).at(-1);
		assert.ok(quit !== undefined && stop !== undefined, `${what}: the quit ran the stop sequence to its end`);
		assert.equal(stop.herdrAnswers, false, `${what}: the stop saw Herdr's socket go quiet`);
		assert.equal(quit.ok, true, `${what}: the quit's stop was not ok: ${JSON.stringify(stop)}`);
		assert.deepEqual(stop.leftovers ?? [], [], `${what}: the stop reported a program left under tools`);
	};

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

	it("Claude step: a refused code, then a planted code that reaches the stand-in's standard input and nowhere else, and the CLI's status says signed in (task 11)", { timeout: 240_000 }, async () => {
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

		// A line the CLI cannot read keeps it waiting: the screen says it was not accepted and offers the field again (R11-F003).
		await field.fill("MALFORMED-CODE");
		await page.locator("#claude-send-code").click();
		await page.locator('[data-role="code-refused"]').waitFor({ timeout: 30_000 });
		await field.waitFor({ timeout: 30_000 });
		assert.equal(await fieldsEmpty(page), true, "the field was cleared when the code was sent");
		await shotBoth(page, "claude-code-refused");

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
		assert.equal(eventsNamed("claude-code-sent").length, 3, "main logged that three codes were sent (a malformed one, a refused one, the planted one), never what they were");
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

	it("Linear step with isEncryptionAvailable() false: the key is refused before it can be typed, nothing is written, and Later is still a choice (task 11)", { timeout: 1_800_000 }, async () => {
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

	it("Linear step: a key that is not a key is refused, a dummy key is saved encrypted, ttt is installed, the restart is offered, and after Restart now a new pane has LINEAR_API_KEY (task 11)", { timeout: 1_200_000 }, async () => {
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
		const primary = await page.locator('#linear-restart').evaluate((el) => el.classList.contains("primary"));
		if (!primary) {
			// Something came before Restart now in the row (a failed setup): say what, with the page and the log, so the run explains itself.
			await shot(page, "linear-restart-not-primary-zh-TW");
			const buttons = await page.locator("button").evaluateAll((all) => all.map((b) => `${b.id}:${b.className}`));
			const flow = await page.locator("[data-role]").evaluateAll((all) => all.map((e) => `${e.getAttribute("data-role")}=${(e.textContent ?? "").slice(0, 160)}`));
			const events = logEvents().filter((e) => /linear|ttt|engine|stage/i.test(String(e.event))).slice(-12).map((e) => JSON.stringify(e).slice(0, 300));
			assert.fail(`Restart now is not the primary action; buttons ${buttons.join(", ")}; roles ${flow.join(" | ")}; log ${events.join(" / ")}`);
		}
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
		await waitStep(page, "projects");
	});

	it("projects step: the public repository is cloned beside the home base with the app's Git and opened as a base, in both languages (task 12)", { timeout: 900_000 }, async () => {
		assert.equal(await stepOf(page), "projects");
		assert.equal(await page.locator("#projects-next").isDisabled(), true, "Next waits for the rows");
		await shot(page, "projects-start-zh-TW");
		const card = page.locator('li.project-card[data-folder="hello-world"]');
		await card.waitFor({ timeout: 60_000 });
		await until("the repository to be copied and opened", 600_000, async () => (await card.getAttribute("data-state")) === "done" || (await card.getAttribute("data-state")) === "failed", 500);
		assert.equal(await card.getAttribute("data-state"), "done", await projectProblem(card));
		assert.equal(await page.locator("#projects-next").isDisabled(), false);
		assert.equal(await page.locator('[data-role="links"]').count(), 0, "the public repository has no link Windows cannot make");
		const clone = join(workFolderNow(), "hello-world");
		assert.ok(existsSync(join(clone, ".git")), "the repository is beside the home base");
		assert.ok(existsSync(join(workFolderNow(), "Straw Boss")), "the home base is there too");
		const { git, env: gitEnv } = gitExecutable();
		const origin = await run(git, ["config", "--get", "remote.origin.url"], { env: gitEnv, cwd: clone, timeoutMs: 60_000 });
		assert.equal(origin.stdout.trim(), "https://github.com/octocat/Hello-World.git");
		const list = await new WorldHerdr(world).cli(["workspace", "list"]);
		assert.ok(list.stdout.includes("Hello World"), `the clone is a base in Herdr's list: ${list.stdout.slice(0, 400)}`);
		assert.equal(eventsNamed("project-git").some((e) => JSON.stringify(e.args).includes("symlinks")), false, "no Git call names core.symlinks");
		await shotBoth(page, "projects-done");
		await page.locator("#projects-next").click();
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
		await until("the cloned repository's base in the page", 90_000, async () => String(await inGui(first, "document.body.innerText")).includes("Hello World"), 500);
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

	it("step 3: every stage is verified, the status says live, primary and desk, one home base has one tower, and the clone is a base beside it", async () => {
		const record = readJsonFile<{ stages: Record<string, { status: string; evidence: string }> }>(join(world.layout.state, "bootstrap.json"));
		assert.ok(record, "state/bootstrap.json is there");
		const stages = Object.entries(record.stages);
		assert.ok(stages.length >= 10, `the install recorded its stages: ${stages.length}`);
		assert.deepEqual(stages.filter(([, r]) => r.status !== "ok" || r.evidence === "").map(([name, r]) => `${name}: ${r.status}`), [], "every stage is verified");
		const installed = readInstalled(world.layout);
		assert.ok(isInstalled(installed));
		const status = await run(installed.node, [installed.sbCli, "status"], { env: childEnvOf(world), timeoutMs: 120_000 });
		assert.equal(status.code, 0);
		const parsed = JSON.parse(status.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "{}") as Record<string, unknown>;
		assert.deepEqual([parsed.state, parsed.primary, parsed.desk], ["live", true, true], statusSummary(status.stdout));
		const h = new WorldHerdr(world);
		const list = (text: string, key: string): Array<Record<string, unknown>> => ((JSON.parse(text) as { result: Record<string, Array<Record<string, unknown>>> }).result[key] ?? []);
		const workspaces = list((await h.cli(["workspace", "list"])).stdout, "workspaces");
		const towers = list((await h.cli(["pane", "list"])).stdout, "panes").filter((p) => (p.tokens as { sb_role?: string } | undefined)?.sb_role === "tower");
		console.log(`herdr: ${workspaces.length} workspaces (${workspaces.map((w) => String(w.label ?? w.name ?? "?")).join(", ")}), ${towers.length} tower pane(s)`);
		assert.equal(towers.length, 1, "one home base has one tower");
		assert.equal(workspaces.filter((w) => JSON.stringify(w).includes("Hello World")).length, 1, "the clone is one base beside the home base");
		assert.ok(workspaces.length >= 2, "the home base and the clone");
		assert.ok(existsSync(join(workFolderNow(), "Straw Boss", ".git")) || existsSync(join(workFolderNow(), "Straw Boss")), "the home base folder exists");
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

	it("settings' Claude card: signed in, Sign out through the CLI, Sign in again with the code field inside the card (task 11)", { timeout: 300_000 }, async () => {
		await settingsIn(settings, "zh-TW");
		await claudeCard(settings, "signed-in").waitFor({ timeout: 60_000 });
		assert.equal(await claudeCard(settings).locator(".claude-sign-out").count(), 1);
		assert.equal(await settings.evaluate(() => { const ids = [...document.querySelectorAll("[id]")].map((e) => e.id); return ids.length === new Set(ids).size; }), true, "no id repeats on the page");
		await shotSettingsBoth(settings, "claude-card-signed-in", 'li.account-card[data-account="claude"]');

		await claudeCard(settings).locator(".claude-sign-out").click();
		await claudeCard(settings, "not-signed-in").waitFor({ timeout: 60_000 });
		assert.ok(standInCalls().some((c) => c.argv.join(" ") === "auth logout"), "the CLI's own logout ran");
		assert.equal(await claudeCard(settings).locator(".claude-sign-out").count(), 0, "Sign out is offered only while signed in");
		await shotSettingsBoth(settings, "claude-card-not-signed-in", 'li.account-card[data-account="claude"]');

		await claudeCard(settings).locator(".claude-sign-in").click();
		await claudeCard(settings).locator("#claude-code").waitFor({ timeout: 60_000 });
		await shotSettingsBoth(settings, "claude-card-code-field", 'li.account-card[data-account="claude"]');
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

	it("settings' Linear card: saved, Sign out deletes the key and offers a restart, Sign in saves a new one (task 11)", { timeout: 900_000 }, async () => {
		await settingsIn(settings, "zh-TW");
		await linearCard(settings, "saved").waitFor({ timeout: 60_000 });
		await shotSettingsBoth(settings, "linear-card-saved", 'li.account-card[data-account="linear"]');

		await linearCard(settings).locator(".linear-sign-out").click();
		await linearCard(settings, "not-saved").waitFor({ timeout: 60_000 });
		assert.equal(existsSync(join(world.layout.secrets, "linear.bin")), false, "the key file is gone");
		await settings.locator('[data-role="restart-offer"]').waitFor({ timeout: 30_000 });
		await shotSettingsBoth(settings, "linear-card-removed-restart-offered", 'li.account-card[data-account="linear"]');
		await settings.locator("#linear-restart-later").click();
		await settings.locator('[data-role="restart-later-note"]').waitFor({ timeout: 10_000 });

		await linearCard(settings).locator(".linear-sign-in").click();
		await settings.locator("#linear-key").waitFor({ timeout: 30_000 });
		await shotSettingsBoth(settings, "linear-card-key-field", 'li.account-card[data-account="linear"]');
		const second = `lin_api_${randomBytes(20).toString("hex")}`;
		await settings.locator("#linear-key").fill(second);
		await settings.locator("#linear-save").click();
		await linearCard(settings, "saved").waitFor({ timeout: 300_000 });
		await settings.locator('[data-role="restart-offer"]').waitFor({ timeout: 300_000 });
		await shotSettingsBoth(settings, "linear-card-saved-restart-offered", 'li.account-card[data-account="linear"]');
		await settings.locator("#linear-restart-later").click();
		assert.equal(readFileSync(join(world.layout.secrets, "linear.bin")).includes(Buffer.from(second)), false, "encrypted");
		assert.equal(logText().includes(second), false);
		assert.equal(scan(searchRoots(), second, { skipDirs: [join(world.home, "Library", "Keychains")] }).hits.length, 0);
		assert.equal(await pageHolds(settings, second), false);
		const items = await safeStorageItems();
		assert.deepEqual(items.shipped, shippedSafeStorage, "the shipped product's Safe Storage item is as it was");
	});

	// Step 5 to 8 of the spec's list run in the root the wizard just installed, with the app that installed it: a pi turn against the stub model, the follower, the panes, and the quit. The stub is the
	// harness's own (`stub-model.ts`), written into the agent folder's `models.json` and default model, never configured by the app. On macOS the PM's startup file with the fake gh and git was
	// written into the scratch home before the first launch (`before`).
	let member: RpcPi | undefined;
	let bossSeq = 0;
	let clonePane: { workspace: string; pane: string } | undefined;
	const clonePath = (): string => join(workFolderNow(), "hello-world");
	/** `/boss <line>` typed into a pi of the clone's base: that pane is the PM's, where a `/boss` command is the PM's (the home base's own pane is the tower's prompt, which takes none). */
	const boss = async (line: string): Promise<void> => {
		assert.ok(clonePane, "the clone's base was found");
		member ??= await panes.openRpcPi("member", clonePane.pane, clonePath());
		const open = member;
		const seen = open.lines().length;
		const answer = await open.call({ id: `boss-${++bossSeq}`, type: "prompt", message: `/boss ${line}` }, 90_000).catch(async (error: Error) => {
			await open.dump();
			throw error;
		});
		assert.equal(answer.success, true, `/boss ${line}: ${JSON.stringify(answer)}`);
		const told = open.lines().slice(seen).filter((l) => (l as { type?: string; method?: string }).type === "extension_ui_request" && (l as { method?: string }).method === "notify") as Array<{ message?: string; notifyType?: string }>;
		assert.deepEqual(told.filter((n) => n.notifyType === "error").map((n) => n.message), [], `/boss ${line} reported an error`);
	};

	it("step 5: a pi turn through the stub model in the cloned repository's base", { timeout: 600_000 }, async () => {
		stub = await startStubModel();
		writeFileSync(join(world.layout.agent, "models.json"), modelsJson(stub.baseUrl));
		const settingsFile = join(world.layout.agent, "settings.json");
		writeFileSync(settingsFile, JSON.stringify({ ...(readJsonFile<Record<string, unknown>>(settingsFile) ?? {}), defaultProvider: "stub", defaultModel: "stub-1", enabledModels: ["stub/stub-1"] }, null, 2));
		clonePane = await baseOf("Hello World");
		const known = await panes.paneIds();
		const programsBefore = await panes.toolPids();
		const turn = await panes.openRpcPi("turn", clonePane.pane, clonePath());
		try {
			const sent = await turn.call({ id: "turn", type: "prompt", message: "Say hello." }, 60_000);
			assert.equal(sent.success, true, JSON.stringify(sent));
			await until("the stub model's answer", 180_000, () => strings(turn.lines()).some((s) => s.includes("Stub model: ready.")), 500);
			await until("the turn to end", 60_000, () => turn.lines().some((l) => (l as { type?: string }).type === "agent_end"), 500);
			assert.ok(stub.requests.some((r) => r.text.includes("Say hello.")), "the turn reached the stub model");
		} catch (error) {
			await turn.dump();
			throw error;
		} finally {
			await panes.settlePanes(known, programsBefore);
		}
	});

	it("step 6: `cli.mjs restart` is logged by pid change while the window stays live, and start.json holds the new pid with its start time", { timeout: 400_000 }, withStartTail(async () => {
		const firstUrl = (await guiUrl(first)) as string;
		assert.equal(await httpStatus(firstUrl), 200);
		const before = startRecord()?.sb?.pid as number;
		const since = Date.now();
		const restarted = await sbCli("restart", "--reason", "e2e wizard");
		assert.equal(restarted.code, 0, `cli.mjs restart: ${restarted.stdout.slice(0, 300)} ${restarted.stderr.slice(0, 300)}`);
		const sb = await until("start.json to hold the new sb server with its start time", 120_000, () => {
			const r = startRecord()?.sb;
			return r && r.pid !== before && r.startTime ? r : undefined;
		});
		assert.notEqual(sb.pid, before);
		await until("the restart in logs/start.jsonl", 30_000, () => startEventsSince("follow-restart", since).length >= 1);
		assert.equal(await guiUrl(first), firstUrl, "the window stays on its page: a restart keeps the address");
		assert.equal(await httpStatus(firstUrl), 200);
		assert.equal(JSON.stringify(startRecord()).includes(`"pid":${before},`), false, "the old sb record is gone");
	}, "restart"));

	it("step 6: a killed sb server is followed within 15 s, and the new pid is recorded the same way", { timeout: 600_000 }, withStartTail(async () => {
		const old = startRecord()?.sb?.pid as number;
		const killed = await killSb();
		const began = Date.now();
		assert.equal(killed, old);
		await until("the follower to act on the kill", 15_000, () => startEventsSince("follow-restart", began).length + startEventsSince("follow-gone", began).length > 0);
		console.log(`followed the killed sb server after ${((Date.now() - began) / 1000).toFixed(1)} s`);
		await until("the new sb server recorded", 180_000, () => {
			const r = startRecord()?.sb;
			return r && r.pid !== old ? r : undefined;
		});
		const url = (await until("the GUI view's address", 30_000, () => guiUrl(first))) as string;
		await until("the GUI to answer 200", 120_000, async () => (await httpStatus(url)) === 200);
		await until("the new sb start time", 120_000, () => startRecord()?.sb?.startTime);
		console.log(`the killed sb server was back after ${((Date.now() - began) / 1000).toFixed(1)} s`);
		assert.ok(startEventsSince("follow-restart", began).length + startEventsSince("follow-gone", began).length > 0);
	}, "kill"));

	it("step 6: `/boss gui stop` shows the shell screen, and Start brings the GUI back", { timeout: 900_000 }, withStartTail(async () => {
		const since = Date.now();
		try {
			await boss("gui stop");
			await until("the gui-stopped screen", 90_000, async () => (await shellView())?.screen === "gui-stopped");
			assert.equal(await shellVisible(), true);
			await inScreen(first, `document.getElementById('retry').click()`);
			await until("the GUI to come back and the screen to go", 120_000, async () => {
				const url = await guiUrl(first);
				return url && (await httpStatus(url)) === 200 && (await shellVisible()) === false ? url : undefined;
			});
			assert.ok(startEventsSince("follow-up", since).some((l) => l.detail === "start button"), "the Start button ran `up`");
			assert.equal(serverRecord()?.gui?.stopped ?? false, false);
		} finally {
			// The next step opens its own pi: one that has seen the server stop and start again is not the one that starts a pane.
			await member?.close().catch(() => undefined);
			member = undefined;
		}
	}, "gui stop"));

	it("step 7: in a pane of the cloned repository's base, gh, git and pi resolve to the app's folders, and a subagent's do too", { timeout: 900_000 }, async () => {
		assert.ok(clonePane, "the clone's base was found");
		const known = await panes.paneIds();
		const programsBefore = await panes.toolPids();
		const parent = await panes.openRpcPi("parent", clonePane.pane, clonePath());
		try {
			const lookup = await parent.call({ id: "lookup", type: "bash", command: LOOKUP_COMMAND }, 180_000);
			assert.equal(lookup.success, true, JSON.stringify(lookup));
			const resolved = panes.resolutions(lookup.data?.output ?? "");
			panes.assertAppFolders(resolved, ["gh", "git", "pi"]);
			console.log(`pane resolves: ${JSON.stringify(Object.fromEntries(Object.entries(resolved).map(([k, v]) => [k, v.replace(/[^\x20-\x7e]/g, "?")])))}`);
			// One subagent through the scripted stub: the parent calls `subagent`, the child runs the lookup in its bash tool, and the parent hears of its completion. The `bash` command above
			// makes pi run a turn of its own, so the prompt is queued behind it when that turn still runs.
			const dispatched = await parent.call({ id: "dispatch", type: "prompt", message: `${SUBAGENT_MARKER} go`, streamingBehavior: "followUp" }, 60_000);
			assert.equal(dispatched.success, true, JSON.stringify(dispatched));
			const heard = await until("the parent to hear of the child", 300_000, () => strings(parent.lines()).find((s) => s.includes(`Sub-agent "${CHILD_NAME}"`) && /completed|failed/.test(s)), 500).catch(async (error: Error) => {
				await parent.dump();
				throw error;
			});
			assert.match(heard, new RegExp(`Sub-agent "${CHILD_NAME}" completed`), `the child's result: ${heard.slice(0, 600)}`);
			assert.ok(heard.includes(RESULT_PREFIX), "the child's final answer carries what it saw");
			const child = panes.resolutions(heard);
			panes.assertAppFolders(child, ["gh", "git", "pi"]);
			if (isWindows) panes.assertAppFolders(child, ["bash"]);
			if (isWindows) {
				// The user PATH holds one entry of the app, `tools\shims`, and its registry value kept its type.
				const now = await world.userPath.read();
				const mine = (now?.value ?? "").split(";").filter((p) => p.toLowerCase().startsWith(world.root.toLowerCase()));
				assert.deepEqual(mine.map((p) => p.toLowerCase()), [world.layout.tools.shims.toLowerCase()], "exactly one app entry on the user PATH");
				if (world.userPathBefore) assert.equal(now?.kind, world.userPathBefore.kind, "the PATH value kept its registry type");
			}
		} finally {
			await panes.settlePanes(known, programsBefore);
		}
	});

	it("step 8: the quit leaves no Herdr or sb server process of this root, the Herdr socket goes quiet, and the stop ran to its end", { timeout: 400_000 }, async () => {
		await assertQuitClean(first, "the first quit");
		assert.equal(existsSync(join(world.layout.state, "start.json")), false, "nothing is left running, so start.json goes");
	});

	it("macOS: a launch whose HOME has no keychain stops Sign in again at the store probe at once, and no token reaches the disk", { skip: isWindows ? "macOS only" : false, timeout: 240_000 }, async () => {
		await close(first);
		const empty = mkdtempSync("/tmp/sbd-nokc-");
		// The saved Linear key is set aside for this launch: with no keychain in HOME, a start that decrypts the key would wait on the OS's own "no keychain" dialog, which is the OS's question and not this test's.
		const keyFile = join(world.layout.secrets, "linear.bin");
		const heldKey = `${keyFile}.held`;
		if (existsSync(keyFile)) renameSync(keyFile, heldKey);
		// SBD_TEST_NO_ENCRYPTION keeps the Linear card's probe from asking the OS for its encryption: with no keychain in HOME that question is the OS's "no keychain" dialog, and it would hold the main process.
		const app = await launch("zh-TW", { HOME: empty, STRAW_BOSS_DESK_ROOT: world.root, SBD_TEST_WSL_BASH: WSL_BASH, SBD_TEST_NO_ENCRYPTION: "1" });
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
		if (existsSync(heldKey)) renameSync(heldKey, keyFile);
	});

	it("step 9: a later launch opens no wizard, reaches the GUI in time, keeps the bases and the banner's language, and its quit leaves nothing", async () => {
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
		assert.equal(await again.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows().length), 1);
		const notices = await pageOf(again, "screen.html");
		await notices.locator('[data-notice="wsl"]').waitFor({ timeout: 30_000 });
		assert.equal(await notices.locator('[data-notice="wsl"] .notice-text').innerText(), zhTW.welcome.wsl, "the saved language wins over the OS language");
		// The bases are kept: the home base's folder and the clone, as Herdr lists them and as the GUI shows them.
		assert.ok(existsSync(join(workFolderNow(), "Straw Boss")), "the home base is still there");
		const herdr = new WorldHerdr(world);
		await until("the clone's base in Herdr's list after the relaunch", 90_000, async () => (await herdr.cli(["workspace", "list"])).stdout.includes("Hello World"), 1000);
		await until("the clone's base in the page", 90_000, async () => String(await inGui(again, "document.body.innerText")).includes("Hello World"), 500);
		await assertQuitClean(again, "the second quit");
	});

	it("step 8, adoption: the app's main process killed leaves the stack running, and the relaunch reaches the GUI, starts no second Herdr and logs start-time-adopted for both servers", { timeout: 600_000 }, async () => {
		const herdrCount = async (): Promise<number> => {
			let lowest = Number.POSITIVE_INFINITY;
			for (let i = 0; i < 3; i++) {
				lowest = Math.min(lowest, (await panes.underTools()).filter((p) => /^herdr(\.exe)?$/i.test(basename(p.executable ?? ""))).length);
				if (i < 2) await sleep(700);
			}
			return lowest;
		};
		const live = await launch("en-US", { SBD_TEST_WSL_BASH: WSL_BASH });
		await until("the GUI view to load the server's address", 240_000, () => guiUrl(live));
		const record = await until("both start times in start.json", 120_000, () => {
			const r = startRecord();
			return r?.herdr?.startTime && r.sb?.startTime ? r : undefined;
		});
		const herdrProcesses = await herdrCount();
		assert.ok(herdrProcesses >= 1, "Herdr runs from the tools folder");
		const pid = await live.evaluate(() => process.pid);
		process.kill(pid, "SIGKILL");
		await until("the app's process to be gone", 60_000, () => {
			try {
				process.kill(pid, 0);
				return undefined;
			} catch {
				return true;
			}
		}, 250);
		await sleep(2000);
		assert.equal(await panes.herdrAnswers(), true, "Herdr keeps running");
		assert.equal((await hostPlatform.processes.inspect([record.sb?.pid as number]))[0]?.startTime !== null, true, "the sb server keeps running");
		const began = Date.now();
		const second = await launch("en-US", { SBD_TEST_WSL_BASH: WSL_BASH });
		const url = await until("the GUI view to load the server's address", 45_000, () => guiUrl(second));
		console.log(`relaunch after a killed app reached the GUI in ${((Date.now() - began) / 1000).toFixed(1)} s`);
		assert.ok(url);
		assert.equal(await herdrCount(), herdrProcesses, "no second Herdr");
		const adopted = await until("the recorded pids to be held", 60_000, () => {
			const r = startRecord();
			return r?.herdr?.startTime && r.sb?.startTime ? r : undefined;
		});
		assert.equal(adopted.herdr?.pid, record.herdr?.pid);
		assert.equal(adopted.sb?.pid, record.sb?.pid);
		await until("the adoption to be logged for both servers", 60_000, () => {
			const kinds = lineEventsSince(logEvents(), "start-time-adopted", began, CLOCK_SKEW_MS).map((l) => l.kind);
			return kinds.includes("herdr") && kinds.includes("sb") ? true : undefined;
		});
		await assertQuitClean(second, "the quit after the adoption");
	});

	it("settings' Team recipe: an update served by a local fixture server shows its change list and applies; each fetch refusal shows its sentence; Keep and Replace (task 12)", { timeout: 1_800_000 }, async () => {
		// A local HTTPS server under a throw-away CA stands in for the internet (development build only, SBD_TEST_RECIPE_FETCH): names map to public-looking addresses that the app dials on 127.0.0.1,
		// and every fetch rule still applies to them. `internal.example.com` maps to a private address, so a redirect to it is refused as a host.
		const names = ["recipes.example.com", "other.example.com", "internal.example.com"];
		const ca = createTestCa("recipe", names);
		const caFile = join(world.base, "recipe-ca.pem");
		writeFileSync(caFile, ca.caPem);
		const seen: Array<{ url: string; headers: Record<string, string | string[] | undefined> }> = [];
		let route: (url: string) => { status: number; headers?: Record<string, string>; body?: string } = () => ({ status: 404 });
		const server: HttpsServer = createHttpsServer({ cert: ca.server.certPem, key: ca.server.keyPem }, (request, response) => {
			seen.push({ url: request.url ?? "", headers: request.headers });
			const r = route(request.url ?? "");
			response.writeHead(r.status, r.headers ?? {}).end(r.body ?? "");
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const port = (server.address() as AddressInfo).port;
		const seam = JSON.stringify({ ca: caFile, hosts: { "recipes.example.com": { address: "93.184.216.34", port }, "other.example.com": { address: "93.184.216.35", port }, "internal.example.com": { address: "10.1.2.3", port } } });
		const base = JSON.parse(readFileSync(ciRecipe, "utf8")) as Record<string, unknown>;
		const served = (over: Record<string, unknown>): string => JSON.stringify({ ...base, ...over });
		const NEW_REPO = { url: "https://github.com/octocat/Spoon-Knife.git", folder: "spoon-knife", label: "Spoon Knife" };
		try {
			const app = await launch("zh-TW", { SBD_TEST_WSL_BASH: WSL_BASH, SBD_TEST_RECIPE_FETCH: seam });
			const notices = await pageOf(app, "screen.html");
			await notices.locator("#open-settings").click();
			const s = await pageOf(app, "settings.html");
			await s.locator('button.nav-item[data-section="recipe"]').click();
			await s.locator("#recipe-cards").waitFor({ timeout: 30_000 });
			const updateCard = s.locator('li[data-role="update"]');
			const stateOf = async (): Promise<string> => (await updateCard.getAttribute("data-state")) ?? "";
			const checkNow = async (): Promise<void> => {
				await s.locator("#recipe-check").click();
				await until("the check to end", 60_000, async () => (await stateOf()) !== "checking", 200);
			};
			/** The card in zh-TW and in English, as a picture each (the language buttons are in Computer). */
			const recipeBoth = async (name: string): Promise<void> => {
				for (const locale of ["zh-TW", "en"] as const) {
					await s.locator('button.nav-item[data-section="computer"]').click();
					await s.locator(`.language-button[data-locale="${locale}"]`).click();
					await until(`${locale} in settings`, 10_000, async () => (await s.evaluate(() => document.documentElement.lang)) === locale, 100);
					await s.locator('button.nav-item[data-section="recipe"]').click();
					await s.locator("#recipe-cards").waitFor({ timeout: 10_000 });
					assert.doesNotMatch(await s.locator("body").innerText(), /\{[A-Za-z]+\}/, `${name} ${locale} has an unfilled placeholder`);
					await shot(s, `recipe-${name}-${locale}`);
				}
				await s.locator('button.nav-item[data-section="computer"]').click();
				await s.locator('.language-button[data-locale="zh-TW"]').click();
				await s.locator('button.nav-item[data-section="recipe"]').click();
				await s.locator("#recipe-cards").waitFor({ timeout: 10_000 });
			};
			assert.equal(await s.locator("#recipe-name").innerText(), "CI 測試團隊");
			await recipeBoth("idle");

			// Each fetch rule, as the PM sees its refusal.
			const refusals: Array<[string, string, () => { status: number; headers?: Record<string, string>; body?: string }]> = [
				["scheme", "scheme", () => ({ status: 302, headers: { location: "http://recipes.example.com/ci-wizard.json" } })],
				["credentials", "credentials", () => ({ status: 302, headers: { location: credUrl("https://user<c>secret@other.example.com/ci-wizard.json") } })],
				["host", "host", () => ({ status: 302, headers: { location: "https://internal.example.com/ci-wizard.json" } })],
				["redirects", "redirects", () => ({ status: 302, headers: { location: "https://recipes.example.com/ci-wizard.json" } })],
				["too-large", "too-large", () => ({ status: 200, body: "x".repeat(300 * 1024) })],
				["status", "status", () => ({ status: 404 })],
			];
			for (const [name, reason, answer] of refusals) {
				route = () => answer();
				await checkNow();
				assert.equal(await stateOf(), "refused", name);
				assert.equal(await s.locator("#recipe-update-note").getAttribute("data-reason"), reason, name);
				await recipeBoth(`refused-${name}`);
			}
			assert.equal(seen.some((r) => JSON.stringify(r.headers).toLowerCase().includes("cookie") || "authorization" in r.headers), false, "no cookie and no authorization header ever reached the server");
			route = () => ({ status: 200, body: "{not json" });
			await checkNow();
			assert.equal(await s.locator("#recipe-update-note").getAttribute("data-reason"), "invalid");
			await recipeBoth("refused-invalid");
			route = () => ({ status: 200, body: served({ id: "someone-else", version: "9.0.0" }) });
			await checkNow();
			assert.equal(await s.locator("#recipe-update-note").getAttribute("data-reason"), "other-id");
			await recipeBoth("refused-other-id");

			// An update: the change list first, nothing applied; Keep mine keeps it out of the next check; then Apply.
			route = () => ({ status: 200, body: served({ version: "1.1.0", repos: [...(base.repos as unknown[]), NEW_REPO] }) });
			const before = readdirSync(world.layout.recipe).map((f) => readFileSync(join(world.layout.recipe, f), "utf8"));
			await checkNow();
			assert.equal(await stateOf(), "offered");
			const changes = await s.locator("#recipe-changes li").evaluateAll((items) => items.map((i) => i.getAttribute("data-change")));
			assert.deepEqual(changes, ["version", "repo-added"]);
			assert.deepEqual(readdirSync(world.layout.recipe).map((f) => readFileSync(join(world.layout.recipe, f), "utf8")), before, "nothing was written by the check");
			assert.deepEqual(await s.locator('li[data-role="update"] button').evaluateAll((b) => b.map((x) => [x.id, x.className])), [["recipe-apply", "primary"], ["recipe-keep", ""]], "Apply first");
			await recipeBoth("offered");
			await s.locator("#recipe-keep").click();
			assert.equal(await stateOf(), "kept");
			await recipeBoth("kept");
			await checkNow();
			assert.equal(await stateOf(), "kept", "the same version is not offered again");
			route = () => ({ status: 200, body: served({ version: "1.2.0", repos: [...(base.repos as unknown[]), NEW_REPO] }) });
			await checkNow();
			assert.equal(await stateOf(), "offered", "a higher version is");
			await s.locator("#recipe-apply").click();
			await until("the update to apply", 900_000, async () => ["applied", "failed", "error"].includes(await stateOf()), 1000).catch(async (error: Error) => {
				const events = logEvents().slice(-25).map((e) => JSON.stringify(e).slice(0, 260));
				throw new Error(`${error.message}; the card says ${await updateCard.innerText()}; last events: ${events.join(" / ")}`);
			});
			assert.equal(await stateOf(), "applied", await updateCard.innerText());
			const active = readdirSync(world.layout.recipe).map((f) => JSON.parse(readFileSync(join(world.layout.recipe, f), "utf8")) as { version: string });
			assert.deepEqual(active.map((r) => r.version), ["1.2.0"]);
			const spoon = s.locator('li.project-card[data-folder="spoon-knife"]');
			await spoon.waitFor({ timeout: 120_000 });
			await until("the new repository to be copied and opened", 600_000, async () => ["done", "failed"].includes((await spoon.getAttribute("data-state")) ?? ""), 500);
			assert.equal(await spoon.getAttribute("data-state"), "done", await projectProblem(spoon));
			assert.ok(existsSync(join(workFolderNow(), "spoon-knife", ".git")));
			assert.ok((await new WorldHerdr(world).cli(["workspace", "list"])).stdout.includes("Spoon Knife"), "the new repository is a base");
			assert.equal(eventsNamed("project-git").filter((e) => Array.isArray(e.args) && e.args[0] === "clone" && JSON.stringify(e.args).includes("Hello-World")).length, 1, "the repository that did not change was not cloned again");
			await recipeBoth("applied");
			await checkNow();
			assert.equal(await stateOf(), "idle", "the applied version is the one the address serves");

			// Replace: a chosen file with another id is shown as another recipe and kept out without being applied.
			const other = join(world.base, "other-recipe.json");
			writeFileSync(other, served({ id: "other-team", name: "Other team", version: "1.0.0", updateUrl: undefined }));
			await stubDialog(app, other);
			await s.locator("#recipe-replace").click();
			await until("the chosen file to be offered", 30_000, async () => (await stateOf()) === "offered", 200);
			assert.match(await s.locator("#recipe-update-note").innerText(), /Other team|另一份配方/);
			await recipeBoth("replace-offered");
			await s.locator("#recipe-keep").click();
			assert.deepEqual(readdirSync(world.layout.recipe).map((f) => (JSON.parse(readFileSync(join(world.layout.recipe, f), "utf8")) as { id: string }).id), ["ci-wizard"]);
		} finally {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			// A test that failed must not leave its app running: the next launch would meet the single-instance lock and fail with `electron.launch: WebSocket error: read ECONNRESET`.
			for (const a of apps) await close(a);
		}
	});

	it("settings' Team recipe against the repository's raw URL: the check fetches the fixture over the internet, shows its change list, and Apply applies it (task 15)", { timeout: 1_800_000 }, async () => {
		// No seam: the app's own fetch, with its SSRF rules (https, no proxy, the resolved address checked and dialled), reads the fixture from raw.githubusercontent.com. On `main` that is the
		// spec's address; a run of another ref reads the fixture at its own ref (SBD_RECIPE_FIXTURE_REF), so a branch can be proved before it is merged.
		const ref = process.env.SBD_RECIPE_FIXTURE_REF || "main";
		const rawUrl = `https://raw.githubusercontent.com/wayne930242/straw-boss-desk/${ref}/app/test/fixtures/ci-update.strawboss.json`;
		const fixture = JSON.parse(readFileSync(ciUpdateRecipe, "utf8")) as { version: string; updateUrl: string };
		assert.equal(fixture.updateUrl, "https://raw.githubusercontent.com/wayne930242/straw-boss-desk/main/app/test/fixtures/ci-update.strawboss.json", "the fixture names its own address on main");
		assert.equal(fixture.version, "2.0.0");
		const activeFile = (): { version: string; updateUrl?: string } => {
			const files = readdirSync(world.layout.recipe);
			assert.equal(files.length, 1, `one active recipe: ${files.join(", ")}`);
			return JSON.parse(readFileSync(join(world.layout.recipe, files[0] as string), "utf8")) as { version: string; updateUrl?: string };
		};
		// The recipe that points at the raw address is a file the PM chooses (Replace); it is older than the fixture, so the fixture is an update to it.
		const mine = join(world.base, "ci-raw-recipe.json");
		writeFileSync(mine, JSON.stringify({ ...activeFile(), version: "1.3.0", updateUrl: rawUrl }));
		const app = await launch("zh-TW", { SBD_TEST_WSL_BASH: WSL_BASH });
		try {
			const notices = await pageOf(app, "screen.html");
			await notices.locator("#open-settings").click();
			const s = await pageOf(app, "settings.html");
			await s.locator('button.nav-item[data-section="recipe"]').click();
			await s.locator("#recipe-cards").waitFor({ timeout: 30_000 });
			const updateCard = s.locator('li[data-role="update"]');
			const stateOf = async (): Promise<string> => (await updateCard.getAttribute("data-state")) ?? "";
			const settled = (what: string, ms: number, ok: string[]) =>
				until(what, ms, async () => ok.includes(await stateOf()) || undefined, 500).catch(async (error: Error) => {
					const events = logEvents().slice(-25).map((e) => JSON.stringify(e).slice(0, 260));
					throw new Error(`${error.message}; the card says ${await updateCard.innerText()}; last events: ${events.join(" / ")}`);
				});
			await stubDialog(app, mine);
			await s.locator("#recipe-replace").click();
			await until("the chosen file to be offered", 30_000, async () => (await stateOf()) === "offered", 200);
			await s.locator("#recipe-apply").click();
			await settled("the chosen file to apply", 900_000, ["applied", "failed", "error"]);
			assert.equal(await stateOf(), "applied", await updateCard.innerText());
			assert.deepEqual([activeFile().version, activeFile().updateUrl], ["1.3.0", rawUrl]);

			// The check itself: a real fetch of the fixture, its change list first and nothing written.
			const since = Date.now();
			const before = readdirSync(world.layout.recipe).map((f) => readFileSync(join(world.layout.recipe, f), "utf8"));
			await s.locator("#recipe-check").click();
			await settled("the check to end", 90_000, ["offered", "refused", "idle", "kept", "error"]);
			assert.equal(await stateOf(), "offered", `the raw fetch: ${await updateCard.innerText()}; ${JSON.stringify(lineEventsSince(logEvents(), "recipe-fetch-refused", since, CLOCK_SKEW_MS))}`);
			const fetched = lineEventsSince(logEvents(), "recipe-fetched", since, CLOCK_SKEW_MS);
			assert.deepEqual(fetched.map((e) => e.ok), [true], "the check fetched and validated the fixture");
			assert.deepEqual(lineEventsSince(logEvents(), "recipe-fetch-refused", since, CLOCK_SKEW_MS), [], "no fetch rule refused it");
			const changes = await s.locator("#recipe-changes li").evaluateAll((items) => items.map((i) => i.getAttribute("data-change")));
			assert.deepEqual(changes, ["version", "instructions"]);
			assert.match(await s.locator("#recipe-changes").innerText(), /2\.0\.0/);
			assert.deepEqual(readdirSync(world.layout.recipe).map((f) => readFileSync(join(world.layout.recipe, f), "utf8")), before, "nothing was written by the check");
			await shot(s, "recipe-raw-offered-zh-TW");
			await s.locator("#recipe-apply").click();
			await settled("the update to apply", 900_000, ["applied", "failed", "error"]);
			assert.equal(await stateOf(), "applied", await updateCard.innerText());
			assert.equal(activeFile().version, "2.0.0", "the fixture's version is the active one");
			await shot(s, "recipe-raw-applied-zh-TW");
		} finally {
			for (const a of apps) await close(a);
		}
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
