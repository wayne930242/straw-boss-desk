import { app, clipboard, dialog, Menu, net, powerMonitor, powerSaveBlocker, safeStorage, session, shell, utilityProcess } from "electron";
import electronUpdater from "electron-updater";
import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { arch, homedir, release } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { pickLocale } from "../shared/locale.ts";
import { identityFromProductName } from "./build.ts";
import { dataRoot, electronDir, computeLayout, toolDir, toolExecutable } from "./paths.ts";
import { buildEnv } from "./env.ts";
import { DeskWindow } from "./desk-window.ts";
import { GuiPresenter } from "./gui-presenter.ts";
import { bannerState, failureState, screenState } from "./shell-state.ts";
import { tailLines } from "./bootstrap/log.ts";
import { menuTemplate } from "./menu.ts";
import { catalogs } from "../renderer/i18n/index.ts";
import { format } from "../renderer/i18n/index.ts";
import type { SettingsSection, SettingsView, ShellNotice } from "../shared/wizard.ts";
import { UtilityEngineHost, type UtilityChild } from "./wizard/engine-host.ts";
import { WizardController } from "./wizard/controller.ts";
import type { ValidateRecipe } from "./wizard/recipe-intake.ts";
import { createPlatform } from "./platform/index.ts";
import { execRunner } from "./platform/exec.ts";
import { checkPaneLookups, stubbedPaneFindings, type PaneFindings } from "./pane-path.ts";
import { hasStopStack } from "./runtime/args.ts";
import { loadStartConfig } from "./runtime/config.ts";
import { RuntimeLog, runtimeRedactor } from "./runtime/log.ts";
import { attachPower } from "./runtime/power.ts";
import { Supervisor } from "./runtime/supervisor.ts";
import { isInstalled, readInstalled } from "./runtime/readiness.ts";
import { ForgeAccounts } from "./accounts/session.ts";
import { spawnLogin } from "./accounts/cli.ts";
import { ClaudeAccounts, spawnClaude, testClaudeCommand, type ClaudeCommand } from "./accounts/claude.ts";
import { LinearAccounts, tttCommand } from "./accounts/linear.ts";
import { agentModules, locateClaude } from "./bootstrap/stages/claude.ts";
import { QuitGate } from "./quit-gate.ts";
import { stopForRemoval, stopSequence, type StopParts } from "./stop-sequence.ts";
import { earlyLaunch } from "./pre-launch.ts";
import { KeepAwake } from "./computer/keep-awake.ts";
import { ComputerService } from "./computer/service.ts";
import { DiagnosticsService } from "./diagnostics/service.ts";
import { RemovalService } from "./removal/service.ts";
import { spawnCleanup } from "./removal/cleanup.ts";
import { afterRemovalChange, ExitCleanup, holdQuit, quitsWhenWindowsClose, removalStop } from "./removal/wiring.ts";
import { guideUrl } from "./guide.ts";
import { platformKey } from "./bootstrap/stack.ts";
import { StateStore } from "./bootstrap/state.ts";
import { loadActiveStack } from "./wizard/stack-source.ts";
import type { SpawnFn } from "./runtime/herdr.ts";
import { ShellUpdater, electronUpdaterDriver, MAX_INSTALLER_BYTES } from "./update/shell.ts";
import { FetchRefused, fetchPublicText } from "./net/safe-fetch.ts";
import { callEnv, ProjectGit, type GitExec } from "./projects/git.ts";
import { netFetch } from "./bootstrap/download.ts";
import { hostProbe } from "./projects/reach.ts";
import { OpenBaseClient } from "./projects/open-base.ts";
import { ProjectRecordStore } from "./projects/record.ts";
import { ProjectsRunner } from "./projects/runner.ts";
import { RecipeService } from "./recipe/service.ts";
import { RecipeMemoStore } from "./recipe/store.ts";
import { runUpdateEngine } from "./update/engine-run.ts";
import { StackUpdater, type EngineRunResult, type FetchedBytes } from "./update/stack.ts";
import { UpdatesService } from "./update/service.ts";
import { feedUrlProblem, updateConfig } from "./update/verify.ts";

// The lifecycle: single instance, Chromium's profile inside the app data root, one window holding the two views the design needs, the GUI view (pi-straw-boss) and the shell
// view (welcome, the runtime page for notices and screens; wizard and settings later) above it (`desk-window.ts`), and the runtime supervisor that starts the stack at launch,
// follows it, and stops it at quit (tasks 8a and 8b).

const identity = identityFromProductName(app.getName());
const root = dataRoot({ env: process.env, argv: process.argv.slice(1), platform: process.platform, home: homedir() });

