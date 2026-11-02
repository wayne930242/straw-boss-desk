import type { Leftover } from "./identity.ts";

// The typed failures of a start (spec: Runtime supervisor, Start). The kit's exit codes 2 to 27 (`spike/win/start.ps1`) become `StartFailure.kind`; every kind
// has a screen sentence in both catalogs (`renderer/i18n`, `start.failure.<kind>`). `reason` is the first line of what the tool said, with the page token
// masked; the sentence is the catalog's, so a PM reads the same words whatever the tool printed.

export type StartFailureKind =
	// before `up`
	| "tool-missing" // kit 2
	| "foreign-stack" // kit 3: a Herdr that answers on the app's socket under another environment, and would not stop
	| "herdr-silent" // kit 4
	| "engine-locked" // an install is running, or a stale lock stays (R4-F002): the screen offers Repair
	| "package-unsafe" // a recipe package whose rollback failed and may still load its extensions (T7-F002)
	| "install-interrupted" // a package stage was left `running` by a crash or a kill and no engine runs (R7-F001)
	| "state-unreadable" // `state/bootstrap.json` is missing or damaged, so what is safe to run is not known (R7-F007)
	| "work-folder" // the work folder or the home base folder could not be made
	| "sb-unverified" // a stop that left an sb server of a package that is not verified running, which no record proves ours: its pid is in `unverifiedSb` (T8C-F002)
	| "restart-budget" // more than 3 restarts of the Herdr server or of the sb server in 10 minutes: the app stopped retrying (spec: Crash and sleep)
	| "renderer" // the GUI view's renderer went away twice in a minute (spec: Crash and sleep)
	// `up` exit 1 with a `wait` value
	| "lock" // kit 10
	| "start" // kit 11
	| "hello" // kit 12
	| "exit" // kit 13
	// `up` exit 1 by step
	| "herdr" // kit 14
	| "version" // kit 15
	| "server" // kit 16
	| "gui" // kit 17
	| "other" // kit 18
	// `up` exit 3
	| "cannot-run" // kit 19 (the server cannot run for a reason that is not loader, intercom, or acl)
	| "loader" // kit 19
	| "intercom" // kit 19
	| "acl" // kit 19
	| "acl-admin" // kit 19, an `acl` refusal that names the Administrators group: the app runs with an administrator token (T8A-F005)
	| "usage" // kit 20
	| "no-url" // kit 21
	| "slot" // kit 22
	| "base-busy" // kit 23
	| "base" // kit 24
	| "integration" // kit 25
	| "no-base" // kit 26
	| "tower"; // kit 27

/** The kit's exit code for each kind, so a test can show the table of `start.ps1` is carried over whole. Kinds the kit had no code for map to null. */
export const KIT_EXIT_CODE: Readonly<Record<StartFailureKind, number | null>> = {
	"tool-missing": 2,
	"foreign-stack": 3,
	"herdr-silent": 4,
	"engine-locked": null,
	"package-unsafe": null,
	"install-interrupted": null,
	"state-unreadable": null,
	"work-folder": null,
	"sb-unverified": null,
	"restart-budget": null,
	renderer: null,
	lock: 10,
	start: 11,
	hello: 12,
	exit: 13,
	herdr: 14,
	version: 15,
	server: 16,
	gui: 17,
	other: 18,
	"cannot-run": 19,
	loader: 19,
	intercom: 19,
	acl: 19,
	"acl-admin": 19,
	usage: 20,
	"no-url": 21,
	slot: 22,
	"base-busy": 23,
	base: 24,
	integration: 25,
	"no-base": 26,
	tower: 27,
};

export const START_FAILURE_KINDS = Object.keys(KIT_EXIT_CODE) as StartFailureKind[];

export interface StartFailure {
	kind: StartFailureKind;
	/** `up`'s `step`, when the failure came from it. */
	step?: string;
	/** `up`'s `wait`, when the failure came from it. */
	wait?: string;
	/** The first line of the reason, masked; empty when the tool gave none. */
	reason: string;
	/** `up`'s `startError`: a code (`loader`, `intercom`, `acl`) and the text the server wrote for a person. */
	startError?: { code: string; text: string };
	/** Processes still running under `<root>/tools` after a stop that failed, by pid and executable name. */
	leftovers?: Leftover[];
	/** The pid of a running sb server of a package that is not verified, which the stop did not end (kind `sb-unverified`). The screen names it with Repair (T8C-F002). */
	unverifiedSb?: number;
	/** The screen offers Repair (an engine lock that stays, a package that must be reinstalled). */
	offerRepair?: boolean;
}

export class StartFailureError extends Error {
	readonly failure: StartFailure;
	constructor(failure: StartFailure) {
		super(`${failure.kind}${failure.step ? ` (${failure.step})` : ""}: ${failure.reason}`);
		this.name = "StartFailureError";
		this.failure = failure;
	}
}

/** The page token in a URL, masked: `http://127.0.0.1:1234/<16 or more hex>/` becomes `http://127.0.0.1:1234/<token>/`. */
export const hideToken = (text: string): string => text.replace(/(127\.0\.0\.1:\d+\/)[0-9a-f]{16,}/gi, "$1<token>");

/** The first non-empty line of `text`, masked and cut to 400 characters. */
export const firstLineOf = (text: string): string => hideToken(text.split(/\r?\n/).find((l) => l.trim() !== "")?.trim() ?? "").slice(0, 400);
