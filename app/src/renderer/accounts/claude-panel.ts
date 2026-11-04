import type { ClaudeAction, ClaudeView } from "../../shared/accounts.ts";
import type { Locale } from "../../shared/locale.ts";
import { h, type Attrs } from "../dom.ts";

// The Claude sign-in panel (spec: First run, step 7), drawn the same way in the wizard and in settings' Accounts. Main owns the flow and sends where it stands; this file words it from the catalog and
// sends back typed requests. The only value that leaves the page is the code, in `claude-code`, from a masked field that is cleared the moment it is sent; nothing here keeps it, stores it, or
// writes it anywhere else. The address shown is the one the CLI printed: it is text on the page, and main opens it, never the page.

export interface ClaudePanelCtx {
	locale: Locale;
	tr(key: string, vars?: Readonly<Record<string, string | number>>): string;
	act(action: ClaudeAction): void;
}

/** The part of the panel: its role, an id for it (one Claude panel per page), and the role again for tests and styles that look for a part. */
const part = (role: string, attrs: Attrs = {}): Attrs => ({ ...attrs, id: `claude-${role}`, "data-role": role });

const spinner = (ctx: ClaudePanelCtx, key: string): HTMLElement => h("p", part("status", { class: "status" }), h("span", { class: "spinner", "aria-hidden": "true" }), ctx.tr(key));

const details = (ctx: ClaudePanelCtx, detail: string): HTMLElement => h("details", part("details", { class: "forge-details" }), h("summary", {}, ctx.tr("claude.details")), h("pre", {}, detail));

/** Cancel for a panel that has no **Later** of its own (the card in settings): it ends the login and stays on the card. */
const cancelButton = (ctx: ClaudePanelCtx): HTMLElement => h("button", part("cancel", { type: "button", onclick: () => ctx.act({ type: "claude-cancel" }) }), ctx.tr("claude.cancel"));

const tryAgain = (ctx: ClaudePanelCtx): HTMLElement =>
	h("button", part("retry", { type: "button", class: "primary", onclick: () => ctx.act({ type: "claude-start" }) }), ctx.tr("claude.tryAgain"));

/** The masked code field: no reveal toggle, no autofill, no spell checking, outside any form. Its value is read once, sent, and cleared. */
function codeField(ctx: ClaudePanelCtx): { field: HTMLElement; send: () => void } {
	const input = h("input", {
		...part("code"),
		type: "password",
		autocomplete: "off",
		autocapitalize: "off",
		spellcheck: "false",
		"data-lpignore": "true",
		"aria-label": ctx.tr("claude.codeLabel"),
	});
	const send = (): void => {
		const code = input.value.trim();
		input.value = "";
		if (code !== "") ctx.act({ type: "claude-code", code });
	};
	input.addEventListener("keydown", (event) => {
		if (event.key === "Enter") {
			event.preventDefault();
			send();
		}
	});
	return { field: h("div", { class: "forge-token" }, h("p", { class: "note" }, ctx.tr("claude.codeHelp")), h("label", { class: "field-label", for: "claude-code" }, ctx.tr("claude.codeLabel")), input), send };
}

export interface ClaudePanelOptions {
	/** More buttons for the end of the step's row of actions (the wizard's **Later** or **Next**): one row holds every action of a step, the panel's own first. */
	trailing?: readonly HTMLElement[];
	/** The panel sits in Claude's card in settings, which already shows the state: an outcome of **Done** does not repeat it. */
	inCard?: boolean;
}

