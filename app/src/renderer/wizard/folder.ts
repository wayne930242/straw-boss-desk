import { h } from "../dom.ts";
import type { Ctx } from "./common.ts";
import { trOr } from "./common.ts";

/** Step 4: the work folder, `~/StrawBoss` by default, changeable here with the native dialog (inside the home). */
export function folder(ctx: Ctx): HTMLElement {
	const f = ctx.view.folder;
	return h(
		"div",
		{ class: "step", "data-step": "folder" },
		h("h1", {}, ctx.tr("folder.title")),
		h("p", { class: "lead" }, ctx.tr("folder.lead")),
		h("p", { class: "path", id: "folder-path" }, f.path),
		f.problem === null ? null : h("p", { class: "problem", id: "folder-problem", role: "alert" }, trOr(ctx, `folder.problems.${f.problem}`, "folder.problems.outside-home")),
		h(
			"div",
			{ class: "actions" },
			h("button", { type: "button", id: "folder-next", class: "primary", onclick: () => ctx.act({ type: "folder-next" }) }, ctx.tr("folder.next")),
			h("button", { type: "button", id: "folder-change", onclick: () => ctx.act({ type: "folder-change" }) }, ctx.tr("folder.change")),
			f.path === f.defaultPath ? null : h("button", { type: "button", id: "folder-default", onclick: () => ctx.act({ type: "folder-default" }) }, ctx.tr("folder.useDefault")),
		),
	);
}
