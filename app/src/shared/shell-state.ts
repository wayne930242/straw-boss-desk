// What the shell view's runtime page (`screen.html`) shows over or instead of the GUI: nothing, a small notice, or a whole screen. Plain data, so it crosses the IPC boundary
// and the renderer imports only this file. The words are the catalog's: the page maps a kind to its sentence, so a PM reads the same words whatever the tool printed.

import type { SettingsSection, ShellNotice } from "./wizard.ts";

export type ShellBanner = "restarting" | "address-changed" | "starting";

/** The failure as the screen needs it: the kind picks the sentence; the rest is for **Details**. */
export interface ShellFailure {
	kind: string;
	/** The first line of what the tool said, with the page token masked. */
	reason: string;
	/** Set for the failure kind `sb-unverified`: the sentence names this pid. */
	pid?: number;
	/** Programs still running from the app's tools folder after a stop that failed. */
	leftovers?: Array<{ pid: number; file: string }>;
	/** The sentence says to run Repair. */
	offerRepair?: boolean;
}

export type ShellState =
	| { mode: "none" }
	| { mode: "banner"; banner: ShellBanner }
	/** Notices that stay until dealt with (the WSL sentence, the sign-ins put off): a strip over the GUI, one row each. */
	| { mode: "notices"; notices: ShellNotice[] }
	| { mode: "screen"; screen: "gui-stopped" | "server-stopped" }
	| { mode: "screen"; screen: "failed"; failure: ShellFailure };

/**
 * What a button of the runtime page asks for: **Start** (the GUI or the server was stopped) and **Try again** are the same request (`retry`); **Repair** (`repair`); a notice's buttons;
 * and the height the notice strip needs, which only the page can measure.
 */
export type ShellAction = "retry" | "repair" | { type: "dismiss-notice"; id: "wsl" } | { type: "open-settings"; section: SettingsSection } | { type: "strip-height"; height: number };

/** The IPC channels between main and the pages; the preloads repeat the names as literals (a test keeps the two lists equal). */
export const CHANNELS = {
	guiOrigin: "sbd:gui-origin",
	pickFolder: "sbd:pick-folder",
	state: "sbd:shell-state",
	stateChanged: "sbd:shell-state-changed",
	action: "sbd:shell-action",
	locale: "sbd:locale",
	localeChanged: "sbd:locale-changed",
	wizardState: "sbd:wizard-state",
	wizardChanged: "sbd:wizard-changed",
	wizardAct: "sbd:wizard-act",
	settingsState: "sbd:settings-state",
	settingsChanged: "sbd:settings-changed",
	settingsAct: "sbd:settings-act",
} as const;