/** The panel for Claude's flow. `idle` draws what the state says: **Sign in** for a Claude that is not signed in. */
export function claudePanel(ctx: ClaudePanelCtx, view: ClaudeView, { trailing = [], inCard = false }: ClaudePanelOptions = {}): HTMLElement {
	const { flow } = view;
	const body: Array<HTMLElement | null> = [];
	/** The step's buttons, primary first; the row is drawn once, after the content. */
	const actions: HTMLElement[] = [];
	// On Windows the sign-in is a file in the app's own folder, in plain text (Claude Code's choice; the boss accepted it for the pilot): the page says so wherever it offers or confirms a sign-in.
	const storage = view.storage === "file" ? h("p", part("storage", { class: "note" }), ctx.tr("claude.storageFile")) : null;
	switch (flow.phase) {
		case "idle":
			if (view.state === "signed-in") {
				body.push(h("p", part("done", { class: "status" }), inCard ? null : h("span", { class: "badge badge-done" }, ctx.tr("settings.accounts.signedIn")), `${inCard ? "" : " "}${ctx.tr("claude.done")}`), storage);
			} else {
				body.push(h("p", { class: "note" }, ctx.tr("claude.lead")), storage);
				actions.push(h("button", part("sign-in", { type: "button", class: "primary", onclick: () => ctx.act({ type: "claude-start" }) }), ctx.tr("claude.signIn")));
			}
			break;
		case "checking":
			body.push(spinner(ctx, "claude.checking"));
			break;
		case "starting":
			body.push(spinner(ctx, "claude.starting"));
			// In the wizard **Later** ends the login too, so a second button for it would read as the same choice (SA-T11-1).
			if (trailing.length === 0) actions.push(cancelButton(ctx));
			break;
		case "browser": {
			body.push(h("p", { class: "note" }, ctx.tr("claude.browser")));
			// The row holds Send (primary, while the CLI waits for a code) and the step's own **Later**; opening and copying the address are small actions beside it.
			const asking = flow.codeAsked && !flow.codeSent;
			if (flow.url !== null) {
				body.push(
					h("p", { class: "note" }, ctx.tr("claude.urlHelp")),
					h("p", part("url", { class: "path" }), flow.url),
					h(
						"div",
						{ class: "url-actions" },
						h("button", part("open", { type: "button", onclick: () => ctx.act({ type: "claude-open" }) }), ctx.tr("claude.open")),
						h("button", part("copy", { type: "button", onclick: () => ctx.act({ type: "claude-copy-url" }) }), ctx.tr("claude.copy")),
					),
				);
			}
			if (asking) {
				const code = codeField(ctx);
				if (flow.codeRefused === true) body.push(h("div", part("code-refused", { class: "problem", role: "alert" }), ctx.tr("claude.codeRefused")));
				body.push(code.field);
				actions.unshift(h("button", part("send-code", { type: "button", class: "primary", onclick: () => code.send() }), ctx.tr("claude.sendCode")));
			} else if (flow.codeSent) body.push(spinner(ctx, "claude.codeSent"));
			else body.push(spinner(ctx, "claude.waiting"));
			if (trailing.length === 0) actions.push(cancelButton(ctx));
			break;
		}
		case "working":
			body.push(spinner(ctx, "claude.working"));
			break;
		case "failed":
			body.push(h("div", part("failed", { class: "problem", role: "alert" }), ctx.tr("claude.failed")), details(ctx, flow.detail));
			actions.push(tryAgain(ctx));
			break;
		case "timeout":
			body.push(h("div", part("timeout", { class: "problem", role: "alert" }), ctx.tr("claude.timeout")));
			actions.push(tryAgain(ctx));
			break;
		case "unverified":
			body.push(h("div", part("unverified", { class: "problem", role: "alert" }), ctx.tr("claude.unverified")), details(ctx, flow.detail));
			actions.push(tryAgain(ctx));
			break;
		case "done":
			body.push(h("p", part("done", { class: "status" }), inCard ? null : h("span", { class: "badge badge-done" }, ctx.tr("settings.accounts.signedIn")), `${inCard ? "" : " "}${ctx.tr("claude.done")}`), storage);
			break;
		case "signed-out":
			body.push(h("p", part("signed-out", { class: "status" }), ctx.tr("claude.signedOut")));
			break;
	}
	const row = [...actions, ...trailing];
	if (row.length > 0) body.push(h("div", { class: "actions" }, ...row));
	return h("div", { class: "forge-panel claude-panel", "data-phase": flow.phase, "data-state": view.state }, ...body);
}
