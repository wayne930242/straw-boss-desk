import { app, clipboard, dialog, Menu, powerMonitor, session, shell, utilityProcess } from "electron";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { pickLocale } from "../shared/locale.ts";
import { identityFromProductName } from "./build.ts";
import { dataRoot, electronDir, computeLayout } from "./paths.ts";
import { DeskWindow } from "./desk-window.ts";
import { GuiPresenter } from "./gui-presenter.ts";
import { bannerState, failureState, screenState } from "./shell-state.ts";
import { tailLines } from "./bootstrap/log.ts";
import { menuTemplate } from "./menu.ts";
import { catalogs } from "../renderer/i18n/index.ts";
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
import type { SpawnFn } from "./runtime/herdr.ts";

// The lifecycle: single instance, Chromium's profile inside the app data root, one window holding the two views the design needs, the GUI view (pi-straw-boss) and the shell
// view (welcome, the runtime page for notices and screens; wizard and settings later) above it (`desk-window.ts`), and the runtime supervisor that starts the stack at launch,
// follows it, and stops it at quit (tasks 8a and 8b).

const identity = identityFromProductName(app.getName());
const root = dataRoot({ env: process.env, argv: process.argv.slice(1), platform: process.platform, home: homedir() });

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
const { validateRecipe } = (await import(pathToFileURL(join(assetsDir, "recipe", "validate.mjs")).href)) as { validateRecipe: ValidateRecipe };
const platform = createPlatform();
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

/** The most a recipe file is read for: the validator's own limit is 256 KB, so a bigger file is handed over empty and refused by the validator (`too-large` is not reached; `invalid-json` is). */
const MAX_RECIPE_READ = 300 * 1024;

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
	// A function: `app.getLocale()` answers the default (en-US) before the app is ready, and the controller is built at module load.
	osLocale: () => pickLocale([app.getLocale(), ...app.getPreferredSystemLanguages()]),
	pickRecipeFile: async () => {
		const window = desk?.window;
		const options = { properties: ["openFile" as const], filters: [{ name: "Straw Boss recipe", extensions: ["json"] }] };
		const picked = window === undefined ? await dialog.showOpenDialog(options) : await dialog.showOpenDialog(window, options);
		const file = picked.filePaths[0];
		if (picked.canceled || file === undefined) return null;
		return { name: basename(file), text: statSync(file).size > MAX_RECIPE_READ ? "" : readFileSync(file, "utf8") };
	},
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

/** The WSL sentence, until dismissed for this start. */
let wslNotice: ShellNotice | null = null;

/** Notices over the GUI: the WSL sentence, and the sign-ins put off once the wizard is over. */
function refreshNotices(): void {
	const later = wizard.done && wizard.later.length > 0 ? [{ id: "later" as const, items: wizard.later }] : [];
	desk?.setNotices([...(wslNotice === null ? [] : [wslNotice]), ...later]);
}

function settingsView(section: SettingsSection): SettingsView {
	const recipe = wizard.recipe;
	return { locale: wizard.locale, section, later: wizard.later, forges: accounts.views(wizard.forges), recipe: recipe === null ? null : { id: recipe.id, name: recipe.name, version: recipe.version }, appVersion: app.getVersion(), dev: identity.kind === "dev" };
}

/** Repair (spec: Settings, Diagnostics): the engine runs again with the stack stopped; a stack that was not running is started after. A failure shows on the screen with Repair again. */
/** The kind of the last start failure the runtime page showed: Repair of `loader` or `intercom` reinstalls that one package. */
let lastFailureKind: string | undefined;

async function runRepair(): Promise<void> {
	const outcome = await wizard.repair(lastFailureKind);
	if (!outcome.ok) {
		desk?.setState({ mode: "screen", screen: "failed", failure: outcome.failure });
		return;
	}
	lastFailureKind = undefined;
	if (supervisor.state !== "running") await supervisor.start().catch(() => undefined);
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
let stopping = false;
let stopped = false;

function stopThenExit(code: (ok: boolean) => number): void {
	if (stopping) return;
	stopping = true;
	// An install running in the engine process ends first (a quit during the install resumes at the next launch: verified stages are skipped), then the stack stops.
	// A Repair job in the queue does not start the stack again once the engine is gone (T9-F002).
	supervisor.beginQuit();
	// A device-code login that waits ends with the app.
	accounts.dispose();
	engineHost
		.dispose()
		.catch(() => undefined)
		.then(() => supervisor.stop())
		.then((report) => {
			runtimeLog.event({ event: "quit-stop", ok: report.ok, leftovers: report.leftovers.length });
			return report.ok;
		})
		.catch((error: Error) => {
			runtimeLog.event({ event: "quit-stop-failed", detail: error.message.slice(0, 300) });
			return false;
		})
		.then((ok) => {
			stopped = true;
			app.exit(code(ok));
		});
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
	app.on("before-quit", (event) => {
		if (stopped) return;
		event.preventDefault();
		stopThenExit(() => 0);
	});
	// macOS keeps the app and the stack running when the window closes; Windows quits and stops (design: Window close).
	app.on("window-all-closed", () => {
		if (process.platform !== "darwin") app.quit();
	});
	app.on("activate", () => openWindow());
	void app.whenReady().then(() => {
		const mode = wizard.launchMode();
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
			onForgeAction: (action) => wizard.forgeAction(action),
			// Settings' Accounts rows show what the store holds now, not what it held when the app started.
			onSettingsShown: (section) => {
				if (section === "accounts") void accounts.refresh(wizard.forges).catch((error: Error) => runtimeLog.event({ event: "accounts-refresh-failed", detail: error.message.slice(0, 300) }));
			},
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
		desk.setWizardActive(mode === "wizard");
		refreshNotices();
		attachPower(powerMonitor, supervisor, (fields) => runtimeLog.event(fields));
		openWindow();
		if (mode === "wizard") void wizard.resume().catch((error: Error) => runtimeLog.event({ event: "wizard-resume-failed", detail: error.message.slice(0, 300) }));
		// Failures reach the runtime page through the supervisor's `failure` event; they are in logs/start.jsonl too.
		else void supervisor.start().catch(() => undefined);
	});
}
