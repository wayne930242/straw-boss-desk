import type { Forge } from "./wizard.ts";

// What the code-host screens (the wizard's step 8 and settings' Accounts) are told by main and may ask for (spec: The code-host screens). Plain data, so it crosses the IPC boundary and the
// renderer imports only this file. Main sends kinds, host names and entry names; the pages word them from the catalog. A secret never appears here in the other direction: the one value the
// page sends is the GitLab token, in `forge-token`, which main writes to the CLI's standard input and drops.

/** A store entry by its attributes: the name gh and glab give it (`gh:github.com`, `glab:gitlab.com:token`) and its account. Never a secret, never a time. */
export interface EntryName {
	name: string;
	account: string;
}

/** What a forge's row says in settings. */
export type ForgeState =
	/** The app's own sign-in is there, and every one of its store entries is still the one the app wrote. */
	| "signed-in"
	| "not-signed-in"
	/** A sign-in made by another program is in the store under this host's names. The app leaves it alone. */
	| "foreign"
	/** The app signed in, and its entry was changed afterwards by something else (**Ownership**). */
	| "left"
	/** The store could not be listed, so nothing is known. */
	| "unknown";

/** Where one sign-in attempt, or the checks before it, stand. */
export type ForgeFlow =
	| { phase: "idle" }
	/** The store probe and the existing-sign-in check run. */
	| { phase: "checking" }
	/** The probe or the listing failed: the refusal of the store, worded the same as the plain-text refusal. `detail` is the first line of what failed, for **Details**. */
	| { phase: "store-unavailable"; detail: string }
	/** An entry the app does not own stops the step. `changed` holds the ones the app made and lost (they are `left`); the rest are another program's. */
	| { phase: "foreign"; entries: EntryName[]; changed: EntryName[] }
	/** The checks passed: GitHub shows **Sign in**, GitLab its token field. */
	| { phase: "ready" }
	/** `gh auth login` runs and has not printed its code yet. */
	| { phase: "waiting-code" }
	/** The one-time code, and the device page it is typed on. */
	| { phase: "code"; code: string; deviceUrl: string }
	/** The CLI finished its login; the entries are recorded and the verdict runs. Or glab is signing in with the token. */
	| { phase: "working" }
	/**
	 * The verdict found a plain-text token and the login is refused with the sentence of the store probe. `removed` says whether the files the CLI wrote were read again and hold no token
	 * line any more; when it is false, the screen says a token may still be on this computer and `detail` names where (T10R-F002).
	 */
	| { phase: "plain-text"; detail: string; removed: boolean }
	/** The verdict could not be read; the login is kept and the step fails. */
	| { phase: "unverified"; detail: string }
	/** The CLI said no (a wrong token, a host that does not answer, a closed code). `detail` is its first line, redacted. */
	| { phase: "failed"; detail: string }
	/** The device code was not approved within 15 minutes. */
	| { phase: "timeout" }
	| { phase: "done" }
	/** Sign out ran the CLI's logout and emptied the record. */
	| { phase: "signed-out" }
	/** Sign out found an entry it does not own: no logout ran. `foreign` stays in the store, `left` are the app's own entries now marked as left. */
	| { phase: "left-alone"; foreign: EntryName[]; left: EntryName[] };

export interface ForgeView extends Forge {
	state: ForgeState;
	/** The entries behind `foreign` and `left`, by name and account. */
	entries: EntryName[];
	flow: ForgeFlow;
}

/** What a page may ask of the forge screens. Main checks the sender; the host must be one of the recipe's. */
export type ForgeAction =
	/** Run the store probe and the existing-sign-in check (a wizard step starts them itself; settings' **Sign in again** asks). */
	| { type: "forge-begin"; kind: Forge["kind"]; host: string }
	/** GitHub: start `gh auth login`. Only after the checks passed (`ready`). */
	| { type: "forge-start"; kind: "github"; host: string }
	/** GitLab: the token from the masked field. Main writes it to `glab auth login --stdin` and drops it. */
	| { type: "forge-token"; host: string; token: string }
	/** Stop a sign-in that waits (the device code, the token field) and go back to idle. */
	| { type: "forge-cancel"; host: string }
	/** Open the device page (GitHub) or the token page (GitLab) in the default browser. Main builds the address from the host. */
	| { type: "forge-open"; kind: Forge["kind"]; host: string }
	/** Put the device code on the clipboard (main holds it). */
	| { type: "forge-copy-code"; host: string }
	| { type: "forge-sign-out"; kind: Forge["kind"]; host: string };

