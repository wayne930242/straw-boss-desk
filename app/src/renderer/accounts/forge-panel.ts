import type { EntryName, ForgeAction, ForgeView } from "../../shared/accounts.ts";
import { listOf, type Locale } from "../../shared/locale.ts";
import { h } from "../dom.ts";

// The sign-in panel of one code host (spec: The code-host screens), drawn the same way in the wizard's step 8 and in settings' Accounts. Main owns the flow and sends where it stands; this
// file words it from the catalog and sends back typed requests. The only value that leaves the page is the GitLab token, in `forge-token`, from a masked field that is cleared the moment it is
// sent; nothing here keeps it, stores it, or writes it anywhere else.

export interface PanelCtx {
	locale: Locale;
	tr(key: string, vars?: Readonly<Record<string, string | number>>): string;
	act(action: ForgeAction): void;
}

const toolOf = (ctx: PanelCtx, kind: ForgeView["kind"]): string => ctx.tr(`forge.tool.${kind}`);

/** An entry as the Details list names it: the store's name, and the account when it has one. */
const entryLine = (ctx: PanelCtx, e: EntryName): string => (e.account === "" ? ctx.tr("forge.entryNoAccount", { name: e.name }) : ctx.tr("forge.entry", { name: e.name, account: e.account }));

const spinner = (ctx: PanelCtx, key: string): HTMLElement => h("p", { class: "status", id: "forge-status" }, h("span", { class: "spinner", "aria-hidden": "true" }), ctx.tr(key));

const details = (ctx: PanelCtx, ...body: Array<string | HTMLElement | null>): HTMLElement =>
	h("details", { class: "forge-details", id: "forge-details" }, h("summary", {}, ctx.tr("forge.details")), ...body);

const tryAgain = (ctx: PanelCtx, view: ForgeView, primary = false): HTMLElement =>
	h("button", { type: "button", id: "forge-retry", class: primary ? "primary" : "", onclick: () => ctx.act({ type: "forge-begin", kind: view.kind, host: view.host }) }, ctx.tr("forge.tryAgain"));

const refusal = (...children: Array<HTMLElement | null>): HTMLElement => h("div", { class: "refusal", id: "forge-refusal", role: "alert" }, ...children);

/** The masked token field: no reveal toggle, no autofill, no spell checking, outside any form. Its value is read once, sent, and cleared. */
function tokenField(ctx: PanelCtx, view: ForgeView): HTMLElement {
	const input = h("input", {
		type: "password",
		id: "forge-token",
		autocomplete: "off",
		autocapitalize: "off",
		spellcheck: "false",
		"data-lpignore": "true",
		"aria-label": ctx.tr("forge.gitlab.tokenLabel"),
	});
	const send = (): void => {
		const token = input.value.trim();
		input.value = "";
		if (token !== "") ctx.act({ type: "forge-token", host: view.host, token });
	};
	input.addEventListener("keydown", (event) => {
		if (event.key === "Enter") {
			event.preventDefault();
			send();
		}
	});
	return h(
		"div",
		{ class: "forge-token" },
		h("label", { class: "field-label", for: "forge-token" }, ctx.tr("forge.gitlab.tokenLabel")),
		input,
		h("div", { class: "actions" }, h("button", { type: "button", id: "forge-sign-in", class: "primary", onclick: send }, ctx.tr("forge.gitlab.signIn"))),
	);
}

