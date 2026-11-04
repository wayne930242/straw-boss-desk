import type { LinearAction, LinearView } from "../../shared/accounts.ts";
import type { Locale } from "../../shared/locale.ts";
import { h, type Attrs } from "../dom.ts";

// The Linear key panel (spec: First run, step 9; Environment), drawn the same way in the wizard and in settings' Accounts. The only value that leaves the page is the key, in `linear-save`, from a
// masked field that is cleared the moment it is sent; nothing here keeps it, stores it, or writes it anywhere else. Main encrypts it and drops it.

export interface LinearPanelCtx {
	locale: Locale;
	tr(key: string, vars?: Readonly<Record<string, string | number>>): string;
	act(action: LinearAction): void;
}

const part = (role: string, attrs: Attrs = {}): Attrs => ({ ...attrs, id: `linear-${role}`, "data-role": role });

const spinner = (ctx: LinearPanelCtx, key: string): HTMLElement => h("p", part("status", { class: "status" }), h("span", { class: "spinner", "aria-hidden": "true" }), ctx.tr(key));

const details = (ctx: LinearPanelCtx, ...lines: string[]): HTMLElement =>
	h("details", part("details", { class: "forge-details" }), h("summary", {}, ctx.tr("linear.details")), h("pre", {}, lines.join("\n")));

const refusal = (...children: Array<HTMLElement | null>): HTMLElement => h("div", part("refusal", { class: "refusal", role: "alert" }), ...children);

/** The masked key field: no reveal toggle, no autofill, no spell checking, outside any form. Its value is read once, sent, and cleared. */
function keyField(ctx: LinearPanelCtx): { field: HTMLElement; send: () => void } {
	const input = h("input", {
		...part("key"),
		type: "password",
		autocomplete: "off",
		autocapitalize: "off",
		spellcheck: "false",
		"data-lpignore": "true",
		"aria-label": ctx.tr("linear.keyLabel"),
	});
	const send = (): void => {
		const key = input.value.trim();
		input.value = "";
		if (key !== "") ctx.act({ type: "linear-save", key });
	};
	input.addEventListener("keydown", (event) => {
		if (event.key === "Enter") {
			event.preventDefault();
			send();
		}
	});
	return { field: h("div", { class: "forge-token" }, h("label", { class: "field-label", for: "linear-key" }, ctx.tr("linear.keyLabel")), input), send };
}

export interface LinearPanelOptions {
	/** More buttons for the end of the step's row of actions (the wizard's **Later** or **Next**), after the panel's own. */
	trailing?: readonly HTMLElement[];
	/** The panel sits in Linear's card in settings, which already shows the state. */
	inCard?: boolean;
}

/** The offer after a save or a removal: Herdr's environment is fixed for its lifetime, so panes see the change after a restart. Its buttons come first in the row. */
function restartBlock(ctx: LinearPanelCtx, view: LinearView, actions: HTMLElement[]): HTMLElement | null {
	const r = view.restart;
	switch (r.phase) {
		case "none":
			return null;
		case "offer":
			actions.push(
				// One primary button to a row: Restart now is it unless a button before it (Try again after a failed setup) already is.
				h("button", part("restart", { type: "button", ...(actions.length === 0 ? { class: "primary" } : {}), onclick: () => ctx.act({ type: "linear-restart" }) }), ctx.tr("linear.restart.now")),
				h("button", part("restart-later", { type: "button", onclick: () => ctx.act({ type: "linear-restart-later" }) }), ctx.tr("linear.restart.later")),
			);
			return h("div", part("restart-offer", { class: "finding", role: "status" }), h("p", {}, ctx.tr(r.change === "saved" ? "linear.restart.savedLead" : "linear.restart.removedLead")));
		case "restarting":
			return spinner(ctx, "linear.restart.restarting");
		case "later":
			return h("p", part("restart-later-note", { class: "note" }), ctx.tr("linear.restart.laterNote"));
		case "restarted":
			return h("p", part("restarted", { class: "status" }), ctx.tr("linear.restart.restarted"));
		case "failed":
			return h("div", {}, h("div", part("restart-failed", { class: "problem", role: "alert" }), ctx.tr("linear.restart.failed")), details(ctx, r.detail));
	}
}