/** The longest token the field sends: GitLab's are far shorter; anything longer is not one. */
export const MAX_TOKEN_LENGTH = 512;

const KINDS = ["github", "gitlab"];

export function isForgeAction(value: unknown): value is ForgeAction {
	if (typeof value !== "object" || value === null) return false;
	const a = value as Record<string, unknown>;
	const host = typeof a.host === "string" && a.host.length > 0 && a.host.length <= 253;
	const kind = typeof a.kind === "string" && KINDS.includes(a.kind);
	switch (a.type) {
		case "forge-begin":
		case "forge-open":
		case "forge-sign-out":
			return host && kind;
		case "forge-start":
			return host && a.kind === "github";
		case "forge-token":
			return host && typeof a.token === "string" && a.token.length > 0 && a.token.length <= MAX_TOKEN_LENGTH;
		case "forge-cancel":
		case "forge-copy-code":
			return host;
		default:
			return false;
	}
}

// ---- Claude (spec: First run, step 7) -------------------------------------------------------------------------------------------------------------------

/** What Claude's row says in settings, from the CLI's own status. */
export type ClaudeState = "signed-in" | "not-signed-in" | "unknown";

/**
 * Where one Claude sign-in stands. The login is `claude auth login` with the app's `CLAUDE_CONFIG_DIR`; the browser does the sign-in, and the code field exists only for a CLI that asks to
 * be given a code (a browser that cannot return the sign-in to the CLI by itself).
 */
export type ClaudeFlow =
	| { phase: "idle" }
	/** `claude auth status` runs. */
	| { phase: "checking" }
	/** The CLI runs and has not said where the browser goes yet. */
	| { phase: "starting" }
	/** The CLI opened a browser window and waits. `url` is what it printed for a browser that did not open (null until it printed one); `codeAsked` says it asked for a code; `codeSent` that one was handed over. */
	| { phase: "browser"; url: string | null; codeAsked: boolean; codeSent: boolean }
	/** The CLI ended its login; the status is being read. */
	| { phase: "working" }
	/** The CLI ended with an error (a closed browser tab, a refused code, no network). `detail` is its first line, redacted. */
	| { phase: "failed"; detail: string }
	| { phase: "timeout" }
	/** The login ended well and the status still does not say signed in, or could not be read. */
	| { phase: "unverified"; detail: string }
	| { phase: "done" }
	| { phase: "signed-out" };

export interface ClaudeView {
	state: ClaudeState;
	/** Where Claude Code keeps this login on this computer: the OS keychain, or a file in the app's own Claude folder (Windows; spec: Secrets). */
	storage: "keychain" | "file";
	flow: ClaudeFlow;
}

/** What a page may ask of the Claude screens. Main checks the sender and the phase; an action out of turn is ignored. */
export type ClaudeAction =
	/** Read the status (a wizard step starts it itself; settings opens on it). */
	| { type: "claude-begin" }
	| { type: "claude-start" }
	/** The code from the masked field. Main writes it to the CLI's standard input and drops it. */
	| { type: "claude-code"; code: string }
	| { type: "claude-cancel" }
	/** Open the sign-in address the CLI printed in the default browser. */
	| { type: "claude-open" }
	| { type: "claude-copy-url" }
	| { type: "claude-sign-out" };

/** The longest code the field sends: a sign-in code is a few dozen characters; anything longer is not one. */
export const MAX_CODE_LENGTH = 1024;

export function isClaudeAction(value: unknown): value is ClaudeAction {
	if (typeof value !== "object" || value === null) return false;
	const a = value as Record<string, unknown>;
	switch (a.type) {
		case "claude-begin":
		case "claude-start":
		case "claude-cancel":
		case "claude-open":
		case "claude-copy-url":
		case "claude-sign-out":
			return true;
		case "claude-code":
			return typeof a.code === "string" && a.code.trim().length > 0 && a.code.length <= MAX_CODE_LENGTH;
		default:
			return false;
	}
}

