import { claudePanel } from "../accounts/claude-panel.ts";
import { h } from "../dom.ts";
import type { Ctx } from "./common.ts";

/** The phases in which a sign-in is under way: **Next** waits for them to end, and **Later** is disabled while the CLI's status is being read. */
const BUSY = ["checking", "starting", "browser", "working"];

/**
 * Step 7: Claude (spec: First run). **Sign in** starts `claude auth login`; the screen says a browser window opened, shows the address to copy if it did not, and a masked field for a code when the
 * CLI asks for one. **Later** is always a choice (it ends a login that waits); **Next** appears once the CLI's status says signed in.
 */
export function claude(ctx: Ctx): HTMLElement {
	const view = ctx.view.claude;
	const busy = BUSY.includes(view.flow.phase);
	const done = view.state === "signed-in" && !busy;
	// A status being read after a login that ended is not interrupted: Later waits for it, as it does for a code host.
	const finishing = view.flow.phase === "working";
	const last = done
		? h("button", { type: "button", id: "step-next", class: "primary", onclick: () => ctx.act({ type: "step-next" }) }, ctx.tr("claude.next"))
		: h("button", { type: "button", id: "later", disabled: finishing, onclick: () => ctx.act({ type: "later" }) }, ctx.tr("claude.later"));
	return h(
		"div",
		{ class: "step", "data-step": "claude" },
		h("h1", {}, ctx.tr("claude.title")),
		h("p", { class: "lead" }, ctx.tr("claude.stepLead")),
		claudePanel(ctx, view, { trailing: [last] }),
		done ? null : h("p", { class: "note" }, ctx.tr("claude.laterNote")),
	);
}
