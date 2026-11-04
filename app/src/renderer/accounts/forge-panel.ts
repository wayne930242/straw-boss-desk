import type { EntryName, ForgeAction, ForgeView } from "../../shared/accounts.ts";
import type { Locale } from "../../shared/locale.ts";
import { h, type Attrs } from "../dom.ts";

// The sign-in panel of one code host (spec: The code-host screens), drawn the same way in the wizard's step 8 and in settings' Accounts. Main owns the flow and sends where it stands; this
// file words it from the catalog and sends back typed requests. The only value that leaves the page is the GitLab token, in `forge-token`, from a masked field that is cleared the moment it is
// sent; nothing here keeps it, stores it, or writes it anywhere else.

export interface PanelCtx {
	locale: Locale;
	tr(key: string, vars?: Readonly<Record<string, string | number>>): string;
	act(action: ForgeAction): void;
}

const toolOf = (ctx: PanelCtx, kind: ForgeView["kind"]): string => ctx.tr(`forge.tool.${kind}`);

/**
 * A host as a piece of an element id: every character outside a-z and 0-9 becomes `_` and its code, so two different host names never share one (`a.b` and `a-b` differ). The wizard shows one
 * host at a time and settings shows every host at once, so an id that names only its role would repeat (T10R-F003).
 */
export const hostId = (host: string): string => host.toLowerCase().replace(/[^a-z0-9]/g, (c) => `_${c.charCodeAt(0).toString(16)}`);

/** The id of a part of the host's panel: unique among the panels of one page. Tests and the page find a part by `data-role`, which a panel repeats for every host. */
const idOf = (role: string, host: string): string => `forge-${role}-${hostId(host)}`;

/** An element of the panel: its role, and its id scoped to the host. */
const part = (role: string, host: string, attrs: Attrs = {}): Attrs => ({ ...attrs, id: idOf(role, host), "data-role": role });

/** An entry as the Details list names it: the store's name, and the account when it has one. */
const entryLine = (ctx: PanelCtx, e: EntryName): string => (e.account === "" ? ctx.tr("forge.entryNoAccount", { name: e.name }) : ctx.tr("forge.entry", { name: e.name, account: e.account }));

const spinner = (ctx: PanelCtx, view: ForgeView, key: string): HTMLElement => h("p", part("status", view.host, { class: "status" }), h("span", { class: "spinner", "aria-hidden": "true" }), ctx.tr(key));

const details = (ctx: PanelCtx, view: ForgeView, ...body: Array<string | HTMLElement | null>): HTMLElement =>
	h("details", part("details", view.host, { class: "forge-details" }), h("summary", {}, ctx.tr("forge.details")), ...body);

/** The button that starts the checks again; the primary one of every state it appears in, so it comes first in its row. */
const tryAgain = (ctx: PanelCtx, view: ForgeView): HTMLElement =>
	h("button", part("retry", view.host, { type: "button", class: "primary", onclick: () => ctx.act({ type: "forge-begin", kind: view.kind, host: view.host }) }), ctx.tr("forge.tryAgain"));

const refusal = (view: ForgeView, ...children: Array<HTMLElement | null>): HTMLElement => h("div", part("refusal", view.host, { class: "refusal", role: "alert" }), ...children);

const entryList = (ctx: PanelCtx, entries: readonly EntryName[]): HTMLElement => h("ul", { class: "forge-entries" }, ...entries.map((e) => h("li", {}, entryLine(ctx, e))));

/** The masked token field: no reveal toggle, no autofill, no spell checking, outside any form. Its value is read once, sent, and cleared. The button that sends it is the step's, in its row of actions. */
function tokenField(ctx: PanelCtx, view: ForgeView, send: { fn: () => void }): HTMLElement {
	const input = h("input", {
		...part("token", view.host),
		type: "password",
		autocomplete: "off",
		autocapitalize: "off",
		spellcheck: "false",
		"data-lpignore": "true",
		"aria-label": ctx.tr("forge.gitlab.tokenLabel"),
	});
	send.fn = (): void => {
		const token = input.value.trim();
		input.value = "";
		if (token !== "") ctx.act({ type: "forge-token", host: view.host, token });
	};
	input.addEventListener("keydown", (event) => {
		if (event.key === "Enter") {
			event.preventDefault();
			send.fn();
		}
	});
	return h("div", { class: "forge-token" }, h("label", { class: "field-label", for: idOf("token", view.host) }, ctx.tr("forge.gitlab.tokenLabel")), input);
}

export interface PanelOptions {
	/** More buttons for the end of the step's row of actions (the wizard's **Later** or **Next**): one row holds every action of a step, the panel's own first. */
	trailing?: readonly HTMLElement[];
	/** The panel sits in a host's card in settings, which already shows the state: an outcome of **Done** does not repeat it. */
	inCard?: boolean;
}