// Before anything is created in the data root (spec: Uninstall and data): a **Remove all data** whose cleanup never ran is finished now, the uninstaller's `--remove-user-path` is carried out,
// and a `--stop-stack` with no data root ends at once. None of these may re-create the root, so they run before `userData` is set and before the single-instance lock. A launch that finds the removal's owner
// alive hands over to it through that lock on the owner's folder and ends; one that finds the lock free goes on with the launch (`earlyLaunch`).
// No root: the early platform compiles the native helper in memory, since caching it would create `<root>/helpers` (and so the root) for a PM who deleted the folder by hand.
const earlyPlatform = createPlatform();
const early = await earlyLaunch({
	argv: process.argv,
	root,
	home: homedir(),
	platform: process.platform,
	userPath: earlyPlatform.userPath,
	processes: earlyPlatform.processes,
	instanceLock: { setUserData: (path) => app.setPath("userData", path), lock: () => app.requestSingleInstanceLock(), release: () => app.releaseSingleInstanceLock() },
});
if (early.action === "stop") {
	dialog.showErrorBox(format(catalogs.en.pending.failedTitle, {}), `${format(catalogs.en.pending.failedBody, { folder: early.folder })}\n\n${format(catalogs["zh-TW"].pending.failedBody, { folder: early.folder })}\n\n${early.detail}`);
}
if (early.action === "stop" || early.action === "exit") process.exit(early.code);

// userData moves first: the single-instance lock is keyed on it, and Chromium must never write into the roaming %APPDATA%.
mkdirSync(electronDir(root), { recursive: true });
app.setPath("userData", electronDir(root));

const home = homedir();
const layout = computeLayout({ root, home, platform: process.platform === "win32" ? "win32" : "darwin" });
// The credential shapes of `recipe/secret-patterns.json`, shipped beside the app by `scripts/copy-assets.ts`: a missing or damaged file stops the app before it logs anything.
const assetsDir = join(import.meta.dirname, "..", "assets");
const secretPatterns: unknown = JSON.parse(readFileSync(join(assetsDir, "secret-patterns.json"), "utf8"));
const runtimeLog = new RuntimeLog({ dir: layout.logs, redactor: runtimeRedactor(secretPatterns) });
// `logs/shell.jsonl`: the shell's own events, the code-host sign-ins among them (no token, no code, no command output beyond one redacted line).
const shellLog = new RuntimeLog({ dir: layout.logs, redactor: runtimeRedactor(secretPatterns), file: "shell.jsonl" });
// The recipe validator is a plain module beside the recipe schema (`recipe/validate.mjs`), copied to `dist/assets/recipe` by `scripts/copy-assets.ts`; it is loaded from there, not bundled.
const { validateRecipe, privateOrLocalHost } = (await import(pathToFileURL(join(assetsDir, "recipe", "validate.mjs")).href)) as { validateRecipe: ValidateRecipe; privateOrLocalHost: (hostname: string) => boolean };
const platform = createPlatform({ root });
const run = execRunner();

// One `utilityProcess` per engine run (spec: Decisions, Where the engine runs); `engine.js` starts its message loop when it finds a parent port.
/**
 * What a pane's `bash` would resolve to (the WSL check): the real walk on Windows. A development build also answers the e2e's stub (`stubbedPaneFindings`), on macOS too, where no real check exists,
 * so the welcome line and the banner are proved on both runners.
 */
const NO_FINDINGS: PaneFindings = { firstBash: null, wslBash: false, machinePi: null, machineBun: null, machineBunx: null };
const paneCheck: (() => Promise<PaneFindings>) | undefined =
	layout.platform === "win32" || identity.kind === "dev"
		? async () => stubbedPaneFindings(process.env, identity.kind === "dev") ?? (layout.platform === "win32" ? await checkPaneLookups({ run, locate: platform.locate, exists: existsSync, env: process.env }) : NO_FINDINGS)
		: undefined;

const engineHost = new UtilityEngineHost({
	// SAFETY: a `UtilityProcess` has every member of `UtilityChild`; the cast only narrows its `on` overloads to the two events the host listens to.
	fork: () => utilityProcess.fork(join(import.meta.dirname, "bootstrap", "engine.js"), [], { serviceName: "straw-boss-desk-engine", stdio: "ignore" }) as unknown as UtilityChild,
});

const supervisor = new Supervisor({
	layout,
	home,
	platform,
	run,
	// SAFETY: a `ChildProcess` has every member of `HerdrChild`; the cast only narrows `spawn`'s many overloads to the one call the supervisor makes.
	spawn: spawn as unknown as SpawnFn,
	appEnv: process.env,
	config: () => loadStartConfig(layout, home),
	log: (fields) => runtimeLog.event(fields),
	// Follow the GUI once the stack runs: restarts, a moved address, a stopped GUI, a gone one (task 8b).
	follow: {},
	resolveProxy: (url) => session.defaultSession.resolveProxy(url),
	// The wizard runs the engine as a `utilityProcess`; a lock it holds is ours, so Repair leaves a running install's lock alone.
	isOurEngine: (pid) => engineHost.pid === pid,
	// What a pane's `bash` would resolve to, at every start (the WSL notice).
	...(paneCheck === undefined ? {} : { checkPane: paneCheck }),
	// The Linear key, decrypted at each start for the Herdr server's environment only (`linear` is built below; a start runs after the module has loaded).
	linearKey: () => linear.read(),
});

let desk: DeskWindow | undefined;

// The code-host sign-ins (task 10): the store probe, the existing-sign-in check, the device code and token logins, the verdict, and the removal of a login.
const accounts = new ForgeAccounts({
	layout,
	credentials: platform.credentials,
	run,
	spawn: spawnLogin,
	appEnv: process.env,
	current: () => {
		const found = readInstalled(layout);
		return isInstalled(found) ? found.current : null;
	},
	proxyEnv: (hosts) => supervisor.engineProxyEnv(hosts),
	log: (fields) => shellLog.event(fields),
	// The addresses are built by `accounts/session.ts` from a host the recipe listed: https, the host's own device page or token page.
	openExternal: (url) => void shell.openExternal(url),
	writeClipboard: (text) => clipboard.writeText(text),
});

