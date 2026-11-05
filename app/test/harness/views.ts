import type { SettingsView, WizardView } from "../../src/shared/wizard.ts";

// Whole views for the page tests and the e2e gallery, with only the fields a test names changed. Test code; the app builds the real ones in `main/wizard/controller.ts` and `main/index.ts`.

export const wizardView = (over: Partial<WizardView> = {}): WizardView => ({
	step: "projects",
	steps: ["welcome", "recipe", "trust", "folder", "install", "start", "claude", "hosts", "linear", "projects", "done"],
	locale: "en",
	root: "/r",
	dev: true,
	welcome: { wslBash: null },
	recipe: { choice: { kind: "none" }, refused: [], fileName: null },
	trust: null,
	folder: { path: "/h/StrawBoss", defaultPath: "/h/StrawBoss", problem: null },
	install: { status: "done", stages: [], current: null, failures: [], tail: [], crashed: null },
	start: { status: "idle", failure: null },
	hosts: { forges: [], index: 0, current: null },
	claude: { state: "unknown", storage: "keychain", flow: { phase: "idle" } },
	linear: { state: "not-saved", flow: { phase: "idle" }, restart: { phase: "none" }, encryption: true },
	linearOffered: false,
	projects: { rows: [], running: false, held: false },
	later: [],
	...over,
});

export const settingsView = (over: Partial<SettingsView> = {}): SettingsView => ({
	locale: "en",
	section: "recipe",
	later: [],
	forges: [],
	claude: { phase: "idle" } as unknown as SettingsView["claude"],
	linear: null,
	recipe: null,
	appVersion: "0.0.1",
	dev: true,
	...over,
});
