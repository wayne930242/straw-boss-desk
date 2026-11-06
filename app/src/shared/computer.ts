// What settings' Computer and Diagnostics sections are told by main and may ask for (spec: Settings, **Uninstall and data**, Diagnostics). Plain data, so it crosses the IPC boundary and the
// renderer imports only this file. Main sends phases, names and values; the pages word them from the catalog. Nothing here carries a secret: an entry of the credential store is a name, an
// account and a host, never a value.

/**
 * An entry that **Remove all data** leaves in the OS credential store, named for the PM (spec: Uninstall and data):
 *  - `changed`: Straw Boss made it and did not remove it, because something else wrote over it afterwards (**Ownership**);
 *  - `foreign`: another program made it (the PM's own `gh` or `glab`), so it was never Straw Boss's;
 *  - `failed`: Straw Boss made it and still owns it, but the removal did not work (result only).
 */
export interface LeftEntry {
	name: string;
	account: string;
	host: string;
	why: "changed" | "foreign" | "failed";
}

/** What the confirmation screen says before anything is touched. */
export interface RemovalPlan {
	/** The data root that goes. */
	root: string;
	/** Its size in bytes, or null when it could not be measured. */
	bytes: number | null;
	/** The work folder, which stays with its clones; null when none was chosen. */
	workFolder: string | null;
	/** Store entries that stay, by name (a `left` entry the app made, and another program's); empty when none. */
	left: LeftEntry[];
	/** Windows: the user PATH entry that goes. */
	pathEntry: string | null;
}

/** The parts of the removal, in the order they run; the working screen names the one that runs. */
export type RemoveStep = "stopping" | "logins" | "claude" | "linear" | "path" | "safe-storage" | "files";

/** Something that did not finish; the removal went on, and the result names it. */
export interface RemovalProblem {
	step: RemoveStep;
	/** The first line of what failed. */
	detail: string;
}

export interface RemovalResult {
	root: string;
	workFolder: string | null;
	left: LeftEntry[];
	problems: RemovalProblem[];
}

export interface Leftover {
	pid: number;
	file: string;
}

export type RemoveState =
	| { phase: "idle" }
	/** Listing the credential store and measuring the folder. */
	| { phase: "planning" }
	| { phase: "confirm"; plan: RemovalPlan }
	/** Nothing was touched. `store`: the credential store cannot be listed, so the app cannot tell which sign-ins are its own. */
	| { phase: "refused"; reason: "store"; detail: string }
	| { phase: "working"; step: RemoveStep }
	/** The stack could not be stopped: programs of this app still run, listed by file. Nothing was removed; the stack was started again when it ran before. */
	| { phase: "stop-failed"; leftovers: Leftover[]; detail: string }
	/** Another stop (Restart to update, or a quit) was already under way, so nothing was started and nothing was removed. */
	| { phase: "busy" }
	| { phase: "done"; result: RemovalResult }
	/** An error the removal did not expect, before it deleted anything. */
	| { phase: "failed"; detail: string };

export interface ComputerView {
	platform: "win32" | "darwin";
	keepAwake: boolean;
	remove: RemoveState;
}

export type ComputerAction =
	| { type: "computer-keep-awake"; on: boolean }
	/** **Remove all data…**: list the store, measure the folder, show the confirmation. */
	| { type: "computer-remove-plan" }
	| { type: "computer-remove-cancel" }
	| { type: "computer-remove-confirm" }
	/** After the result: leave the app, which lets the rest of `<root>` go. */
	| { type: "computer-quit" }
	/** The guide's page on removing a sign-in by hand. */
	| { type: "computer-open-guide" };

// ---- Diagnostics ---------------------------------------------------------------------------------------------------

/** The few fields of `cli.mjs status` the page shows. The status holds the page's address and token, so main passes on named fields and key names only. */
export interface StatusFields {
	state: string | null;
	primary: boolean | null;
	desk: boolean | null;
	version: string | null;
	keys: string[];
}

export type StatusState =
	| { phase: "idle" }
	| { phase: "reading" }
	| { phase: "ok"; fields: StatusFields; at: string }
	/** `not-installed`: the setup is not complete; `package`: pi-straw-boss is not verified, so its CLI is not run; `busy`: a setup step holds the tools; `failed`: the call failed. */
	| { phase: "failed"; reason: "not-installed" | "package" | "busy" | "failed"; detail: string };

export type CollectState =
	| { phase: "idle" }
	| { phase: "working" }
	/** `file` is the zip; `files` counts what it holds; `skipped` counts files left out as binary or too large. */
	| { phase: "done"; file: string; files: number; skipped: number }
	| { phase: "failed"; detail: string };

export type RepairState = { phase: "idle" } | { phase: "working" } | { phase: "done" } | { phase: "failed"; detail: string };

export interface DiagnosticsView {
	status: StatusState;
	collect: CollectState;
	repair: RepairState;
	/** The logs folder, named so the PM can find it when it does not open. */
	logsDir: string;
	/** Windows: `bash` in a pane would be WSL's; the same sentence as the banner (spec: Panes on Windows). */
	wslBash: string | null;
}

export type DiagnosticsAction =
	| { type: "diagnostics-status" }
	| { type: "diagnostics-open-logs" }
	| { type: "diagnostics-collect" }
	| { type: "diagnostics-reveal" }
	| { type: "diagnostics-repair" };

const COMPUTER_TYPES: readonly string[] = ["computer-keep-awake", "computer-remove-plan", "computer-remove-cancel", "computer-remove-confirm", "computer-quit", "computer-open-guide"];
const DIAGNOSTICS_TYPES: readonly string[] = ["diagnostics-status", "diagnostics-open-logs", "diagnostics-collect", "diagnostics-reveal", "diagnostics-repair"];

const typeOf = (value: unknown): string | null => (typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string" ? (value as { type: string }).type : null);

export const isComputerAction = (value: unknown): value is ComputerAction => {
	const type = typeOf(value);
	if (type === null || !COMPUTER_TYPES.includes(type)) return false;
	return type !== "computer-keep-awake" || typeof (value as { on?: unknown }).on === "boolean";
};

export const isDiagnosticsAction = (value: unknown): value is DiagnosticsAction => {
	const type = typeOf(value);
	return type !== null && DIAGNOSTICS_TYPES.includes(type);
};
