import { linearPanel } from "../accounts/linear-panel.ts";
import { h } from "../dom.ts";
import type { Ctx } from "./common.ts";
import { startFailureBlock } from "./start.ts";

/** The phases in which a save, the install of `ttt`, `ttt init` or a restart is under way: **Later** and **Next** wait for them. */
const BUSY = ["saving", "installing", "initializing"];

/**
 * Step 9: Linear (spec: First run), offered when the recipe turns it on or there is no recipe. A link to Linear's API key page, a masked field, then the key is saved encrypted, `ttt` is installed and
 * `ttt init` runs. A saved key is offered **Restart now** or **Later** while the stack runs. **Later** (the step) is always a choice; **Next** appears once a key is saved and nothing is running.
 */
export function linear(ctx: Ctx): HTMLElement {
	const view = ctx.view.linear;
	const busy = BUSY.includes(view.flow.phase) || view.restart.phase === "restarting";
	const offering = view.restart.phase === "offer";
	const done = view.state === "saved" && !busy && !offering && view.flow.phase !== "entering";
	// The restart offer has its own Later; a second one beside it would read as the same choice.
	const last = offering
		? null
		: done
			? h("button", { type: "button", id: "step-next", class: "primary", onclick: () => ctx.act({ type: "step-next" }) }, ctx.tr("linear.next"))
			: h("button", { type: "button", id: "later", disabled: busy, onclick: () => ctx.act({ type: "later" }) }, ctx.tr("linear.later"));
	return h(
		"div",
		{ class: "step", "data-step": "linear" },
		h("h1", {}, ctx.tr("linear.title")),
		h("p", { class: "lead" }, ctx.tr("linear.stepLead")),
		startFailureBlock(ctx),
		linearPanel(ctx, view, { trailing: last === null ? [] : [last] }),
		done || offering ? null : h("p", { class: "note" }, ctx.tr("linear.laterNote")),
	);
}
