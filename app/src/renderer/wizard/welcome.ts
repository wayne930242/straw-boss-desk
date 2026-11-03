import { h } from "../dom.ts";
import type { Ctx } from "./common.ts";

let detailsOpen = false;

/** Step 1: what will be installed and where, and what the preflight found (the WSL sentence on Windows). */
export function welcome(ctx: Ctx): HTMLElement {
	const { view } = ctx;
	const wsl = view.welcome.wslBash;
	return h(
		"div",
		{ class: "step", "data-step": "welcome" },
		h("h1", {}, ctx.tr("welcome.title")),
		h("p", { class: "lead" }, ctx.tr("welcome.lead")),
		h("p", { class: "note" }, ctx.tr("welcome.where", { root: view.root })),
		h("p", { class: "note" }, ctx.tr("welcome.time")),
		wsl === null
			? null
			: h(
					"div",
					{ class: "finding", id: "finding-wsl", role: "status" },
					h("p", {}, ctx.tr("welcome.wsl")),
					h(
						"details",
						{ ...(detailsOpen ? { open: true } : {}), ontoggle: (e) => (detailsOpen = (e.target as HTMLDetailsElement).open) },
						h("summary", {}, ctx.tr("welcome.wslDetails")),
						h("pre", {}, ctx.tr("welcome.wslPath", { path: wsl })),
					),
				),
		h(
			"div",
			{ class: "actions" },
			h("button", { type: "button", id: "welcome-next", class: "primary", onclick: () => ctx.act({ type: "welcome-next" }) }, ctx.tr("welcome.next")),
			h("button", { type: "button", id: "welcome-rescan", onclick: () => ctx.act({ type: "rescan" }) }, ctx.tr("welcome.rescan")),
		),
	);
}
