import { mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Recipe } from "../../../../recipe/validate.d.mts";
import type { EngineConfig } from "../bootstrap/engine.ts";
import { writeFileAtomic } from "../bootstrap/fsutil.ts";
import { orderStages } from "../bootstrap/graph.ts";
import { engineRecipeOf } from "../bootstrap/recipe-config.ts";
import { platformKey, type Stack } from "../bootstrap/stack.ts";
import { allStages } from "../bootstrap/stages/index.ts";
import type { PaneFindings } from "../pane-path.ts";
import type { AppPlatform, Layout } from "../paths.ts";
import { isInstalled, readInstalled } from "../runtime/readiness.ts";
import type { RuntimeEvent } from "../runtime/log.ts";
import { StartFailureError, firstLineOf } from "../runtime/failure.ts";
import { shellFailureOf } from "../shell-state.ts";
import type { StartResult } from "../runtime/supervisor.ts";
import { isForgeAction, type ForgeAction, type ForgeView } from "../../shared/accounts.ts";
import type { Locale } from "../../shared/locale.ts";
import type { ShellFailure } from "../../shared/shell-state.ts";
import { WIZARD_STEPS, type FolderProblem, type Forge, type LaterItem, type RecipeChoice, type RecipeRefusal, type WizardAction, type WizardStep, type WizardView } from "../../shared/wizard.ts";
import type { EngineEnd, EngineHost } from "./engine-host.ts";
import { defaultWorkFolder, workFolderProblem } from "./folder.ts";
import { InstallProgress } from "./install-progress.ts";
import { intakeRecipe, plainFileName, type Intake, type ValidateRecipe } from "./recipe-intake.ts";
import { loadActiveStack, type ActiveStack } from "./stack-source.ts";
import { trustModelOf } from "./trust.ts";
import { FRESH, readWizardFile, writeWizardFile, type WizardFile } from "./state-file.ts";

// The wizard's step machine (spec: The wizard, First run). It owns what the PM has chosen so far, writes `state/wizard.json` at each step so a quit or a crash resumes on the step where it
// stopped, runs the engine for the install step, starts the stack for the start step, and turns every sign-in step into **Later** (tasks 10 and 11 fill them). It knows no Electron: the
// dialogs, the engine's process, the supervisor and the file system reads come in as dependencies, so every rule here runs under plain Node.

export interface WizardSupervisor {
	start(): Promise<StartResult>;
	engineProxyEnv(forgeHosts: readonly string[]): Promise<Record<string, string>>;
	withStackStopped<T>(work: () => Promise<T>, options?: { waitForTools?: boolean }): Promise<T>;
	repairLock(): unknown;
	readonly state: string;
}

/** What the controller asks of the code-host sign-in (`accounts/session.ts`). */
export interface WizardAccounts {
	views(forges: readonly Forge[]): ForgeView[];
	act(action: ForgeAction): Promise<void>;
	/** The checks before a sign-in: the store probe, then the existing-sign-in check. */
	begin(kind: Forge["kind"], host: string): Promise<void>;
	cancel(host: string): void;
	flowOf(host: string): ForgeView["flow"];
	onChange(listener: () => void): () => void;
	onSignedIn(listener: (kind: Forge["kind"], host: string) => void): () => void;
}

export interface WizardDeps {
	layout: Layout;
	home: string;
	platform: AppPlatform;
	dev: boolean;
	/** The bundled `stack.json` (`dist/assets/stack.json`). */
	bundledStack: string;
	secretPatterns: unknown;
	validate: ValidateRecipe;
	engine: EngineHost;
	supervisor: WizardSupervisor;
	accounts: WizardAccounts;
	/** The language the OS asks for, when the PM has not chosen one. */
	osLocale: () => Locale;
	/** Opens the file dialog for a recipe and reads the file; null when the PM cancelled. Throws a plain message when the file cannot be read. */
	pickRecipeFile(): Promise<{ name: string; text: string } | null>;
	pickFolder(defaultPath: string): Promise<string | null>;
	/** Windows only: what a pane's `bash` resolves to. */
	checkPane?: () => Promise<PaneFindings>;
	/** The last lines of the install's log, redacted. */
	logTail(count: number): string[];
	log: RuntimeEvent;
	/** Test hooks of the folder rule. */
	realpath?: (path: string) => string;
	isFile?: (path: string) => boolean;
}