/** The active tool versions, or null before the install is complete. */
const installedTools = () => {
	const found = readInstalled(layout);
	return isInstalled(found) ? found.current : null;
};

// Main's redactors hide a value that main holds in flight (the Claude code, the Linear key) by exact match, in both of its logs.
const holdSecret = (value: string): void => {
	runtimeLog.redactor.add(value);
	shellLog.redactor.add(value);
};
const releaseSecret = (value: string): void => {
	runtimeLog.redactor.remove(value);
	shellLog.redactor.remove(value);
};

// The Claude sign-in (task 11): `claude auth login` of the Agent SDK's bundled executable with the app's own `CLAUDE_CONFIG_DIR`. A development build answers the e2e's stand-in (`SBD_TEST_CLAUDE_CMD`).
const claudeCommand = (): ClaudeCommand | null => {
	const stub = identity.kind === "dev" ? testClaudeCommand(process.env) : null;
	if (stub !== null) return stub;
	const found = locateClaude(agentModules(layout), platformKey(process.platform, process.arch));
	return found === null ? null : { file: found.exe, args: [] };
};
const claude = new ClaudeAccounts({
	layout,
	run,
	spawn: spawnClaude,
	appEnv: process.env,
	current: installedTools,
	command: claudeCommand,
	proxyEnv: () => supervisor.engineProxyEnv([]),
	log: (fields) => shellLog.event(fields),
	// The address is the one the CLI printed, and only an https one is kept (`accounts/claude.ts`).
	openExternal: (url) => void shell.openExternal(url),
	writeClipboard: (text) => clipboard.writeText(text),
	hold: holdSecret,
	release: releaseSecret,
});

// The Linear key (task 11): encrypted with `safeStorage` (the asynchronous API) into `secrets/linear.bin`, then `ttt` and `ttt init`. Whether the OS can encrypt is asked when the Linear screen opens and at
// each save and read, never at start; a development build can be told it cannot (`SBD_TEST_NO_ENCRYPTION=1`, as it is told the WSL bash and the stand-in `claude`), so the refusal is proved where the OS can encrypt. A release build never reads the variable.
const linear = new LinearAccounts({
	layout,
	box: {
		available: async () => !(identity.kind === "dev" && process.env.SBD_TEST_NO_ENCRYPTION === "1") && (await safeStorage.isAsyncEncryptionAvailable()),
		encrypt: (text) => safeStorage.encryptStringAsync(text),
		// `shouldReEncrypt` asks the caller to encrypt the text again with the current key and store it: `LinearKeyFile.read` does.
		decrypt: (blob) => safeStorage.decryptStringAsync(blob),
	},
	run,
	appEnv: process.env,
	current: installedTools,
	ttt: () => {
		const current = installedTools();
		if (current === null) return null;
		try {
			return tttCommand(layout, current, loadActiveStack(layout, join(assetsDir, "stack.json")).stack);
		} catch {
			return null;
		}
	},
	installTtt: () => wizard.installTtt(),
	workFolder: () => loadStartConfig(layout, home).workFolder,
	// A start under way counts: the key may be read before it is saved, so the new key reaches panes only after a restart too.
	stackRunning: () => supervisor.state === "running" || supervisor.state === "starting",
	// Herdr's environment is fixed for its lifetime: the stack stops and starts again, and the new start reads the key.
	restartStack: () => supervisor.restart(),
	proxyEnv: () => supervisor.engineProxyEnv([]),
	log: (fields) => shellLog.event(fields),
	openExternal: (url) => void shell.openExternal(url),
	hold: holdSecret,
	release: releaseSecret,
});

/** The most a recipe file is read for: the validator's own limit is 256 KB, so a bigger file is handed over empty and refused by the validator (`too-large` is not reached; `invalid-json` is). */
const MAX_RECIPE_READ = 300 * 1024;

/** The native file dialog for a recipe (the wizard's step 2 and settings' **Replace**); null when cancelled. */
async function pickRecipeFile(): Promise<{ name: string; text: string } | null> {
	const window = desk?.window;
	const options = { properties: ["openFile" as const], filters: [{ name: "Straw Boss recipe", extensions: ["json"] }] };
	const picked = window === undefined ? await dialog.showOpenDialog(options) : await dialog.showOpenDialog(window, options);
	const file = picked.filePaths[0];
	if (picked.canceled || file === undefined) return null;
	return { name: basename(file), text: statSync(file).size > MAX_RECIPE_READ ? "" : readFileSync(file, "utf8") };
}

// ---- the projects step (task 12) -------------------------------------------------------------------------------------------------------------------------------------------------------