/** The panel for the forge's flow. `idle` draws as the checks running: a step starts them at once. */
export function forgePanel(ctx: PanelCtx, view: ForgeView, { trailing = [], inCard = false }: PanelOptions = {}): HTMLElement {
	const { flow, host } = view;
	const tool = toolOf(ctx, view.kind);
	const body: Array<HTMLElement | null> = [];
	/** The step's buttons, primary first; the row is drawn once, after the content. */
	const actions: HTMLElement[] = [];
	switch (flow.phase) {
		case "idle":
		case "checking":
			body.push(spinner(ctx, view, "forge.checking"));
			break;
		case "store-unavailable":
			body.push(refusal(view, h("p", {}, ctx.tr("forge.storeUnavailable")), details(ctx, view, h("pre", {}, flow.detail))));
			actions.push(tryAgain(ctx, view));
			break;
		case "foreign": {
			// The app's own entry that something else wrote over says so; any other entry is another program's sign-in.
			const changed = flow.changed.length > 0;
			body.push(
				refusal(
					view,
					h("p", part("foreign", host), ctx.tr(changed ? "forge.changed" : "forge.foreign", { host, tool })),
					details(ctx, view, entryList(ctx, flow.entries), h("p", { class: "note" }, ctx.tr("forge.removeByHand"))),
				),
			);
			actions.push(tryAgain(ctx, view));
			break;
		}
		case "ready":
			if (view.kind === "github") {
				body.push(h("p", { class: "note" }, ctx.tr("forge.github.lead", { host })));
				actions.push(h("button", part("sign-in", host, { type: "button", class: "primary", onclick: () => ctx.act({ type: "forge-start", kind: "github", host }) }), ctx.tr("forge.github.signIn")));
			} else {
				const send = { fn: (): void => undefined };
				body.push(
					h("p", { class: "note" }, ctx.tr("forge.gitlab.lead", { host })),
					h("ol", { class: "forge-steps" }, h("li", {}, ctx.tr("forge.gitlab.step1")), h("li", {}, ctx.tr("forge.gitlab.step2"))),
					tokenField(ctx, view, send),
				);
				actions.push(
					h("button", part("sign-in", host, { type: "button", class: "primary", onclick: () => send.fn() }), ctx.tr("forge.gitlab.signIn")),
					h("button", part("open", host, { type: "button", onclick: () => ctx.act({ type: "forge-open", kind: "gitlab", host }) }), ctx.tr("forge.gitlab.open")),
				);
			}
			break;
		case "waiting-code":
			body.push(spinner(ctx, view, "forge.github.waiting"));
			actions.push(h("button", part("cancel", host, { type: "button", onclick: () => ctx.act({ type: "forge-cancel", host }) }), ctx.tr("forge.cancel")));
			break;
		case "code":
			body.push(
				h("p", { class: "note" }, ctx.tr("forge.github.codeHelp")),
				h("p", part("device-code", host, { class: "device-code mono", "aria-label": ctx.tr("forge.github.codeLabel") }), flow.code),
				spinner(ctx, view, "forge.github.approving"),
			);
			actions.push(
				h("button", part("open", host, { type: "button", class: "primary", onclick: () => ctx.act({ type: "forge-open", kind: "github", host }) }), ctx.tr("forge.github.open")),
				h("button", part("copy", host, { type: "button", onclick: () => ctx.act({ type: "forge-copy-code", host }) }), ctx.tr("forge.github.copy")),
				h("button", part("cancel", host, { type: "button", onclick: () => ctx.act({ type: "forge-cancel", host }) }), ctx.tr("forge.cancel")),
			);
			break;
		case "working":
			body.push(spinner(ctx, view, "forge.working"));
			break;
		case "plain-text":
			body.push(
				refusal(
					view,
					h("p", part("plain", host), ctx.tr("forge.storeUnavailable")),
					// The sentence that no token stays is shown only when the files were read again and are clean; otherwise the screen says one may stay, and Details says where.
					h("p", part("plain-outcome", host, { class: "note", "data-removed": String(flow.removed) }), ctx.tr(flow.removed ? "forge.plainRemoved" : "forge.plainStays", { host })),
					details(ctx, view, h("pre", {}, flow.detail)),
				),
			);
			actions.push(tryAgain(ctx, view));
			break;
		case "unverified":
			body.push(h("div", part("unverified", host, { class: "problem", role: "alert" }), ctx.tr("forge.unverified", { host })), details(ctx, view, h("pre", {}, flow.detail)));
			actions.push(tryAgain(ctx, view));
			break;
		case "failed":
			body.push(h("div", part("failed", host, { class: "problem", role: "alert" }), ctx.tr("forge.failed", { host, tool })), details(ctx, view, h("pre", {}, flow.detail)));
			actions.push(tryAgain(ctx, view));
			break;
		case "timeout":
			body.push(h("div", part("timeout", host, { class: "problem", role: "alert" }), ctx.tr("forge.timeout")));
			actions.push(tryAgain(ctx, view));
			break;
		case "done":
			body.push(h("p", part("done", host, { class: "status" }), inCard ? null : h("span", { class: "badge badge-done" }, ctx.tr("settings.accounts.signedIn")), `${inCard ? "" : " "}${ctx.tr("forge.done", { host })}`));
			break;
		case "signed-out":
			body.push(h("p", part("signed-out", host, { class: "status" }), ctx.tr("forge.signedOut", { host })));
			break;
		case "left-alone":
			// The sentence is plain; the store's own names for what stays are in Details.
			body.push(
				h(
					"div",
					part("left-alone", host, { class: "finding", role: "status" }),
					h("p", {}, ctx.tr("forge.leftAlone", { host })),
					details(ctx, view, entryList(ctx, [...flow.foreign, ...flow.left])),
				),
			);
			break;
	}
	const row = [...actions, ...trailing];
	if (row.length > 0) body.push(h("div", { class: "actions" }, ...row));
	return h("div", { class: "forge-panel", "data-forge": host, "data-phase": flow.phase }, ...body);
}
