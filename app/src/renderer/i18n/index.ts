import type { Locale } from "../../shared/locale.ts";
import { en, type Messages } from "./en.ts";
import { zhTW } from "./zh-TW.ts";

export const catalogs: Record<Locale, Messages> = { en, "zh-TW": zhTW };

/** Looks a dotted key up in a locale's catalog; a missing key is a bug, so it throws instead of showing a blank. */
export function t(locale: Locale, key: string): string {
	let node: unknown = catalogs[locale];
	for (const part of key.split(".")) {
		if (typeof node !== "object" || node === null || !(part in node)) throw new Error(`missing string ${key} in ${locale}`);
		node = (node as Record<string, unknown>)[part];
	}
	if (typeof node !== "string") throw new Error(`string key ${key} in ${locale} is not a string`);
	return node;
}

/** `{name}` placeholders replaced from `vars`; a placeholder with no value stays as written, so a missing value shows instead of vanishing. */
export function format(text: string, vars: Readonly<Record<string, string | number>> = {}): string {
	return text.replace(/\{([A-Za-z]+)\}/g, (whole, name: string) => (name in vars ? String(vars[name]) : whole));
}