/** Git for the projects step: the app's own Git with the constructed environment (the private gitconfig and the credential helpers), never a terminal prompt, the OS proxy for the forge hosts. */
const gitExec: GitExec = async (args, options) => {
	const current = installedTools();
	if (current === null) return { code: null, stdout: "", stderr: "the install is not complete" };
	const proxyEnv = await supervisor.engineProxyEnv(wizard.forges.map((f) => f.host));
	const env = callEnv({ ...proxyEnv, ...buildEnv({ layout, current, appEnv: process.env }), GIT_TERMINAL_PROMPT: "0" }, options.env);
	const git = join(toolDir(layout, "git", current.git), toolExecutable(layout.platform, "git"));
	return run(git, args, { env, replaceEnv: true, timeoutMs: options.timeoutMs, ...(options.cwd !== undefined ? { cwd: options.cwd } : {}), ...(options.signal !== undefined ? { signal: options.signal } : {}) });
};
const openBaseClient = new OpenBaseClient({ slotDir: join(layout.agent, "straw-boss") });
const projects: ProjectsRunner = new ProjectsRunner({
	platform: layout.platform,
	workFolder: () => loadStartConfig(layout, home).workFolder,
	git: new ProjectGit(gitExec, (fields) => shellLog.event(fields), () => projects.signal),
	openBase: (input, hooks) => openBaseClient.open(input, hooks),
	// A row's Git runs from `tools/git` for up to 45 minutes, so it is a job of the supervisor's queue like every other user of the tools folder: Repair, an update, Apply and the Linear restart wait for it
	// (instead of refusing as busy after 90 s), and it waits for them. The open as a base is not in the job: it needs the stack running, and a trust question can hold it for minutes (R12-F002).
	gitJob: (work) => supervisor.withEngineJob(work),
	probe: hostProbe(netFetch()),
	record: new ProjectRecordStore(layout),
	redact: (text) => runtimeLog.redactor.redact(text),
	log: (fields) => shellLog.event(fields),
});

const wizard = new WizardController({
	layout,
	home,
	platform: layout.platform,
	dev: identity.kind === "dev",
	bundledStack: join(assetsDir, "stack.json"),
	secretPatterns,
	validate: validateRecipe,
	engine: engineHost,
	supervisor,
	accounts,
	claude,
	linear,
	tttInstalled: () => new StateStore(layout).record("ttt")?.status === "ok",
	// A function: `app.getLocale()` answers the default (en-US) before the app is ready, and the controller is built at module load.
	osLocale: () => pickLocale([app.getLocale(), ...app.getPreferredSystemLanguages()]),
	pickRecipeFile,
	projects,
	pickFolder: async (defaultPath) => {
		const window = desk?.window;
		const options = { defaultPath, properties: ["openDirectory" as const, "createDirectory" as const] };
		const picked = window === undefined ? await dialog.showOpenDialog(options) : await dialog.showOpenDialog(window, options);
		return picked.canceled ? null : (picked.filePaths[0] ?? null);
	},
	...(paneCheck === undefined ? {} : { checkPane: paneCheck }),
	logTail: (count) => tailLines(join(layout.logs, "bootstrap.jsonl"), count).map((line) => runtimeLog.redactor.redact(line)),
	log: (fields) => runtimeLog.event(fields),
});


// ---- the updaters (task 13) ----------------------------------------------------------------------------------------------------------------------------------------------------------

/** The update settings of this build: the built-in key list and feeds of a release build; a development build also takes `SBD_UPDATE_KEYS` and `SBD_UPDATE_FEED` from its environment (the tests' local feed). */
const updateCfg = updateConfig(identity.kind, process.env);

/** One GET through Chromium's network stack (the OS proxy and certificate store). Only an https address, or a loopback one in a development build, is fetched; the body is read up to `maxBytes`. */
async function fetchBytes(url: string, maxBytes: number): Promise<FetchedBytes> {
	const problem = feedUrlProblem(url);
	if (problem !== null || (identity.kind === "release" && !url.startsWith("https:"))) throw new Error(`the update address ${problem ?? "must be https"}`);
	const response = await net.fetch(url);
	const reader = response.body?.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	if (reader !== undefined) {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.length;
			if (size > maxBytes) {
				await reader.cancel();
				throw new Error(`${new URL(url).pathname} is larger than ${maxBytes} bytes`);
			}
			chunks.push(value);
		}
	}
	return { status: response.status, body: Buffer.concat(chunks) };
}

/** Streams `url` into `file` (the macOS dmg). Throws for any status but 200, a body over the installer limit, or a network failure; a partial file is left to the caller to delete. */
async function downloadFile(url: string, file: string, onProgress: (percent: number | null) => void): Promise<void> {
	const problem = feedUrlProblem(url);
	if (problem !== null || (identity.kind === "release" && !url.startsWith("https:"))) throw new Error(`the update address ${problem ?? "must be https"}`);
	const response = await net.fetch(url);
	if (response.status !== 200 || response.body === null) throw new Error(`${new URL(url).pathname} answered ${response.status}`);
	const total = Number(response.headers.get("content-length"));
	const out = createWriteStream(file);
	let size = 0;
	try {
		const reader = response.body.getReader();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.length;
			if (size > MAX_INSTALLER_BYTES) throw new Error("the download is larger than an installer should be");
			if (!out.write(value)) await new Promise<void>((resolve) => out.once("drain", resolve));
			onProgress(Number.isFinite(total) && total > 0 ? Math.min(100, Math.round((size / total) * 100)) : null);
		}
	} finally {
		await new Promise<void>((resolve) => out.end(resolve));
	}
}

