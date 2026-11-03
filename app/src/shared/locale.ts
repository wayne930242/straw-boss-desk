export const LOCALES = ["en", "zh-TW"] as const;
export type Locale = (typeof LOCALES)[number];

/**
 * The first language of the list that the app has strings for, else English.
 * Traditional Chinese covers `zh`, `zh-TW`, `zh-HK`, `zh-MO` and `zh-Hant`; Simplified Chinese (`zh-CN`, `zh-SG`, `zh-Hans`) has no strings,
 * so it falls through to the next language of the list instead of showing Traditional characters to a Simplified reader.
 */
export function pickLocale(languages: readonly string[]): Locale {
	for (const raw of languages) {
		const tag = raw.trim().replace(/_/g, "-").toLowerCase();
		if (tag === "en" || tag.startsWith("en-")) return "en";
		if (tag === "zh" || tag.startsWith("zh-")) {
			const parts = tag.split("-").slice(1);
			if (parts.includes("hans") || parts.includes("cn") || parts.includes("sg")) continue;
			return "zh-TW";
		}
	}
	return "en";
}

/**
 * The language main holds now. A page's preload argument is the language when the window opened, so a page loaded later (the runtime page after the PM changed the language in the
 * wizard) asks main instead; an answer that does not come leaves the argument (T9-F003).
 */
export async function currentLocale(shell: { readonly locale: Locale; getLocale(): Promise<Locale> }): Promise<Locale> {
	try {
		const asked = await shell.getLocale();
		return (LOCALES as readonly string[]).includes(asked) ? asked : shell.locale;
	} catch {
		return shell.locale;
	}
}

/** Items joined the way the language joins a list: "A, B, and C" in English, "A、B和C" in Traditional Chinese. */
export const listOf = (locale: Locale, items: readonly string[]): string => new Intl.ListFormat(locale, { type: "conjunction", style: "long" }).format(items);
