import type { Locale } from "./locale.ts";
import type { ShellFailure } from "./shell-state.ts";

// What the wizard (`renderer/wizard.ts`) and the settings page (`renderer/settings.ts`) are told by main, and what they may ask for (spec: The wizard). Plain data, so it crosses the IPC
// boundary and the renderer imports only this file. The words are the catalog's: main sends kinds, ids and values, and the pages word them, so a PM reads one language whatever a tool printed.

/** The wizard's steps in order. Step 10 (projects) belongs to a later task; the sign-in steps are placeholders that end in **Later**. */
export const WIZARD_STEPS = ["welcome", "recipe", "trust", "folder", "install", "start", "claude", "hosts", "linear", "done"] as const;
export type WizardStep = (typeof WIZARD_STEPS)[number];

/** A sign-in the PM put off. It shows as a badge in settings and as a notice over the GUI. */
export type LaterItem = { item: "claude" } | { item: "github"; host: string } | { item: "gitlab"; host: string } | { item: "linear" };

export interface Forge {
	kind: "github" | "gitlab";
	host: string;
}

// ---- the recipe step ---------------------------------------------------------------------------------------------------

/** One refusal of a recipe file: the field and the rule that broke, never the value (spec: First run, step 2). */
export interface RecipeRefusal {
	field: string;
	rule: string;
}

export interface RecipeSummary {
	id: string;
	name: string;
	version: string;
}

/** Where the accepted recipe came from: a file name, or nothing for "I have no recipe". */
export type RecipeChoice = { kind: "none" } | { kind: "recipe"; summary: RecipeSummary; fileName: string } | { kind: "no-recipe"; forges: Forge[] };

// ---- the trust step ----------------------------------------------------------------------------------------------------

/** What **Trust: show before applying** lists, line by line (team-profile section 5). */
export interface TrustModel {
	name: string;
	version: string;
	/** The file name the recipe came from. */
	source: string;
	sha256: string;
	/** The code hosts it signs in to, each with the CLI it installs. */
	forges: Array<Forge & { cli: "gh" | "glab" }>;
	repos: Array<{ url: string; host: string; folder: string; label: string; defaultBranch: string | null }>;
	relay: string | null;
	/** Optional tools, with the version `stack.json` pins for this machine. */
	tools: Array<{ name: string; version: string | null }>;
	/** The profile version the recipe pins, flagged when it is older than the app's default. */
	profile: { version: string; olderThanDefault: boolean } | null;
	/** The team instructions in full; null when there are none. */
	instructions: string | null;
	/** Extra packages: each installs third-party code. */
	packages: Array<{ name: string; version: string }>;
	linear: boolean;
}

// ---- the work folder step ----------------------------------------------------------------------------------------------

export type FolderProblem = "not-absolute" | "outside-home" | "is-home" | "inside-app-data" | "not-a-folder";

// ---- the install step --------------------------------------------------------------------------------------------------

export type StageBadge = "waiting" | "working" | "done" | "skipped" | "failed" | "blocked";

export interface InstallStage {
	/** The engine's stage name (`node`, `pkg:pi-straw-boss`): the page words it from the catalog; the raw name is under **Details**. */
	name: string;
	badge: StageBadge;
}

/** A stage failure, as the page words it: the category picks the sentence, `params` fill it. */
export interface InstallFailure {
	stage: string;
	category: "network" | "integrity" | "registry" | "disk" | "locked" | "other";
	params: { host?: string; tool?: string; what?: string; stage?: string; reason?: string; name?: string; cause?: string };
	/** The tool's own line, redacted. */
	detail: string;
}

export interface InstallView {
	status: "idle" | "running" | "done" | "failed";
	stages: InstallStage[];
	/** The stage that is working now, for the one plain line. */
	current: string | null;
	failures: InstallFailure[];
	/** The last 40 lines of the install's log, redacted (under **Details**). */
	tail: string[];
	/** The stage an engine crash failed (a second crash of the same stage), if any. */
	crashed: string | null;
}

// ---- the whole view ----------------------------------------------------------------------------------------------------

export interface WizardView {
	/** The step to show. `launching` is the short wait of a later launch, between the window opening and the GUI loading. */
	step: WizardStep | "launching";
	/** The full step list, the same from step 1 to the last, so the progress line's total never changes (SA-01). A step a run skips (trust without a recipe, hosts, Linear) leaves a gap in the count. */
	steps: WizardStep[];
	locale: Locale;
	/** The data root, named on the welcome screen. */
	root: string;
	/** True in a development build (the badge). */
	dev: boolean;
	welcome: { wslBash: string | null };
	recipe: { choice: RecipeChoice; refused: RecipeRefusal[]; fileName: string | null };
	trust: TrustModel | null;
	folder: { path: string; defaultPath: string; problem: FolderProblem | null };
	install: InstallView;
	start: { status: "idle" | "starting" | "failed"; failure: ShellFailure | null };
	/** The forges the hosts step walks through, and the one it is at. */
	hosts: { forges: Forge[]; index: number };
	linearOffered: boolean;
	later: LaterItem[];
}

/** What the wizard may ask main for. Main checks the step and the sender; an action out of turn is ignored. */
export type WizardAction =
	| { type: "set-locale"; locale: Locale }
	| { type: "welcome-next" }
	| { type: "rescan" }
	| { type: "choose-recipe-file" }
	| { type: "recipe-text"; name: string; text: string }
	| { type: "no-recipe"; github: boolean; gitlabHost: string }
	| { type: "recipe-back" }
	| { type: "trust-apply" }
	| { type: "trust-cancel" }
	| { type: "folder-change" }
	| { type: "folder-default" }
	| { type: "folder-next" }
	| { type: "install-retry" }
	| { type: "start-retry" }
	| { type: "repair" }
	| { type: "later" }
	| { type: "finish" };

export const SETTINGS_SECTIONS = ["accounts", "recipe", "guidance", "updates", "computer", "diagnostics"] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

/** A notice over the GUI that stays until it is dealt with: the WSL sentence at every start, and the sign-ins put off. */
export type ShellNotice = { id: "wsl"; path: string } | { id: "later"; items: LaterItem[] };

export interface SettingsView {
	locale: Locale;
	section: SettingsSection;
	later: LaterItem[];
	recipe: RecipeSummary | null;
	appVersion: string;
	dev: boolean;
}

export type SettingsAction = { type: "close" } | { type: "section"; section: SettingsSection } | { type: "set-locale"; locale: Locale };
