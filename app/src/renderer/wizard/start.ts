import { primaryAction, showsRepair } from "../../shared/failure-action.ts";
import { catalogs } from "../i18n/index.ts";
import { h } from "../dom.ts";
import type { Ctx } from "./common.ts";

/** Step 6: the supervisor's start. A failure shows its sentence here, with **Try again** and, when it offers one, **Repair**. */
export function start(ctx: Ctx): HTMLElement {
	const s = ctx.view.start;
	const sentences = catalogs[ctx.locale].start.failure as Record<string, string>;
	const failure = s.failure;
	const text = failure === null ? "" : (sentences[failure.kind] ?? sentences.other ?? "").replaceAll("{pid}", String(failure.pid ?? ""));
	return h(
		"div",
		{ class: "step", "data-step": "start", "data-status": s.status },
		h("h1", {}, ctx.tr("startStep.title")),
		h("p", { class: "lead" }, ctx.tr("startStep.lead")),
		s.status === "starting" ? h("p", { class: "status" }, h("span", { class: "spinner", "aria-hidden": "true" }), ctx.tr("banner.starting")) : null,
		failure === null
			? null
			: h(
					"div",
					{ class: "refusal" },
					h("p", { class: "problem", id: "start-failure", "data-kind": failure.kind }, text),
					h(
						"div",
						{ class: "actions" },
						h("button", { type: "button", id: "start-retry", class: primaryAction(failure) === "retry" ? "primary" : null, onclick: () => ctx.act({ type: "start-retry" }) }, ctx.tr("startStep.retry")),
						showsRepair(failure) ? h("button", { type: "button", id: "start-repair", class: primaryAction(failure) === "repair" ? "primary" : null, onclick: () => ctx.act({ type: "repair" }) }, ctx.tr("startStep.repair")) : null,
					),
					failure.reason === "" ? null : h("details", {}, h("summary", { id: "start-summary" }, ctx.tr("start.details")), h("pre", {}, failure.reason)),
				),
	);
}
