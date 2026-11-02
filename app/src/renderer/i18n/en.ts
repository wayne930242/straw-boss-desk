export const en = {
	app: {
		name: "Straw Boss Desk",
	},
	welcome: {
		title: "Welcome to Straw Boss Desk",
		lead: "Straw Boss Desk gets this computer ready and opens your workspace.",
		next: "The setup steps arrive in a later update. For now this window only checks that the app starts.",
		status: "Ready",
		devBuild: "Development build",
		languageLabel: "Language",
	},
	language: {
		en: "English",
		zhTW: "繁體中文",
	},
	// The failure screen of a start or a stop (spec: Runtime supervisor, Start; the kit's exit codes 2 to 27 as typed failures). One sentence per kind; the tool's own line is
	// shown under "Details".
	start: {
		title: "Straw Boss could not start",
		stopTitle: "Straw Boss stopped, but some programs are still running",
		retry: "Try again",
		repair: "Repair",
		details: "Details",
		stillRunning: "Still running from this app's folder:",
		failure: {
			"tool-missing": "Setup has not finished on this computer. Run Repair to finish it.",
			"foreign-stack": "Another Herdr server answers on this app's socket and will not stop. Close it, then try again.",
			"herdr-silent": "The Herdr server did not answer. Try again; if it keeps happening, collect diagnostics.",
			"engine-locked": "Another setup step is running, or a previous one stopped without letting go. Run Repair to clear it.",
			"package-unsafe": "A team package could not be taken out cleanly and may still be active. Run Repair to reinstall it before starting.",
			"work-folder": "The work folder could not be created. Check that you can write to it.",
			lock: "Another start was in progress for too long. Try again.",
			start: "The Straw Boss service started but did not answer in time. Try again.",
			hello: "The Straw Boss service did not answer the start request. Try again.",
			exit: "The old Straw Boss service did not leave in time. Try again.",
			herdr: "Herdr is not answering, or it serves another folder. Try again.",
			version: "The running Straw Boss service is newer than this app's version and could not be replaced.",
			server: "The Straw Boss service refused to start. The details say why.",
			gui: "The page of the Straw Boss service did not start. Try again.",
			other: "Starting failed for a reason this app does not know. The details show what the tool said.",
			"cannot-run": "The Straw Boss service cannot run on this computer. The details say why.",
			loader: "A part of Straw Boss is missing. Run Repair to reinstall it.",
			intercom: "A part of Straw Boss is too old. Run Repair to reinstall it.",
			acl: "The Straw Boss service's folder cannot be protected, or belongs to another account. The details say what to do.",
			usage: "The app called the Straw Boss service wrongly. This is a bug; collect diagnostics.",
			"no-url": "The Straw Boss service gave no address for the page. Try again.",
			slot: "The Straw Boss service runs in another folder than this app's. Collect diagnostics.",
			"base-busy": "Another start is making the home base. Try again in a moment.",
			base: "The home base could not be made. Check the work folder.",
			integration: "Herdr's pi integration could not be installed.",
			"no-base": "The Straw Boss service did not make the home base.",
			tower: "The tower of the home base did not start. Try again.",
		},
	},
} as const;

type Widen<T> = T extends string ? string : { [K in keyof T]: Widen<T[K]> };
/** The shape every locale must have; `zh-TW.ts` is checked against it at build time and by the parity test at run time. */
export type Messages = Widen<typeof en>;