/** The panel for the forge's flow. `idle` draws as the checks running: a step starts them at once. */
export function forgePanel(ctx: PanelCtx, view: ForgeView): HTMLElement {
	const { flow, host } = view;
	const tool = toolOf(ctx, view.kind);
	const body: Array<HTMLElement | null> = [];
	switch (flow.phase) {
		case "idle":
		case "checking":
			body.push(spinner(ctx, "forge.checking"));
			break;
		case "store-unavailable":
			body.push(refusal(h("p", {}, ctx.tr("forge.storeUnavailable")), details(ctx, h("pre", {}, flow.detail))), h("div", { class: "actions" }, tryAgain(ctx, view)));
			break;
		case "foreign": {
			// The app's own entry that something else wrote over says so; any other entry is another program's sign-in.
			const changed = flow.changed.length > 0;
			body.push(
				refusal(
					h("p", { id: "forge-foreign" }, ctx.tr(changed ? "forge.changed" : "forge.foreign", { host, tool })),
					details(ctx, h("ul", { class: "forge-entries" }, ...flow.entries.map((e) => h("li", {}, entryLine(ctx, e)))), h("p", { class: "note" }, ctx.tr("forge.removeByHand"))),
				),
				h("div", { class: "actions" }, tryAgain(ctx, view)),
			);
			break;
		}
		case "ready":
			if (view.kind === "github") {
				body.push(
					h("p", { class: "note" }, ctx.tr("forge.github.lead", { host })),
					h("div", { class: "actions" }, h("button", { type: "button", id: "forge-sign-in", class: "primary", onclick: () => ctx.act({ type: "forge-start", kind: "github", host }) }, ctx.tr("forge.github.signIn"))),
				);
			} else {
				body.push(
					h("p", { class: "note" }, ctx.tr("forge.gitlab.lead", { host })),
					h("ol", { class: "forge-steps" }, h("li", {}, ctx.tr("forge.gitlab.step1")), h("li", {}, ctx.tr("forge.gitlab.step2"))),
					h("div", { class: "actions" }, h("button", { type: "button", id: "forge-open", onclick: () => ctx.act({ type: "forge-open", kind: "gitlab", host }) }, ctx.tr("forge.gitlab.open"))),
					tokenField(ctx, view),
				);
			}
			break;
		case "waiting-code":
			body.push(spinner(ctx, "forge.github.waiting"), h("div", { class: "actions" }, h("button", { type: "button", id: "forge-cancel", onclick: () => ctx.act({ type: "forge-cancel", host }) }, ctx.tr("forge.cancel"))));
			break;
		case "code":
			body.push(
				h("p", { class: "note" }, ctx.tr("forge.github.codeHelp")),
				h("p", { class: "device-code mono", id: "device-code", "aria-label": ctx.tr("forge.github.codeLabel") }, flow.code),
				h(
					"div",
					{ class: "actions" },
					h("button", { type: "button", id: "forge-copy", onclick: () => ctx.act({ type: "forge-copy-code", host }) }, ctx.tr("forge.github.copy")),
					h("button", { type: "button", id: "forge-open", class: "primary", onclick: () => ctx.act({ type: "forge-open", kind: "github", host }) }, ctx.tr("forge.github.open")),
					h("button", { type: "button", id: "forge-cancel", onclick: () => ctx.act({ type: "forge-cancel", host }) }, ctx.tr("forge.cancel")),
				),
				spinner(ctx, "forge.github.approving"),
			);
			break;
		case "working":
			body.push(spinner(ctx, "forge.working"));
			break;
		case "plain-text":
			body.push(refusal(h("p", { id: "forge-plain" }, ctx.tr("forge.storeUnavailable")), h("p", { class: "note" }, ctx.tr("forge.plainRemoved", { host })), details(ctx, h("pre", {}, flow.detail))), h("div", { class: "actions" }, tryAgain(ctx, view)));
			break;
		case "unverified":
			body.push(h("div", { class: "problem", id: "forge-unverified", role: "alert" }, ctx.tr("forge.unverified", { host })), details(ctx, h("pre", {}, flow.detail)), h("div", { class: "actions" }, tryAgain(ctx, view)));
			break;
		case "failed":
			body.push(h("div", { class: "problem", id: "forge-failed", role: "alert" }, ctx.tr("forge.failed", { host, tool })), details(ctx, h("pre", {}, flow.detail)), h("div", { class: "actions" }, tryAgain(ctx, view)));
			break;
		case "timeout":
			body.push(h("div", { class: "problem", id: "forge-timeout", role: "alert" }, ctx.tr("forge.timeout")), h("div", { class: "actions" }, tryAgain(ctx, view, true)));
			break;
		case "done":
			body.push(h("p", { class: "status", id: "forge-done" }, h("span", { class: "badge badge-done" }, ctx.tr("settings.accounts.signedIn")), ` ${ctx.tr("forge.done", { host })}`));
			break;
		case "signed-out":
			body.push(h("p", { class: "status", id: "forge-signed-out" }, ctx.tr("forge.signedOut", { host })));
			break;
		case "left-alone": {
			const names = listOf(ctx.locale, [...flow.foreign, ...flow.left].map((e) => entryLine(ctx, e)));
			body.push(h("div", { class: "finding", id: "forge-left-alone", role: "status" }, h("p", {}, ctx.tr("forge.leftAlone", { host, names }))));
			break;
		}
	}
	return h("div", { class: "forge-panel", "data-forge": host, "data-phase": flow.phase }, ...body);
}