/** The active recipe as the engine takes it: the recipe, or the forges of "I have no recipe", or nothing. */
function engineRecipe(): unknown {
	const recipe = wizard.recipe;
	if (recipe !== null) return recipe;
	const forges = wizard.forges;
	return forges.length === 0 ? undefined : { forges: forges.map((f) => ({ kind: f.kind, host: f.host })), tools: [] };
}

/** One engine run for an update (the candidate's, or the old stack's after a failure), in the same utilityProcess the wizard's runs use. */
const runEngineForUpdate = (stack: unknown, onStage: (event: { type: "start" | "end"; stage: string }) => void): Promise<EngineRunResult> =>
	runUpdateEngine(
		{
			host: engineHost,
			config: async () => {
				const recipe = engineRecipe();
				const proxyEnv = await supervisor.engineProxyEnv(wizard.forges.map((f) => f.host));
				return { root: layout.root, home, platform: layout.platform, stack, secretPatterns, ...(recipe !== undefined ? { recipe } : {}), ...(Object.keys(proxyEnv).length > 0 ? { proxyEnv } : {}) };
			},
			log: (fields) => runtimeLog.event(fields),
		},
		onStage,
	);

const stackUpdater = new StackUpdater({
	layout,
	shellVersion: app.getVersion(),
	key: platformKey(process.platform, process.arch),
	keys: updateCfg.keys,
	base: updateCfg.stackBase,
	fetchBytes,
	runEngine: runEngineForUpdate,
	withStackStopped: (work, options) => supervisor.withStackStopped(work, options),
	recipeTools: (stack) => wizard.recipeAgainst(stack)?.tools ?? [],
	reloadStack: () => wizard.reloadStack(),
	log: (fields) => runtimeLog.event(fields),
});

const shellUpdater = new ShellUpdater({
	platform: layout.platform,
	version: app.getVersion(),
	feed: updateCfg.shell,
	keys: updateCfg.keys,
	driver: () => electronUpdaterDriver(electronUpdater.autoUpdater, updateCfg.shell, join(app.getPath("userData"), "updater")),
	fetchBytes,
	downloadFile,
	downloadDir: () => app.getPath("downloads"),
	reveal: (file) => shell.showItemInFolder(file),
	// The stack stops the way a quit stops it, and the quit that electron-updater makes next finds nothing left to hold it.
	prepareQuit: () => stopForUpdate(),
	resumeAfterFailedInstall: () => resumeAfterFailedUpdate(),
	log: (fields) => runtimeLog.event(fields),
});

const updates = new UpdatesService({ shell: shellUpdater, stack: stackUpdater, appVersion: app.getVersion(), platform: layout.platform, enabled: () => wizard.done, log: (fields) => runtimeLog.event(fields) });

// ---- the Team recipe card (task 12) ----------------------------------------------------------------------------------------------------------------------------------------------------

/**
 * The tests' stand-in for the internet (development build only, like `SBD_UPDATE_FEED`): `SBD_TEST_RECIPE_FETCH` is JSON `{"hosts": {"<name>": {"address": "<a public-looking address>", "port": <local port>}}, "ca": "<path to a PEM>"}`.
 * A name in it resolves to its address, and a connection to that address goes to 127.0.0.1 at the port, trusting the CA; every rule of the fetch still applies, so a name that maps to a private address is refused.
 * A release build never reads the variable.
 */
function recipeFetchSeam(): { resolve: (host: string) => Promise<string[]>; dial: (address: string, port: number) => { host: string; port: number }; ca?: string } | null {
	const raw = process.env.SBD_TEST_RECIPE_FETCH;
	if (identity.kind !== "dev" || raw === undefined || raw === "") return null;
	try {
		const parsed = JSON.parse(raw) as { hosts: Record<string, { address: string; port: number }>; ca?: string };
		return {
			resolve: async (host) => {
				const found = parsed.hosts[host];
				if (found === undefined) throw new Error(`no such host ${host}`);
				return [found.address];
			},
			dial: (address) => ({ host: "127.0.0.1", port: Object.values(parsed.hosts).find((h) => h.address === address)?.port ?? 9 }),
			...(parsed.ca !== undefined ? { ca: readFileSync(parsed.ca, "utf8") } : {}),
		};
	} catch (error) {
		runtimeLog.event({ event: "recipe-fetch-seam-unreadable", detail: (error as Error).message.slice(0, 200) });
		return null;
	}
}

const recipeSeam = recipeFetchSeam();
const recipeMemo = new RecipeMemoStore(layout);
const recipeCard = new RecipeService({
	active: () => wizard.recipe,
	stack: () => loadActiveStack(layout, join(assetsDir, "stack.json")).stack,
	intake: (name, text) => wizard.intakeFor(name, text),
	fetchText: (url) => fetchPublicText(url, { privateOrLocalHost, ...(recipeSeam ?? {}) }),
	pickFile: pickRecipeFile,
	accept: (next, source) => wizard.acceptRecipe(next, source),
	install: () => wizard.installRecipe(),
	projects,
	addLater: (items) => wizard.setLater([...wizard.later, ...items.filter((i) => !wizard.later.some((l) => l.item === i.item && "host" in l && "host" in i && l.host === i.host))]),
	store: recipeMemo,
	log: (fields) => shellLog.event(fields),
	enabled: () => wizard.done,
});

// ---- Diagnostics, Computer and Remove all data (task 14) ----------------------------------------------------------------------------------------------------------------------------