/** The panel for the Linear key's flow. A key that is not saved shows the field; one that is saved shows its state and the outcome of the last save. */
export function linearPanel(ctx: LinearPanelCtx, view: LinearView, { trailing = [], inCard = false }: LinearPanelOptions = {}): HTMLElement {
	const { flow } = view;
	const body: Array<HTMLElement | null> = [];
	const actions: HTMLElement[] = [];
	const form = (): void => {
		// The OS cannot encrypt: the key is refused before it is typed (no plain-text fallback), with the same sentence the refused save gives.
		if (!view.encryption) {
			body.push(refusal(h("p", {}, ctx.tr("linear.refused"))));
			return;
		}
		const key = keyField(ctx);
		body.push(
			h("p", { class: "note" }, ctx.tr("linear.lead")),
			h("ol", { class: "forge-steps" }, h("li", {}, ctx.tr("linear.step1")), h("li", {}, ctx.tr("linear.step2"))),
			key.field,
		);
		actions.push(
			h("button", part("save", { type: "button", class: "primary", onclick: () => key.send() }), ctx.tr("linear.save")),
			h("button", part("open", { type: "button", onclick: () => ctx.act({ type: "linear-open" }) }), ctx.tr("linear.open")),
		);
		if (view.state === "saved" || flow.phase === "entering") actions.push(h("button", part("cancel", { type: "button", onclick: () => ctx.act({ type: "linear-cancel" }) }), ctx.tr("linear.cancel")));
	};
	/** The state of a key that is saved, as a line (the card shows it as a badge too). */
	const savedLine = (): HTMLElement => h("p", part("saved", { class: "status" }), inCard ? null : h("span", { class: "badge badge-done" }, ctx.tr("linear.badgeSaved")), `${inCard ? "" : " "}${ctx.tr("linear.savedState")}`);
	const setupAgain = (): HTMLElement => h("button", part("retry", { type: "button", class: "primary", onclick: () => ctx.act({ type: "linear-setup" }) }), ctx.tr("linear.tryAgain"));
	switch (flow.phase) {
		case "idle":
			if (view.state === "saved") body.push(savedLine());
			else {
				if (view.state === "unreadable") body.push(h("div", part("unreadable", { class: "problem", role: "alert" }), ctx.tr("linear.unreadable")));
				form();
			}
			break;
		case "entering":
		case "invalid":
		case "save-failed":
			if (flow.phase === "invalid") body.push(h("div", part("invalid", { class: "problem", role: "alert" }), ctx.tr("linear.invalid")));
			if (flow.phase === "save-failed") body.push(h("div", part("save-failed", { class: "problem", role: "alert" }), ctx.tr("linear.saveFailed")), details(ctx, flow.detail));
			form();
			break;
		case "refused":
			body.push(refusal(h("p", {}, ctx.tr("linear.refused"))));
			break;
		case "saving":
			body.push(spinner(ctx, "linear.saving"));
			break;
		case "installing":
			body.push(spinner(ctx, "linear.installing"));
			break;
		case "initializing":
			body.push(spinner(ctx, "linear.initializing"));
			break;
		case "setup-failed":
			body.push(savedLine(), h("div", part("setup-failed", { class: "problem", role: "alert" }), ctx.tr("linear.setupFailed")), details(ctx, ctx.tr(flow.step === "install" ? "linear.stepInstall" : "linear.stepInit"), flow.detail));
			actions.push(setupAgain());
			break;
		case "done":
			body.push(h("p", part("done", { class: "status" }), inCard ? null : h("span", { class: "badge badge-done" }, ctx.tr("linear.badgeSaved")), `${inCard ? "" : " "}${ctx.tr(flow.initialized === "kept" ? "linear.doneKept" : "linear.done")}`));
			break;
		case "signed-out":
			body.push(h("p", part("signed-out", { class: "status" }), ctx.tr("linear.signedOut")));
			break;
	}
	const offer = restartBlock(ctx, view, actions);
	if (offer !== null) body.push(offer);
	const row = [...actions, ...trailing];
	if (row.length > 0) body.push(h("div", { class: "actions" }, ...row));
	return h("div", { class: "forge-panel linear-panel", "data-phase": flow.phase, "data-state": view.state, "data-restart": view.restart.phase }, ...body);
}
