import { h } from "../dom.ts";
import { projectList } from "../projects/rows.ts";
import type { Ctx } from "./common.ts";

/**
 * Step 10: the recipe's repositories (spec: First run). One card per repository, each cloned or brought up to date, given its starting branch, checked for links (Windows) and opened as a base. **Next**
 * appears once every row has ended or the rest waits on a trust question the PM answers in the GUI; a failed row offers **Try again** and the step can still go on.
 */
export function projects(ctx: Ctx): HTMLElement {
	const view = ctx.view.projects;
	const failed = view.rows.some((r) => r.phase === "failed");
	const settled = !view.running && view.rows.length > 0 && (view.held || !view.rows.some((r) => r.phase === "waiting"));
	const sentence = view.running ? ctx.tr("projects.running") : view.held ? ctx.tr("projects.held") : settled ? ctx.tr(failed ? "projects.someFailed" : "projects.allDone") : ctx.tr("projects.running");
	return h(
		"div",
		{ class: "step", "data-step": "projects" },
		h("h1", {}, ctx.tr("projects.title")),
		h("p", { class: "lead" }, ctx.tr("projects.lead")),
		h("p", { class: view.running || !settled ? "status" : "note", id: "projects-status" }, view.running || !settled ? h("span", { class: "spinner", "aria-hidden": "true" }) : null, sentence),
		projectList({ locale: ctx.locale, tr: ctx.tr, retry: (folder) => ctx.act({ type: "project-retry", folder }) }, view, "project-cards"),
		h("div", { class: "actions" }, h("button", { type: "button", id: "projects-next", class: "primary", disabled: !settled, onclick: () => ctx.act({ type: "projects-next" }) }, ctx.tr("projects.next"))),
	);
}
