// What settings' Updates section is told by main and may ask for (spec: Updater, Settings). Plain data, so it crosses the IPC boundary and the renderer imports only this file. Main sends
// phases, reasons and values; the page words them from the catalog.

/** Why a stack candidate was refused. The page words each; none carries a value of the candidate beyond the few named fields. */
export type StackRefusal =
	/** The signature is there and no key of the list verifies the file. */
	| "bad-signature"
	/** The channel offered `stack.json` without a `.sig`. */
	| "no-signature"
	| "malformed-signature"
	/** This build has no key to verify with. */
	| "no-keys"
	| "bad-key-list"
	/** The file is not a stack this app can read. */
	| "invalid"
	/** Its generation is lower than the active one. */
	| "older"
	/** It needs a newer app (`minShell`). */
	| "min-shell"
	/** It no longer lists an optional tool the active recipe names. */
	| "recipe-tool"
	| "too-large";

/** One line of the change list: a tool or a package whose version changes (`from` null: added; `to` null: removed). */
export interface ChangeLine {
	kind: "tool" | "optionalTool" | "npm" | "package" | "profile";
	/** The tool's or package's name as the stack writes it. */
	name: string;
	/** The engine stage that installs it (`node`, `fd-rg`, `pkg:pi-lens`, `pi`, `profile`): the page words the line with the install step's labels, so a package name shows only where the install list shows it. */
	stage: string;
	from: string | null;
	to: string | null;
}

export type StackUpdateState =
	/** Nothing newer is offered. `checkedAt` is the last check that finished, or null. */
	| { phase: "idle"; checkedAt: string | null }
	| { phase: "checking" }
	| { phase: "available"; generation: number; changes: ChangeLine[] }
	/** `stage` is the engine's stage name that works now (the page words it from the install catalog); `done` counts the stages that ended. */
	| { phase: "applying"; generation: number; stage: string | null; done: number }
	| { phase: "applied"; generation: number; at: string }
	/** The candidate failed in `stage`; `restored` says the old generation is back and the stack runs on it. */
	| { phase: "rolled-back"; generation: number; stage: string; category: string; restored: boolean; at: string }
	/** `generation`, `minShell` and `tools` are filled for the reasons that name them. */
	| { phase: "refused"; reason: StackRefusal; generation?: number; minShell?: string; tools?: string[] }
	| { phase: "error"; kind: "network" | "other"; detail: string };

export type ShellRefusal = "bad-signature" | "no-signature" | "malformed-signature" | "no-keys" | "bad-key-list" | "too-large";

export type ShellUpdateState =
	/** This build checks nothing: no feed is configured. */
	| { phase: "off" }
	| { phase: "idle"; checkedAt: string | null }
	| { phase: "checking" }
	/** macOS: a newer version exists; **Download the new version** fetches it. */
	| { phase: "available"; version: string }
	| { phase: "downloading"; version: string; percent: number | null }
	/** Windows: the installer is downloaded and the signature checked; **Restart to update** is offered. */
	| { phase: "ready"; version: string }
	/** macOS: the dmg is downloaded, checked and shown in its folder. `folder` is the folder's name for the sentence. */
	| { phase: "downloaded"; version: string; file: string }
	| { phase: "refused"; version: string; reason: ShellRefusal }
	| { phase: "error"; kind: "network" | "other"; detail: string };

export interface UpdatesView {
	appVersion: string;
	/** The generation of the stack in force. */
	generation: number;
	shell: ShellUpdateState;
	stack: StackUpdateState;
	/** A check of either channel is running, so **Check now** waits. */
	checking: boolean;
	/** The last time a check of both channels ended, ISO text, or null. */
	checkedAt: string | null;
	/** The platform decides the verb: Windows restarts into the installer, macOS downloads a file. */
	platform: "win32" | "darwin";
}

/** What the Updates section may ask. Main checks the sender and that the action fits the state. */
export type UpdateAction =
	| { type: "update-check" }
	| { type: "update-apply" }
	| { type: "update-restart" }
	| { type: "update-download" }
	| { type: "update-reveal" };

const TYPES: readonly string[] = ["update-check", "update-apply", "update-restart", "update-download", "update-reveal"];

export const isUpdateAction = (value: unknown): value is UpdateAction => typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string" && TYPES.includes((value as { type: string }).type);
