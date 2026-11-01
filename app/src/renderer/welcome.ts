import type { Locale } from "../shared/locale.ts";
import { catalogs, t } from "./i18n/index.ts";

const shell = window.sbdShell;
let locale: Locale = shell?.locale ?? "en";

function apply(): void {
	document.documentElement.lang = locale;
	for (const el of document.querySelectorAll<HTMLElement>("[data-i18n]")) {
		el.textContent = t(locale, el.dataset.i18n ?? "");
	}
	document.title = catalogs[locale].app.name;
	for (const button of document.querySelectorAll<HTMLButtonElement>("button[data-locale]")) {
		button.setAttribute("aria-pressed", String(button.dataset.locale === locale));
	}
	const badge = document.getElementById("dev-badge");
	if (badge) badge.hidden = shell?.build !== "dev";
}

for (const button of document.querySelectorAll<HTMLButtonElement>("button[data-locale]")) {
	button.addEventListener("click", () => {
		locale = button.dataset.locale === "zh-TW" ? "zh-TW" : "en";
		apply();
	});
}

apply();
