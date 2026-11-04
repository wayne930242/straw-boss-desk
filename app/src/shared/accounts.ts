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
	/** The verdict found a plain-text token: it was removed, and the login is refused with the sentence of the store probe. */
	| { phase: "plain-text"; detail: string }
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
