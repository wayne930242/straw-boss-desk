import { listOf } from "../../shared/locale.ts";
import { h } from "../dom.ts";
import type { Ctx } from "./common.ts";
import { laterLabel } from "./later.ts";

/** Step 11: the GUI view takes the window. The sign-ins put off are named once more. */
export function done(ctx: Ctx): HTMLElement {
	const later = ctx.view.later;
	return h(
		"div",
		{ class: "step", "data-step": "done" },
		h("h1", {}, ctx.tr("done.title")),
		h("p", { class: "lead" }, ctx.tr("done.lead")),
		later.length === 0 ? null : h("p", { class: "note", id: "done-pending" }, ctx.tr("done.pending", { items: listOf(ctx.locale, later.map((l) => laterLabel(ctx.tr, l))) })),
		h("div", { class: "actions" }, h("button", { type: "button", id: "finish", class: "primary", onclick: () => ctx.act({ type: "finish" }) }, ctx.tr("done.open"))),
	);
}

/** The short wait of a later launch, until the GUI loads. */
export function launching(ctx: Ctx): HTMLElement {
	return h("div", { class: "step", "data-step": "launching" }, h("h1", {}, ctx.tr("welcome.launching")), h("p", { class: "status" }, h("span", { class: "spinner", "aria-hidden": "true" })));
}
