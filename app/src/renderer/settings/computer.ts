import { h } from "../dom.ts";
import { sectionBox, soon, type SettingsCtx } from "./common.ts";

/** Computer (task 14 fills keep awake and Remove all data): the language switch works now. */
export function computer(ctx: SettingsCtx): HTMLElement {
	return sectionBox(
		ctx,
		"computer",
		h(
			"div",
			{ class: "language", role: "group", "aria-label": ctx.tr("settings.computer.language") },
			h("span", { class: "language-label" }, ctx.tr("settings.computer.language")),
			...(["en", "zh-TW"] as const).map((l) => h("button", { type: "button", class: "language-button", "data-locale": l, "aria-pressed": String(l === ctx.locale), onclick: () => ctx.act({ type: "set-locale", locale: l }) }, ctx.tr(l === "en" ? "language.en" : "language.zhTW"))),
		),
		soon(ctx),
	);
}
