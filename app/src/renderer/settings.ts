import type { Locale } from "../shared/locale.ts";
import { SETTINGS_SECTIONS, type SettingsSection, type SettingsView } from "../shared/wizard.ts";
import { carryPasswords, clear, h, restorePasswords } from "./dom.ts";
import { catalogs, t } from "./i18n/index.ts";
import { accounts } from "./settings/accounts.ts";
import { computer } from "./settings/computer.ts";
import { diagnostics } from "./settings/diagnostics.ts";
import { guidance } from "./settings/guidance.ts";
import { recipe } from "./settings/recipe.ts";
import { makeSettingsCtx, type SettingsCtx } from "./settings/common.ts";
import { updates } from "./settings/updates.ts";

// The settings page of the shell view (spec: Settings): a list of sections and the open one. Each section is its own file under `settings/`, so a later task fills only its own.
// Reached from the app menu and from the banners; **Back** returns to the GUI.

const shell = window.sbdShell;
let locale: Locale = shell?.locale ?? "en";
let view: SettingsView | null = null;

const SECTIONS: Record<SettingsSection, (ctx: SettingsCtx) => HTMLElement> = { accounts, recipe, guidance, updates, computer, diagnostics };

const nav = document.getElementById("nav");
const body = document.getElementById("body");
if (nav === null || body === null) throw new Error("settings.html has no #nav or #body");

function draw(): void {
	document.documentElement.lang = locale;
	document.title = catalogs[locale].app.name;
	if (view === null) return;
	const ctx = makeSettingsCtx(view, locale, (action) => void shell?.settingsAct(action));
	clear(nav as HTMLElement);
	(nav as HTMLElement).append(
		h("button", { type: "button", id: "settings-back", class: "back", onclick: () => ctx.act({ type: "close" }) }, t(locale, "settings.back")),
		h("h2", {}, t(locale, "settings.title")),
		...SETTINGS_SECTIONS.map((s) => h("button", { type: "button", class: "nav-item", "data-section": s, "aria-current": String(s === view?.section), onclick: () => ctx.act({ type: "section", section: s }) }, t(locale, `menu.${s}`))),
	);
	const typed = carryPasswords(body as HTMLElement);
	clear(body as HTMLElement);
	(body as HTMLElement).append(SECTIONS[view.section](ctx));
	restorePasswords(body as HTMLElement, typed);
}

if (shell) {
	shell.onLocale((next) => {
		locale = next;
		draw();
	});
	shell.onSettings((next) => {
		view = next;
		locale = next.locale;
		draw();
	});
	void shell.settingsState().then((first) => {
		view = first;
		locale = first.locale;
		draw();
	});
}
draw();