export type RepairOutcome = { ok: true } | { ok: false; failure: ShellFailure };

const STEP_ORDER: readonly WizardStep[] = WIZARD_STEPS;
/** An engine process that ends is resumed this many times at most in one run; the same stage ending it twice fails the stage earlier. */
const MAX_RESUMES = 5;
const HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*(?::[0-9]{1,5})?$/;

/** The start failures whose cause is one package the stage's own check cannot see, and the stage Repair forces for each. */
const REPAIR_STAGE_OF: Record<string, string> = { loader: "pkg:pi-straw-boss", intercom: "pkg:pi-intercom" };

export class WizardController {
	readonly #d: WizardDeps;
	#file: WizardFile;
	#stack: ActiveStack | null = null;
	/** An accepted recipe, in memory until the PM applies it on the trust screen (nothing is written before). */
	#pending: (Extract<Intake, { ok: true }> & { choice: RecipeChoice }) | null = null;
	#refused: RecipeRefusal[] = [];
	#recipe: Recipe | null = null;
	#folderProblem: FolderProblem | null = null;
	#wslBash: string | null = null;
	#startStatus: "idle" | "starting" | "failed" = "idle";
	#startFailure: ShellFailure | null = null;
	readonly #progress = new InstallProgress();
	#installing = false;
	#starting = false;
	readonly #listeners = new Set<() => void>();
	readonly #doneListeners = new Set<() => void>();

