import { h } from "../dom.ts";
import { forgePanel } from "../accounts/forge-panel.ts";
import type { Ctx } from "./common.ts";

/**
 * Step 8: one screen per code host (spec: First run, step 8; The code-host screens). The store probe and the existing-sign-in check run when the step opens; GitHub then shows its device code and
 * GitLab its masked token field. **Later** is always a choice (it ends a code that waits); **Next** appears once the sign-in passed its verdict.
 */
export function hosts(ctx: Ctx): HTMLElement {
	const { forges, index, current } = ctx.view.hosts;
	const forge = forges[index];
	const done = current?.flow.phase === "done";
	return h(
		"div",
		{ class: "step", "data-step": "hosts" },
		h("h1", {}, ctx.tr("hosts.title")),
		h("p", { class: "lead" }, ctx.tr("hosts.lead", { host: forge?.host ?? "" })),
		current === null ? null : forgePanel(ctx, current),
		h(
			"div",
			{ class: "actions" },
			done
				? h("button", { type: "button", id: "hosts-next", class: "primary", onclick: () => ctx.act({ type: "hosts-next" }) }, ctx.tr("hosts.next"))
				: h("button", { type: "button", id: "later", onclick: () => ctx.act({ type: "later" }) }, ctx.tr("hosts.later")),
		),
		done ? null : h("p", { class: "note" }, ctx.tr("hosts.laterNote")),
	);
}
