import type { Locale } from "../../shared/locale.ts";
import type { WizardAction, WizardView } from "../../shared/wizard.ts";
import { catalogs, format, t } from "../i18n/index.ts";

/** What a step needs to draw itself and to ask for something. */
export interface Ctx {
	view: WizardView;
	locale: Locale;
	/** The catalog's string for `key` with `{name}` placeholders filled. */
	tr(key: string, vars?: Readonly<Record<string, string | number>>): string;
	act(action: WizardAction): void;
}

export const makeCtx = (view: WizardView, locale: Locale, act: (action: WizardAction) => void): Ctx => ({
	view,
	locale,
	tr: (key, vars) => format(t(locale, key), vars),
	act,
});

/** The catalog's string for a dotted key when the catalog has it, else `fallbackKey`'s. */
export function trOr(ctx: Ctx, key: string, fallbackKey: string, vars?: Readonly<Record<string, string | number>>): string {
	let node: unknown = catalogs[ctx.locale];
	for (const part of key.split(".")) {
		if (typeof node !== "object" || node === null || !(part in node)) return ctx.tr(fallbackKey, vars);
		node = (node as Record<string, unknown>)[part];
	}
	return typeof node === "string" ? format(node, vars) : ctx.tr(fallbackKey, vars);
}