	constructor(deps: WizardDeps) {
		this.#d = deps;
		this.#file = readWizardFile(deps.layout) ?? { ...FRESH };
		// A sign-in's progress is part of the view; one that passes takes its forge off the list of sign-ins put off, in the wizard and in settings alike.
		deps.accounts.onChange(() => this.#emit());
		deps.accounts.onSignedIn((kind, host) => {
			if (this.#file.later.some((l) => l.item === kind && "host" in l && l.host === host)) this.#save({ later: this.#file.later.filter((l) => !(l.item === kind && "host" in l && l.host === host)) });
		});
	}

	// ---- reading -----------------------------------------------------------------------------------------------------

	get locale(): Locale {
		return this.#file.locale ?? this.#d.osLocale();
	}

	get done(): boolean {
		return this.#file.done;
	}

	get later(): LaterItem[] {
		return this.#file.later.map((l) => ({ ...l }));
	}

	get step(): WizardStep {
		return this.#file.step;
	}

	onChange(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	onDone(listener: () => void): () => void {
		this.#doneListeners.add(listener);
		return () => this.#doneListeners.delete(listener);
	}

	#emit(): void {
		for (const l of this.#listeners) l();
	}

	/** The active recipe: the one accepted in this run, or the only file under `recipe/`, validated again. Null when there is none (or "I have no recipe"). */
	get recipe(): Recipe | null {
		if (this.#recipe !== null) return this.#recipe;
		const stack = this.#stackOrNull();
		if (stack === null) return null;
		try {
			const names = readdirSync(this.#d.layout.recipe).filter((n) => n.endsWith(".json"));
			if (names.length !== 1) return null;
			const result = this.#d.validate(readFileSync(join(this.#d.layout.recipe, names[0] as string), "utf8"), {
				reservedPackages: [...stack.stack.npmGlobal.map((p) => p.name), stack.stack.profile.name, ...stack.stack.piPackages.map((p) => p.name)],
				knownTools: Object.keys(stack.stack.optionalTools),
			});
			if (!result.ok) return null;
			this.#recipe = result.recipe;
			return result.recipe;
		} catch {
			return null;
		}
	}

	get forges(): Forge[] {
		const recipe = this.recipe;
		if (recipe !== null) return recipe.forges.map((f) => ({ kind: f.kind, host: f.host }));
		return (this.#file.noRecipeForges ?? []).map((f) => ({ ...f }));
	}

	get linearOffered(): boolean {
		const recipe = this.recipe;
		return recipe === null ? this.#file.noRecipeForges !== undefined || this.#file.recipeFile === undefined : recipe.linear?.enabled === true;
	}

	#stackOrNull(): ActiveStack | null {
		try {
			return this.#stackNow();
		} catch (error) {
			this.#d.log({ event: "wizard-stack-unusable", detail: firstLineOf((error as Error).message) });
			return null;
		}
	}

	#stackNow(): ActiveStack {
		if (this.#stack === null) this.#stack = loadActiveStack(this.#d.layout, this.#d.bundledStack);
		return this.#stack;
	}

	view(): WizardView {
		const file = this.#file;
		const recipe = this.recipe;
		const stack = this.#stackOrNull();
		const choice: RecipeChoice =
			this.#pending !== null
				? this.#pending.choice
				: recipe !== null
					? { kind: "recipe", summary: { id: recipe.id, name: recipe.name, version: recipe.version }, fileName: file.recipeFile ?? `${recipe.id}.json` }
					: file.noRecipeForges !== undefined
						? { kind: "no-recipe", forges: file.noRecipeForges.map((f) => ({ ...f })) }
						: { kind: "none" };
		const pendingRecipe = this.#pending?.recipe ?? recipe;
		const trust =
			pendingRecipe !== null && stack !== null
				? trustModelOf({ recipe: pendingRecipe, stack: stack.stack, key: platformKey(process.platform, process.arch), fileName: this.#pending?.fileName ?? file.recipeFile ?? `${pendingRecipe.id}.json`, sha256: this.#pending?.sha256 ?? "" })
				: null;
		const launching = file.done || (this.#launching && file.step === "done");
		const forges = this.forges;
		const hostsIndex = Math.min(file.hostsIndex, Math.max(0, forges.length - 1));
		const forgeViews = forges.length === 0 ? [] : this.#d.accounts.views(forges);
		return {
			step: launching ? "launching" : file.step,
			steps: [...WIZARD_STEPS],
			locale: this.locale,
			root: this.#d.layout.root,
			dev: this.#d.dev,
			welcome: { wslBash: this.#wslBash },
			recipe: { choice, refused: this.#refused.map((r) => ({ ...r })), fileName: this.#pending?.fileName ?? file.recipeFile ?? null },
			trust,
			folder: { path: file.workFolder ?? defaultWorkFolder(this.#d.home), defaultPath: defaultWorkFolder(this.#d.home), problem: this.#folderProblem },
			install: this.#progress.view(),
			start: { status: this.#startStatus, failure: this.#startFailure },
			hosts: { forges, index: hostsIndex, current: forgeViews[hostsIndex] ?? null },
			linearOffered: this.linearOffered,
			later: this.later,
		};
	}

	#launching = false;

	// ---- the launch --------------------------------------------------------------------------------------------------

	/**
	 * What the app does at launch. `stack`: the wizard is over (or an install no wizard made is there), so the stack starts as before. `wizard`: the wizard shows, and `resume()` picks up
	 * the step where it stopped. An installed root with no wizard record is an install the wizard did not make (the tests' and a developer's): it counts as done.
	 */
	launchMode(): "stack" | "wizard" {
		const record = readWizardFile(this.#d.layout);
		if (record?.done === true) return "stack";
		if (record === null && isInstalled(readInstalled(this.#d.layout))) {
			this.#file = { ...FRESH, step: "done", done: true };
			writeWizardFile(this.#d.layout, this.#file);
			return "stack";
		}
		return "wizard";
	}

	/** Picks up the step where the wizard stopped: an install resumes (verified stages are skipped), and from the start step on the stack starts. */
	async resume(): Promise<void> {
		void this.scanPane();
		const step = this.#file.step;
		if (step === "install") await this.#runInstall();
		else if (STEP_ORDER.indexOf(step) >= STEP_ORDER.indexOf("start")) await this.#startStack();
		this.#syncHosts();
	}

	async scanPane(): Promise<void> {
		if (this.#d.checkPane === undefined) return;
		try {
			const found = await this.#d.checkPane();
			this.#wslBash = found.wslBash && found.firstBash !== null ? found.firstBash : null;
		} catch (error) {
			this.#d.log({ event: "pane-path-unreadable", detail: firstLineOf((error as Error).message) });
			this.#wslBash = null;
		}
		this.#emit();
	}

	// ---- actions -----------------------------------------------------------------------------------------------------

	async act(action: WizardAction): Promise<void> {
		switch (action.type) {
			case "set-locale":
				if (action.locale === "en" || action.locale === "zh-TW") this.#save({ locale: action.locale });
				return;
			case "rescan":
				await this.scanPane();
				return;
			case "welcome-next":
				if (this.#at("welcome")) this.#go("recipe");
				return;
			case "choose-recipe-file":
				if (this.#at("recipe")) await this.#chooseRecipe();
				return;
			case "recipe-text":
				if (this.#at("recipe")) this.#takeRecipe(action.name, action.text);
				return;
			case "no-recipe":
				if (this.#at("recipe")) this.#noRecipe(action.github, action.gitlabHost);
				return;
			case "recipe-back":
				if (this.#at("trust")) this.#cancelTrust();
				return;
			case "trust-cancel":
				if (this.#at("trust")) this.#cancelTrust();
				return;
			case "trust-apply":
				if (this.#at("trust")) this.#applyTrust();
				return;
			case "folder-change":
				if (this.#at("folder")) await this.#changeFolder();
				return;
			case "folder-default":
				if (this.#at("folder")) {
					this.#folderProblem = null;
					this.#save({ workFolder: undefined });
				}
				return;
			case "folder-next":
				if (this.#at("folder")) await this.#acceptFolder();
				return;
			case "install-retry":
				if (this.#at("install") && !this.#installing) await this.#runInstall();
				return;
			case "start-retry":
				if (this.#at("start") && !this.#starting) await this.#startStack();
				return;
			case "repair":
				if (this.#at("start")) {
					const outcome = await this.repair();
					if (!outcome.ok) {
						this.#startStatus = "failed";
						this.#startFailure = outcome.failure;
						this.#emit();
					} else if (this.#startStatus !== "idle" || this.#d.supervisor.state !== "running") await this.#startStack();
				}
				return;
			case "later":
				this.#later();
				return;
			case "hosts-next":
				if (this.#at("hosts")) this.#hostsNext();
				return;
			case "finish":
				if (this.#at("done")) this.#finish();
				return;
			case "forge-begin":
			case "forge-start":
			case "forge-token":
			case "forge-cancel":
			case "forge-open":
			case "forge-copy-code":
			case "forge-sign-out":
				await this.forgeAction(action);
				return;
		}
	}

	/**
	 * A request from the hosts step or from settings' Accounts. The host must be one of this recipe's, and a kind it names must be that host's kind: a page cannot make the app sign in to, or open,
	 * a host the recipe never listed.
	 */
	async forgeAction(action: ForgeAction): Promise<void> {
		// The page is a renderer: the shape is checked here, not trusted from its types.
		if (!isForgeAction(action)) return;
		const forge = this.forges.find((f) => f.host === action.host);
		if (forge === undefined || ("kind" in action && action.kind !== forge.kind)) return;
		// A token is for GitLab only: for a GitHub host it would replace that host's sign-in state (T10R-F009).
		if (action.type === "forge-token" && forge.kind !== "gitlab") return;
		await this.#d.accounts.act(action);
	}

	/** Starts the checks of the forge on screen when the hosts step shows it and nothing has run for it yet. */
	#syncHosts(): void {
		const file = this.#file;
		if (file.done || file.step !== "hosts") return;
		const forge = this.forges[Math.min(file.hostsIndex, Math.max(0, this.forges.length - 1))];
		if (forge === undefined) return;
		if (this.#d.accounts.flowOf(forge.host).phase === "idle") void this.#d.accounts.begin(forge.kind, forge.host).catch((error: Error) => this.#d.log({ event: "forge-begin-failed", detail: firstLineOf(error.message) }));
	}

	#at(step: WizardStep): boolean {
		return this.#file.step === step && !this.#file.done;
	}

	#save(change: Partial<WizardFile> & { workFolder?: string | undefined }): void {
		const next: WizardFile = { ...this.#file, ...change };
		if (change.workFolder === undefined && "workFolder" in change) delete next.workFolder;
		this.#file = next;
		writeWizardFile(this.#d.layout, this.#file);
		this.#emit();
		this.#syncHosts();
	}

	#go(step: WizardStep): void {
		this.#save({ step });
	}

	// ---- recipe and trust --------------------------------------------------------------------------------------------

	async #chooseRecipe(): Promise<void> {
		let picked: { name: string; text: string } | null;
		try {
			picked = await this.#d.pickRecipeFile();
		} catch (error) {
			this.#refuse([{ field: "(file)", rule: "unreadable" }]);
			this.#d.log({ event: "recipe-unreadable", detail: firstLineOf((error as Error).message) });
			return;
		}
		if (picked !== null) this.#takeRecipe(picked.name, picked.text);
	}

	#refuse(refused: RecipeRefusal[]): void {
		this.#refused = refused;
		this.#pending = null;
		this.#emit();
	}

	#takeRecipe(name: string, text: string): void {
		let stack: Stack;
		try {
			stack = this.#stackNow().stack;
		} catch (error) {
			this.#d.log({ event: "wizard-stack-unusable", detail: firstLineOf((error as Error).message) });
			this.#refuse([{ field: "(app)", rule: "stack-unusable" }]);
			return;
		}
		const intake = intakeRecipe(this.#d.validate, stack, name, typeof text === "string" ? text : "");
		if (!intake.ok) {
			// The rules and fields go to the log, never the file's text.
			this.#d.log({ event: "recipe-refused", refused: intake.refused.map((r) => `${r.field}:${r.rule}`) });
			this.#refuse(intake.refused);
			return;
		}
		this.#refused = [];
		this.#pending = { ...intake, choice: { kind: "recipe", summary: { id: intake.recipe.id, name: intake.recipe.name, version: intake.recipe.version }, fileName: intake.fileName } };
		this.#go("trust");
	}

	#noRecipe(github: boolean, gitlabHost: string): void {
		const forges: Forge[] = [];
		if (github) forges.push({ kind: "github", host: "github.com" });
		const host = gitlabHost.trim().toLowerCase();
		if (host !== "") {
			if (!HOST.test(host) || host.length > 253) {
				this.#refuse([{ field: "gitlabHost", rule: "bad-host" }]);
				return;
			}
			forges.push({ kind: "gitlab", host });
		}
		if (forges.length === 0) {
			this.#refuse([{ field: "forges", rule: "none-chosen" }]);
			return;
		}
		this.#refused = [];
		this.#pending = null;
		this.#recipe = null;
		// "I have no recipe": no trust screen, since there is nothing from a colleague to trust. Any recipe file of an earlier choice is dropped.
		this.#clearRecipeFiles();
		this.#save({ noRecipeForges: forges, step: "folder" });
	}

	#cancelTrust(): void {
		// Nothing was written, so nothing is undone.
		this.#pending = null;
		this.#refused = [];
		this.#go("recipe");
	}

	#clearRecipeFiles(except?: string): void {
		try {
			for (const n of readdirSync(this.#d.layout.recipe)) if (n.endsWith(".json") && n !== except) rmSync(join(this.#d.layout.recipe, n), { force: true });
		} catch {
			// no recipe folder yet
		}
	}

	#applyTrust(): void {
		const pending = this.#pending;
		if (pending === null) return;
		// Apply is the first write: the accepted file as it came, named by its id (the id is `^[a-z0-9][a-z0-9-]{1,40}$`, so it is a safe file name).
		mkdirSync(this.#d.layout.recipe, { recursive: true });
		const target = `${pending.recipe.id}.json`;
		this.#clearRecipeFiles(target);
		writeFileAtomic(join(this.#d.layout.recipe, target), pending.text);
		this.#recipe = pending.recipe;
		this.#pending = null;
		const next: Partial<WizardFile> = { recipeFile: plainFileName(pending.fileName), step: "folder" };
		const file = { ...this.#file };
		delete file.noRecipeForges;
		this.#file = file;
		this.#save(next);
	}

	// ---- the work folder ---------------------------------------------------------------------------------------------

	#problemOf(path: string): FolderProblem | null {
		return workFolderProblem({
			path,
			home: this.#d.home,
			root: this.#d.layout.root,
			platform: this.#d.platform,
			...(this.#d.realpath !== undefined ? { realpath: this.#d.realpath } : {}),
			isFile: this.#d.isFile ?? ((p: string) => { try { return !statSync(p).isDirectory(); } catch { return false; } }),
		});
	}

	async #changeFolder(): Promise<void> {
		const picked = await this.#d.pickFolder(this.#file.workFolder ?? defaultWorkFolder(this.#d.home));
		if (picked === null) return;
		const problem = this.#problemOf(picked);
		this.#folderProblem = problem;
		if (problem === null) this.#save({ workFolder: picked });
		else this.#emit();
	}

	async #acceptFolder(): Promise<void> {
		const path = this.#file.workFolder ?? defaultWorkFolder(this.#d.home);
		const problem = this.#problemOf(path);
		this.#folderProblem = problem;
		if (problem !== null) {
			this.#emit();
			return;
		}
		// The work folder is recorded in the file in any case, so every later start reads the same place.
		this.#save({ workFolder: path, step: "install" });
		await this.#runInstall();
	}

	// ---- install -----------------------------------------------------------------------------------------------------

	#engineRecipe(): unknown {
		const recipe = this.recipe;
		if (recipe !== null) return recipe;
		const forges = this.#file.noRecipeForges;
		return forges === undefined ? undefined : { forges: forges.map((f) => ({ kind: f.kind, host: f.host })), tools: [] };
	}

	#plannedStages(stack: Stack, recipeObj: unknown): string[] {
		try {
			return orderStages(allStages(stack, engineRecipeOf(recipeObj, stack), this.#d.platform)).map((s) => s.name);
		} catch (error) {
			this.#d.log({ event: "install-plan-failed", detail: firstLineOf((error as Error).message) });
			return [];
		}
	}

	/**
	 * Runs the engine once and returns how it ended, feeding the install list. An engine process that ends before it says it is done is a resumable event (spec: Crash and sleep): the run
	 * starts again, since verified stages are skipped; a second crash in the same stage fails that stage.
	 */
	async #runEngine(options: { force?: boolean; forceStages?: string[] }): Promise<{ ok: boolean }> {
		const d = this.#d;
		const active = this.#stackNow();
		const recipeObj = this.#engineRecipe();
		const hosts = this.forges.map((f) => f.host);
		this.#progress.begin(this.#plannedStages(active.stack, recipeObj));
		this.#emit();
		const crashedIn = new Set<string>();
		for (let attempt = 0; ; attempt++) {
			const proxyEnv = await d.supervisor.engineProxyEnv(hosts);
			const config: EngineConfig = {
				root: d.layout.root,
				home: d.home,
				platform: d.platform,
				stack: active.raw,
				secretPatterns: d.secretPatterns,
				...(recipeObj !== undefined ? { recipe: recipeObj } : {}),
				...(options.force ? { force: true } : {}),
				...(options.forceStages !== undefined ? { forceStages: options.forceStages } : {}),
				...(Object.keys(proxyEnv).length > 0 ? { proxyEnv } : {}),
			};
			let end: EngineEnd;
			try {
				end = await d.engine.run(config, (event) => {
					this.#progress.apply(event);
					this.#emit();
				});
			} catch (error) {
				this.#progress.errored(firstLineOf((error as Error).message));
				this.#progress.finish(false, d.logTail(40));
				return { ok: false };
			}
			if (end.kind === "done") {
				this.#progress.finish(end.ok, d.logTail(40));
				return { ok: end.ok };
			}
			if (end.kind === "error") {
				this.#progress.errored(firstLineOf(end.message));
				this.#progress.finish(false, [...end.details, ...d.logTail(40)].slice(-40));
				return { ok: false };
			}
			if (end.kind === "disposed") return { ok: false };
			// crashed
			const stage = this.#progress.working ?? "";
			d.log({ event: "engine-crashed", stage, code: end.code, attempt });
			if (crashedIn.has(stage) || attempt >= MAX_RESUMES) {
				this.#progress.crashFailed(stage);
				this.#progress.finish(false, d.logTail(40));
				return { ok: false };
			}
			crashedIn.add(stage);
			// The list shows the run again from the stages that are left.
			this.#progress.begin(this.#plannedStages(active.stack, recipeObj));
		}
	}

	async #runInstall(): Promise<void> {
		if (this.#installing) return;
		this.#installing = true;
		try {
			let ok = false;
			try {
				ok = (await this.#runEngine({})).ok;
			} catch (error) {
				// The stack file or the plan could not be used: the same failed list, with the message.
				this.#progress.errored(firstLineOf((error as Error).message));
				this.#progress.finish(false, this.#d.logTail(40));
			}
			this.#emit();
			if (ok && this.#at("install")) {
				this.#go("start");
				await this.#startStack();
			}
		} finally {
			this.#installing = false;
			this.#emit();
		}
	}

	// ---- start -------------------------------------------------------------------------------------------------------

	async #startStack(): Promise<void> {
		if (this.#starting) return;
		this.#starting = true;
		this.#startStatus = "starting";
		this.#startFailure = null;
		this.#emit();
		try {
			await this.#d.supervisor.start();
			this.#startStatus = "idle";
			if (this.#at("start")) this.#go("claude");
		} catch (error) {
			this.#startStatus = "failed";
			this.#startFailure = error instanceof StartFailureError ? shellFailureOf(error.failure) : { kind: "other", reason: firstLineOf((error as Error).message) };
		} finally {
			this.#starting = false;
			this.#emit();
		}
	}

	/**
	 * Repair (spec: Settings, Diagnostics): clears an engine lock nothing holds, stops the stack, runs the engine again (a stage whose files no longer match its record reinstalls; the
	 * others are skipped), and starts the stack again if it was running. The caller starts a stack that was not running.
	 */
	async repair(failureKind?: string): Promise<RepairOutcome> {
		const d = this.#d;
		d.supervisor.repairLock();
		let result: { ok: boolean } = { ok: false };
		try {
			// A start failure that names one package (`loader`, `intercom`) cannot be seen by that stage's check, so Repair installs the package anyway (R9B-F001). The stop waits for
			// leftovers as the engine does (R9B-F006).
			const named = REPAIR_STAGE_OF[failureKind ?? this.#startFailure?.kind ?? ""];
			result = await d.supervisor.withStackStopped(() => this.#runEngine(named === undefined ? {} : { forceStages: [named] }), { waitForTools: true });
		} catch (error) {
			const failure: ShellFailure = { kind: "repair-failed", reason: firstLineOf((error as Error).message), offerRepair: true };
			return { ok: false, failure };
		}
		if (result.ok) return { ok: true };
		const first = this.#progress.view().failures[0];
		return { ok: false, failure: { kind: "repair-failed", reason: first === undefined ? "" : first.detail.split(/\r?\n/)[0]?.slice(0, 400) ?? "", offerRepair: true } };
	}

	// ---- the sign-in steps and the end -------------------------------------------------------------------------------

	#later(): void {
		const file = this.#file;
		if (file.done) return;
		const forges = this.forges;
		if (file.step === "claude") {
			this.#save({ later: addLater(file.later, { item: "claude" }), step: forges.length > 0 ? "hosts" : this.linearOffered ? "linear" : "done", hostsIndex: 0 });
		} else if (file.step === "hosts") {
			const forge = forges[file.hostsIndex];
			// A login that is being finished (glab signing in, the entries being recorded) is not interrupted: Later waits for it (T10R-F001).
			if (forge !== undefined && this.#d.accounts.flowOf(forge.host).phase === "working") return;
			// A sign-in that waits (the device code, the token field) ends with the PM's choice.
			if (forge !== undefined) this.#d.accounts.cancel(forge.host);
			this.#advanceHosts(forge === undefined ? null : { item: forge.kind, host: forge.host });
		} else if (file.step === "linear") {
			this.#save({ later: addLater(file.later, { item: "linear" }), step: "done" });
		}
	}

	/** On from the forge on screen: to the next forge, else to Linear or the end. `put` is the sign-in put off, if it was. */
	#advanceHosts(put: LaterItem | null): void {
		const file = this.#file;
		const forges = this.forges;
		const later = put === null ? file.later : addLater(file.later, put);
		const index = file.hostsIndex + 1;
		if (index < forges.length) this.#save({ later, hostsIndex: index });
		else this.#save({ later, step: this.linearOffered ? "linear" : "done", hostsIndex: 0 });
	}

	#hostsNext(): void {
		const forge = this.forges[this.#file.hostsIndex];
		if (forge === undefined || this.#d.accounts.flowOf(forge.host).phase !== "done") return;
		this.#advanceHosts(null);
	}

	#finish(): void {
		this.#save({ done: true });
		for (const l of this.#doneListeners) l();
	}

	/** After the wizard: the later items change (task 10 and 11 remove one when it is signed in). */
	setLater(items: LaterItem[]): void {
		this.#save({ later: items });
	}

	/** The wizard shows the short wait of a later launch until the GUI loads. */
	setLaunching(value: boolean): void {
		this.#launching = value;
		this.#emit();
	}

	get workFolder(): string {
		return this.#file.workFolder ?? defaultWorkFolder(this.#d.home);
	}
}

const sameLater = (a: LaterItem, b: LaterItem): boolean => a.item === b.item && ("host" in a ? "host" in b && a.host === b.host : !("host" in b));

function addLater(list: readonly LaterItem[], item: LaterItem): LaterItem[] {
	return list.some((l) => sameLater(l, item)) ? [...list] : [...list, item];
}
