import { h } from "../dom.ts";
import { laterLabel } from "../wizard/later.ts";
import { sectionBox, soon, type SettingsCtx } from "./common.ts";

/** Accounts (task 10 fills the code hosts, task 11 Claude and Linear): for now each sign-in put off shows as a badge. */
export function accounts(ctx: SettingsCtx): HTMLElement {
	return sectionBox(
		ctx,
		"accounts",
		ctx.view.later.length === 0
			? null
			: h("ul", { class: "accounts", id: "accounts-later" }, ...ctx.view.later.map((l) => h("li", { "data-item": l.item }, h("span", {}, laterLabel(ctx.tr, l)), h("span", { class: "badge badge-blocked" }, ctx.tr("settings.accounts.notSignedIn"))))),
		soon(ctx),
	);
}