/** The cleanup that deletes `<root>` after the app has gone (`removal/cleanup.ts`): armed by **Remove all data**, started once, at the app's exit. */
const exitCleanup = new ExitCleanup({ platform: process.platform, pid: process.pid, locate: platform.locate, spawn: (command) => spawnCleanup(command) });

/** The quit gate (`quit-gate.ts`): the quit holds until the stop sequence is done and leaves with `app.exit`. Built before the removal, whose stop runs inside it. */
const quitGate = new QuitGate({
	stopAll: () => stopAll(),
	// The cleanup that **Remove all data** armed starts here, right before the app is gone.
	exit: (code) => {
		exitCleanup.run();
		app.exit(code);
	},
	resume: (event) => resumeStack(event),
	log: (fields) => runtimeLog.event(fields),
});

const keepAwake = new KeepAwake(layout, powerSaveBlocker);

const removal = new RemovalService({
	layout,
	home,
	platform,
	productName: identity.productName,
	accounts,
	forges: () => wizard.forges,
	claude,
	linear,
	workFolder: () => loadStartConfig(layout, home).workFolder,
	// The stop of a quit, waiting out the helper a pane's pi leaves for 30 s (seam U13) as Repair's stop does, run inside the quit gate (`removal/wiring.ts`). The quit's own stop does not run again after it.
	// A stop already under way (an update's, a quit's) is not undone or joined: the gate answers `busy` and the removal says so.
	// Keep awake is let go when the stop starts: the result screen can wait for hours, and the computer need not stay awake for it. A refused removal applies the saved setting again.
	...removalStop({ gate: quitGate, keepAwake, stopSequence: () => stopForRemoval(stopParts()) }),
	// This app's pid and start token go into the marker, so a second launch can tell that the root is still held (T14-F005).
	self: async () => ({ pid: process.pid, startTime: (await platform.processes.inspect([process.pid]))[0]?.startTime ?? null }),
	arm: (spec) => exitCleanup.arm(spec),
	// The logs are in the folder that is about to be deleted; a write after that would throw into whatever logged it.
	beforeFiles: () => {
		runtimeLog.mute();
		shellLog.mute();
	},
	quit: () => app.quit(),
	log: (fields) => runtimeLog.event(fields),
});

const computerCard = new ComputerService({ platform: layout.platform, keepAwake, removal, openGuide: () => void shell.openExternal(guideUrl()), log: (fields) => shellLog.event(fields) });

/**
 * Repair (spec: Settings, Diagnostics): the engine runs again with the stack stopped. `runRepair` is the runtime page's button and shows a failure on that page; the Diagnostics card calls
 * `repairOnce` and shows the failure in its own state.
 */
async function repairOnce(): Promise<{ ok: true } | { ok: false; reason: string; failure: Extract<Awaited<ReturnType<typeof wizard.repair>>, { ok: false }>["failure"] }> {
	const outcome = await wizard.repair(lastFailureKind);
	if (!outcome.ok) return { ok: false, reason: outcome.failure.reason ?? "", failure: outcome.failure };
	lastFailureKind = undefined;
	if (supervisor.state !== "running") await supervisor.start().catch(() => undefined);
	return { ok: true };
}

const diagnostics = new DiagnosticsService({
	layout,
	redactor: runtimeLog.redactor,
	status: () => supervisor.cliStatus(),
	// Electron throws when the OS cannot name the Downloads folder (a profile without one); the zip then goes to `Downloads` under the home folder, which the writer creates.
	downloads: () => {
		try {
			return app.getPath("downloads");
		} catch {
			return join(home, "Downloads");
		}
	},
	facts: () => ({
		app: `${identity.productName} ${app.getVersion()} (${identity.kind} build)`,
		platform: `${process.platform} ${arch()} ${release()}`,
		electron: process.versions.electron ?? "",
		node: process.versions.node,
		locale: wizard.locale,
		wizardDone: String(wizard.done),
	}),
	openPath: (path) => shell.openPath(path),
	reveal: (file) => shell.showItemInFolder(file),
	repair: async () => {
		const outcome = await repairOnce();
		return outcome.ok ? { ok: true, detail: "" } : { ok: false, detail: outcome.reason };
	},
	wslBash: () => wslNotice?.id === "wsl" ? wslNotice.path : null,
	log: (fields) => runtimeLog.event(fields),
});

/** The WSL sentence, until dismissed for this start. */
let wslNotice: ShellNotice | null = null;

/** Notices over the GUI: the WSL sentence, and the sign-ins put off once the wizard is over. */
function refreshNotices(): void {
	const later = wizard.done && wizard.later.length > 0 ? [{ id: "later" as const, items: wizard.later }] : [];
	const update = updates.notice();
	desk?.setNotices([...(wslNotice === null ? [] : [wslNotice]), ...later, ...(update === null ? [] : [{ id: "update" as const, ...update }])]);
}

function settingsView(section: SettingsSection): SettingsView {
	const recipe = wizard.recipe;
	return { locale: wizard.locale, section, later: wizard.later, forges: accounts.views(wizard.forges), claude: claude.view(), linear: wizard.linearOffered || linear.state !== "not-saved" ? linear.view() : null, recipe: recipe === null ? null : { id: recipe.id, name: recipe.name, version: recipe.version }, appVersion: app.getVersion(), dev: identity.kind === "dev", updates: updates.view(), recipeCard: recipeCard.view(), computer: computerCard.view(), diagnostics: diagnostics.view() };
}

