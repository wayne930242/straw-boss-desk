import type { Locale } from "../shared/locale.ts";
import type { ShellAction, ShellState } from "../shared/shell-state.ts";
import type { SettingsAction, SettingsView, WizardAction, WizardView } from "../shared/wizard.ts";

/** What `src/preload/shell.cts` exposes to the shell view's pages. */
interface SbdShell {
	/** The language when the page loaded; `onLocale` follows a change. */
	readonly locale: Locale;
	readonly productName: string;
	readonly build: "dev" | "release";
	/** The state main wants the runtime page (`screen.html`) to show now. */
	state(): Promise<ShellState>;
	/** Calls the listener with each new state main sends. */
	onState(listener: (state: ShellState) => void): void;
	/** The runtime page's requests. */
	act(action: ShellAction): void;
	getLocale(): Promise<Locale>;
	onLocale(listener: (locale: Locale) => void): void;
	wizardState(): Promise<WizardView>;
	onWizard(listener: (view: WizardView) => void): void;
	wizardAct(action: WizardAction): Promise<void>;
	settingsState(): Promise<SettingsView>;
	onSettings(listener: (view: SettingsView) => void): void;
	settingsAct(action: SettingsAction): Promise<void>;
}

declare global {
	interface Window {
		readonly sbdShell?: SbdShell;
	}
}

export {};
