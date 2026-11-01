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
} as const;

type Widen<T> = T extends string ? string : { [K in keyof T]: Widen<T[K]> };
/** The shape every locale must have; `zh-TW.ts` is checked against it at build time and by the parity test at run time. */
export type Messages = Widen<typeof en>;
