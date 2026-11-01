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
