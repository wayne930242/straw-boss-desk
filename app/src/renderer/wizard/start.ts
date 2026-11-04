import { primaryAction, showsRepair } from "../../shared/failure-action.ts";
import { catalogs } from "../i18n/index.ts";
import { h } from "../dom.ts";
import type { Ctx } from "./common.ts";

/**
 * The failed start's sentence with **Try again** and, when it offers one, **Repair** (null when the start did not fail). Step 6 shows it, and so does step 9: the start runs while the PM
 * is already on the Linear step (a relaunch resumes there), and a failure drawn only on step 6 would go unseen.
 */
export function startFailureBlock(ctx: Ctx): HTMLElement | null {
	const failure = ctx.view.start.failure;
	if (failure === null) return null;
	const sentences = catalogs[ctx.locale].start.failure as Record<string, string>;
	const text = (sentences[failure.kind] ?? sentences.other ?? "").replaceAll("{pid}", String(failure.pid ?? ""));
	return h(
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
	);
}

/** Step 6: the supervisor's start. A failure shows its sentence here, with **Try again** and, when it offers one, **Repair**. */
export function start(ctx: Ctx): HTMLElement {
	const s = ctx.view.start;
	return h(
		"div",
		{ class: "step", "data-step": "start", "data-status": s.status },
		h("h1", {}, ctx.tr("startStep.title")),
		h("p", { class: "lead" }, ctx.tr("startStep.lead")),
		s.status === "starting" ? h("p", { class: "status" }, h("span", { class: "spinner", "aria-hidden": "true" }), ctx.tr("banner.starting")) : null,
		startFailureBlock(ctx),
	);
}
