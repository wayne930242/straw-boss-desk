import type { MenuItemConstructorOptions } from "electron";
import { SETTINGS_SECTIONS, type SettingsSection } from "../shared/wizard.ts";
import type { Locale } from "../shared/locale.ts";
import { catalogs } from "../renderer/i18n/index.ts";

// The application menu (spec: Settings: reached from the app menu). Electron's own roles carry the OS-language labels; the Settings menu and its six sections are ours, worded from the catalog
// in the interface language. Settings are reachable once the wizard is done: before that, the wizard is the only place to be.

export interface MenuDeps {
	locale: Locale;
	platform: NodeJS.Platform;
	/** The wizard is over: the Settings entries work. */
	settingsEnabled: boolean;
	openSettings(section: SettingsSection): void;
}

/** The label of a settings entry in `locale`. */
export const settingsLabel = (locale: Locale, section: SettingsSection): string => catalogs[locale].menu[section];

export function menuTemplate(deps: MenuDeps): MenuItemConstructorOptions[] {
	const m = catalogs[deps.locale].menu;
	const sections: MenuItemConstructorOptions[] = SETTINGS_SECTIONS.map((section) => ({
		id: `settings-${section}`,
		label: m[section],
		enabled: deps.settingsEnabled,
		click: () => deps.openSettings(section),
		...(section === "accounts" ? { accelerator: "CmdOrCtrl+," } : {}),
	}));
	return [
		...(deps.platform === "darwin" ? [{ role: "appMenu" as const }] : []),
		{ role: "fileMenu" },
		{ role: "editMenu" },
		{ role: "viewMenu" },
		{ id: "settings", label: m.settings, submenu: sections },
		{ role: "windowMenu" },
	];
}
