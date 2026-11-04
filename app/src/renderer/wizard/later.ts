import type { LaterItem } from "../../shared/wizard.ts";
import { h } from "../dom.ts";
import type { Ctx } from "./common.ts";

/** The words for one sign-in put off. */
export function laterLabel(tr: Ctx["tr"], item: LaterItem): string {
	return "host" in item ? tr(`later.${item.item}`, { host: item.host }) : tr(`later.${item.item}`);
}

function laterStep(ctx: Ctx, step: "claude" | "linear", lead: string): HTMLElement {
	return h(
		"div",
		{ class: "step", "data-step": step },
		h("h1", {}, ctx.tr(`${step}.title`)),
		h("p", { class: "lead" }, lead),
		h("p", { class: "note" }, ctx.tr(`${step}.laterNote`)),
		h("div", { class: "actions" }, h("button", { type: "button", id: "later", class: "primary", onclick: () => ctx.act({ type: "later" }) }, ctx.tr(`${step}.later`))),
	);
}

/** Steps 7 and 9: sign-in placeholders. Every one ends in **Later**; task 11 puts the real sign-in beside it (step 8, the code hosts, is `hosts.ts`). */
export const claude = (ctx: Ctx): HTMLElement => laterStep(ctx, "claude", ctx.tr("claude.lead"));
export const linear = (ctx: Ctx): HTMLElement => laterStep(ctx, "linear", ctx.tr("linear.lead"));