/** Repair (spec: Settings, Diagnostics): the engine runs again with the stack stopped; a stack that was not running is started after. A failure shows on the screen with Repair again. */
/** The kind of the last start failure the runtime page showed: Repair of `loader` or `intercom` reinstalls that one package. */
let lastFailureKind: string | undefined;

async function runRepair(): Promise<void> {
	const outcome = await repairOnce();
	if (!outcome.ok) desk?.setState({ mode: "screen", screen: "failed", failure: outcome.failure });
}

// No page of the app may attach a <webview>.
app.on("web-contents-created", (_event, contents) => {
	contents.on("will-attach-webview", (event) => event.preventDefault());
});

// The GUI's address carries the page token: it goes to the view and nowhere else (the presenter keeps it in memory for a window opened later).
const presenter = new GuiPresenter({ state: () => supervisor.state, guiShown: () => supervisor.guiShown() });
supervisor.on((event) => {
	switch (event.type) {
		case "gui-url":
			presenter.onGuiUrl(event.url);
			break;
		case "view":
			desk?.setView(event.view);
			break;
		case "screen":
			desk?.setState(screenState(event.screen));
			break;
		case "banner":
			if (event.kind === undefined) desk?.clearBanner();
			else desk?.setState(bannerState(event.kind));
			break;
		case "failure":
			// During the wizard the start step words the failure itself (the shell view keeps the wizard page then); afterwards the runtime page shows it.
			lastFailureKind = event.failure.kind;
			desk?.setState(failureState(event.failure));
			break;
		case "notice":
			if (event.kind === "wsl-bash" && event.path !== undefined) {
				wslNotice = { id: "wsl", path: event.path };
				refreshNotices();
			}
			break;
		default:
			break;
	}
});

function openWindow(): void {
	if (desk === undefined || desk.isOpen) return;
	// A window opened while the stack runs (macOS: the Dock icon or a second launch after the window was closed) shows the GUI at once; the shell view steps aside while it shows.
	if (!presenter.attach(desk.open(() => presenter.detach()))) desk.blank();
}

function buildMenu(): void {
	Menu.setApplicationMenu(
		Menu.buildFromTemplate(
			menuTemplate({
				locale: wizard.locale,
				platform: process.platform,
				settingsEnabled: wizard.done,
				openSettings: (section) => {
					openWindow();
					desk?.openSettings(section);
				},
			}),
		),
	);
}

// The quit holds until the stop sequence is done, then leaves with `app.exit`, so a quit never abandons the stack half stopped.
/** The parts the stop sequence works on (`stop-sequence.ts`). */
function stopParts(): StopParts {
	// The checks of the Team recipe card and the repositories in flight end with the app's other background work.
	const background = {
		dispose: () => {
			updates.dispose();
			recipeCard.dispose();
			projects.dispose();
		},
	};
	return { supervisor, updates: background, accounts, claude, linear, engineHost, log: (fields) => runtimeLog.event(fields) };
}

/** The stop sequence of a quit and of an update's stop (`stop-sequence.ts`). */
function stopAll(): Promise<boolean> {
	return stopSequence(stopParts());
}

const stopThenExit = (code: (ok: boolean) => number): void => quitGate.quit(code);

/**
 * Restart to update (spec: Updater): the stop sequence runs, then electron-updater starts the installer and quits the app. The quit it makes is not held again, since the stack is stopped
 * already; the installer replaces the program files only, never the data root.
 */
const stopForUpdate = (): Promise<void> => quitGate.stopForUpdate();

/** The installer could not start (spec: Updater): the app goes on as it was before the click, or leaves if the PM asked to quit meanwhile. */
const resumeAfterFailedUpdate = (): Promise<boolean> => quitGate.resumeAfterFailedUpdate();

/**
 * The app goes on as it was (after an update's installer or a refused **Remove all data**; `event` names which): the stack starts again, the engine and the supervisor take work, and the checks run again. An apply that the stop cut short is finished first, so the stack does not
 * start on half-updated tools and the card does not stay on "applying" (R13B-F002). Resolves with whether the agents started.
 */
async function resumeStack(event: string): Promise<boolean> {
	supervisor.cancelQuit();
	engineHost.resume();
	accounts.resume();
	claude.resume();
	linear.resume();
	updates.start();
	projects.resume();
	recipeCard.start();
	runtimeLog.event({ event });
	await stackUpdater.healInterrupted().catch((error: Error) => runtimeLog.event({ event: "update-resume-heal-failed", detail: error.message.slice(0, 200) }));
	// A start that fails shows on the runtime page through the supervisor's `failure` event.
	return supervisor
		.start()
		.then(() => true)
		.catch(() => false);
}