// ---- Linear (spec: First run, step 9; Secrets; Environment) -------------------------------------------------------------------------------------------

/** What Linear's row says: whether `secrets/linear.bin` holds a key the app can read. */
export type LinearState =
	| "saved"
	| "not-saved"
	/** The file is there and cannot be decrypted (another machine, a lost Safe Storage key): the key needs to be entered again, which is not a crash. */
	| "unreadable";

/** Where one save of the key stands. The key is saved first (encrypted), then `ttt` is installed, then `ttt init` runs; a later step failing keeps the key. */
export type LinearFlow =
	| { phase: "idle" }
	/** The PM chose to enter a key (settings' **Change key** beside a key that is saved): the field shows. */
	| { phase: "entering" }
	/** `isEncryptionAvailable()` is false: the key is not saved anywhere (no plain-text fallback). */
	| { phase: "refused" }
	/** What was typed is not shaped like a key (spaces, control characters, too short or too long): nothing was written. */
	| { phase: "invalid" }
	/** The key could not be written (a full disk, a Safe Storage the OS denied). */
	| { phase: "save-failed"; detail: string }
	| { phase: "saving" }
	/** The `ttt` stage runs. */
	| { phase: "installing" }
	/** `ttt init -y` runs. */
	| { phase: "initializing" }
	/** The `ttt` stage or `ttt init` failed; the key stays saved. `step` names which one, `detail` is the first line of what it said, redacted. */
	| { phase: "setup-failed"; step: "install" | "init"; detail: string }
	/** The key is saved, `ttt` is installed and `ttt init` ran (or the folder already held a `ttt` setup). */
	| { phase: "done"; initialized: "ran" | "kept" }
	| { phase: "signed-out" };

/** The offer after a save or a removal while the stack runs: Herdr's environment is fixed for its lifetime, so panes see the change only after a restart. */
export type LinearRestart =
	| { phase: "none" }
	| { phase: "offer"; change: "saved" | "removed" }
	| { phase: "restarting" }
	/** The PM chose **Later**: the change applies at the next start. */
	| { phase: "later" }
	| { phase: "restarted" }
	| { phase: "failed"; detail: string };

export interface LinearView {
	state: LinearState;
	flow: LinearFlow;
	restart: LinearRestart;
	/** False when the OS cannot encrypt: the page says so before the PM types a key. */
	/** Whether the OS can encrypt the key; null until it has been asked (it is asked when the Linear screen opens, never at start: on macOS the first answer reaches into the Keychain). */
	encryption: boolean | null;
}

export type LinearAction =
	/** The key from the masked field. Main encrypts it, writes it, and drops it. */
	| { type: "linear-save"; key: string }
	/** Show the field beside a key that is saved, to replace it. */
	| { type: "linear-edit" }
	/** Leave the field without saving. */
	| { type: "linear-cancel" }
	/** Run the `ttt` stage and `ttt init` again with the key already saved. */
	| { type: "linear-setup" }
	| { type: "linear-open" }
	| { type: "linear-sign-out" }
	| { type: "linear-restart" }
	| { type: "linear-restart-later" };

/** The longest key the field sends: Linear's are about 50 characters. */
export const MAX_KEY_LENGTH = 256;
/** A key is printable ASCII with no space. A value that is not one is refused before anything is written. */
export const KEY_SHAPE = /^[\x21-\x7e]{8,256}$/;

export function isLinearAction(value: unknown): value is LinearAction {
	if (typeof value !== "object" || value === null) return false;
	const a = value as Record<string, unknown>;
	switch (a.type) {
		case "linear-edit":
		case "linear-cancel":
		case "linear-setup":
		case "linear-open":
		case "linear-sign-out":
		case "linear-restart":
		case "linear-restart-later":
			return true;
		case "linear-save":
			return typeof a.key === "string" && a.key.length <= MAX_KEY_LENGTH;
		default:
			return false;
	}
}

/** Every request of an Accounts screen: the page sends one of these, and main routes it. */
export type AccountAction = ForgeAction | ClaudeAction | LinearAction;
export const isAccountAction = (value: unknown): value is AccountAction => isForgeAction(value) || isClaudeAction(value) || isLinearAction(value);
