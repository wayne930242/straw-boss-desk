import type { Locale } from "../../shared/locale.ts";
import type { SettingsAction, SettingsView } from "../../shared/wizard.ts";
import { h } from "../dom.ts";
import { format, t } from "../i18n/index.ts";

/** What a settings section needs to draw itself and to ask for something. Tasks 10 to 14 each fill their own section file and use only this. */
export interface SettingsCtx {
	view: SettingsView;
	locale: Locale;
	tr(key: string, vars?: Readonly<Record<string, string | number>>): string;
	act(action: SettingsAction): void;
}

export const makeSettingsCtx = (view: SettingsView, locale: Locale, act: (action: SettingsAction) => void): SettingsCtx => ({
	view,
	locale,
	tr: (key, vars) => format(t(locale, key), vars),
	act,
});

/** A section's heading, its one-line lead, and the body the section fills. */
export const sectionBox = (ctx: SettingsCtx, name: string, ...body: Array<Node | string | null>): HTMLElement =>
	h("div", { class: "section", "data-section": name }, h("h1", {}, ctx.tr(`settings.${name}.title`)), h("p", { class: "lead" }, ctx.tr(`settings.${name}.lead`)), ...body);

/** The placeholder line of a section a later task fills. */
export const soon = (ctx: SettingsCtx): HTMLElement => h("p", { class: "note soon" }, ctx.tr("settings.soon"));