if (!app.requestSingleInstanceLock()) {
	// A second launch only hands over to the running one; with --stop-stack it is the running one that stops the stack and quits.
	app.quit();
} else if (hasStopStack(process.argv)) {
	// No instance runs: stop whatever a crashed or killed earlier run left, show nothing, and leave (the uninstaller's call).
	void app.whenReady().then(() => stopThenExit((ok) => (ok ? 0 : 1)));
} else {
	app.on("second-instance", (_event, commandLine) => {
		if (hasStopStack(commandLine)) {
			app.quit();
			return;
		}
		// macOS: the window may have been closed while the app runs; a second launch opens it again, with the GUI.
		openWindow();
		const window = desk?.window;
		if (window === undefined) return;
		if (window.isMinimized()) window.restore();
		window.focus();
	});
	app.on("before-quit", (event) => holdQuit(quitGate, event));
	// macOS keeps the app and the stack running when the window closes; Windows quits and stops (design: Window close).
	app.on("window-all-closed", () => {
		// After **Remove all data** the app has nothing left to run, so closing its window ends it on macOS too; the rest of the root goes with it (`exitCleanup`).
		if (quitsWhenWindowsClose(process.platform, removal.state.phase)) app.quit();
	});
	app.on("will-quit", () => exitCleanup.run());
	app.on("activate", () => openWindow());
	void app.whenReady().then(() => {
		const mode = wizard.launchMode();
		// A new app whose bundled stack is newer than the one in force, or an update cut short, is dealt with before the stack starts (spec: Updater, Precedence). The old file is kept
		// before anything reads the stack, because the wizard seeds `stack/active.json` from the bundled one as soon as it does.
		const updatePlan = mode === "stack" ? stackUpdater.prepare(join(assetsDir, "stack.json")) : null;
		buildMenu();
		desk = new DeskWindow({
			productName: identity.productName,
			locale: wizard.locale,
			build: identity.kind,
			distDir: join(import.meta.dirname, ".."),
			workFolder: () => loadStartConfig(layout, home).workFolder,
			// Start and Try again are one request (the follower's `up` while the stack runs, a whole start after a failure); Repair runs the engine again.
			onAction: (action) => (action === "repair" ? void runRepair().catch(() => undefined) : void supervisor.retry().catch(() => undefined)),
			wizardView: () => wizard.view(),
			onWizardAction: (action) => wizard.act(action),
			settingsView,
			onAccountAction: (action) => wizard.accountAction(action),
			onRecipeAction: (action) => recipeCard.act(action).catch((error: Error) => runtimeLog.event({ event: "recipe-action-failed", detail: error.message.slice(0, 300) })),
			onUpdateAction: (action) => updates.act(action).catch((error: Error) => runtimeLog.event({ event: "update-action-failed", detail: error.message.slice(0, 300) })),
			// Settings' Accounts rows show what the store and the CLIs hold now, not what they held when the app started.
			onSettingsShown: (section) => {
				if (section !== "accounts") return;
				void accounts.refresh(wizard.forges).catch((error: Error) => runtimeLog.event({ event: "accounts-refresh-failed", detail: error.message.slice(0, 300) }));
				void claude.refresh().catch((error: Error) => runtimeLog.event({ event: "accounts-refresh-failed", detail: error.message.slice(0, 300) }));
				if (wizard.linearOffered || linear.state !== "not-saved") void linear.probe();
			},
			onComputerAction: (action) => computerCard.act(action).catch((error: Error) => runtimeLog.event({ event: "computer-action-failed", detail: error.message.slice(0, 300) })),
			onDiagnosticsAction: (action) => diagnostics.act(action).catch((error: Error) => runtimeLog.event({ event: "diagnostics-action-failed", detail: error.message.slice(0, 300) })),
			onSessionEnd: () => supervisor.stopForSessionEnd(),
			log: (fields) => runtimeLog.event(fields),
		});
		let shownLocale = wizard.locale;
		wizard.onChange(() => {
			desk?.pushWizard(wizard.view());
			desk?.pushSettings();
			if (wizard.done) refreshNotices();
			if (wizard.locale !== shownLocale) {
				shownLocale = wizard.locale;
				desk?.setLocale(shownLocale);
				buildMenu();
			}
		});
		wizard.onDone(() => {
			desk?.setWizardActive(false);
			buildMenu();
			refreshNotices();
		});
		updates.onChange(() => {
			desk?.pushSettings();
			refreshNotices();
		});
		recipeCard.onChange(() => desk?.pushSettings());
		removal.onChange(() => {
			desk?.pushSettings();
			// A quit asked while the removal worked was held (T14R-F001): the result is shown now, in a window opened for it if the PM had closed theirs, and closing it quits.
			afterRemovalChange({
				phase: removal.state.phase,
				gate: quitGate,
				openWindow,
				showComputer: () => desk?.openSettings("computer"),
				focus: () => desk?.window?.focus(),
			});
		});
		diagnostics.onChange(() => desk?.pushSettings());
		keepAwake.apply();
		desk.setWizardActive(mode === "wizard");
		refreshNotices();
		attachPower(powerMonitor, supervisor, (fields) => runtimeLog.event(fields));
		openWindow();
		if (mode === "wizard") void wizard.resume().catch((error: Error) => runtimeLog.event({ event: "wizard-resume-failed", detail: error.message.slice(0, 300) }));
		// Failures reach the runtime page through the supervisor's `failure` event; they are in logs/start.jsonl too.
		else {
			void stackUpdater
				.finish(updatePlan)
				.catch((error: Error) => runtimeLog.event({ event: "stack-reconcile-failed", detail: error.message.slice(0, 300) }))
				.then(() => supervisor.start())
				.catch(() => undefined);
		}
		updates.start();
		recipeCard.start();
	});
}
