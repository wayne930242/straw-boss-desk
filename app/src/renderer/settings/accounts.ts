import type { ClaudeState, ForgeState, ForgeView, LinearState } from "../../shared/accounts.ts";
import { claudePanel } from "../accounts/claude-panel.ts";
import { forgePanel } from "../accounts/forge-panel.ts";
import { linearPanel } from "../accounts/linear-panel.ts";
import { h } from "../dom.ts";
import { sectionBox, type SettingsCtx } from "./common.ts";

// Accounts (spec: Settings). Claude, each code host and Linear have one card each: its state, **Sign in again**, **Sign out** and the flow of either. A code host's sign-in checks the store first and signs
// out only entries the app owns; Claude's runs the CLI's own login and logout; Linear's key is replaced or deleted (`linear.bin`), and a change while the stack runs offers **Restart now** or **Later**.

const BADGE: Record<ForgeState, { cls: string; key: string }> = {
	"signed-in": { cls: "badge-done", key: "settings.accounts.signedIn" },
	"not-signed-in": { cls: "badge-blocked", key: "settings.accounts.notSignedIn" },
	foreign: { cls: "badge-blocked", key: "settings.accounts.foreign" },
	left: { cls: "badge-failed", key: "settings.accounts.left" },
	unknown: { cls: "badge-blocked", key: "settings.accounts.unknown" },
};

const BUSY = ["checking", "waiting-code", "code", "working"];

const CLAUDE_BADGE: Record<ClaudeState, { cls: string; key: string }> = {
	"signed-in": { cls: "badge-done", key: "settings.accounts.signedIn" },
	"not-signed-in": { cls: "badge-blocked", key: "settings.accounts.notSignedIn" },
	unknown: { cls: "badge-blocked", key: "settings.accounts.unknown" },
};

const LINEAR_BADGE: Record<LinearState, { cls: string; key: string }> = {
	saved: { cls: "badge-done", key: "linear.badgeSaved" },
	"not-saved": { cls: "badge-blocked", key: "settings.accounts.notSignedIn" },
	unreadable: { cls: "badge-failed", key: "linear.badgeUnreadable" },
};

const CLAUDE_BUSY = ["checking", "starting", "browser", "working"];
const LINEAR_BUSY = ["saving", "installing", "initializing"];

/** Claude's card: the CLI's own status as a badge, **Sign in again** and **Sign out**, and the flow (the browser, the code field, a problem, the outcome) inside the same card. */
function claudeCard(ctx: SettingsCtx): HTMLElement {
	const view = ctx.view.claude;
	const badge = CLAUDE_BADGE[view.state];
	const busy = CLAUDE_BUSY.includes(view.flow.phase);
	const signedIn = view.state === "signed-in";
	return h(
		"li",
		{ class: "account-card", "data-account": "claude", "data-state": view.state },
		h(
			"div",
			{ class: "forge-head" },
			h("span", { class: "forge-name" }, ctx.tr("later.claude")),
			h("span", { class: `badge ${badge.cls}`, "data-badge": view.state }, ctx.tr(badge.key)),
			h(
				"span",
				{ class: "forge-buttons" },
				h("button", { type: "button", class: "claude-sign-in", disabled: busy, onclick: () => ctx.act({ type: "claude-start" }) }, ctx.tr(signedIn ? "settings.accounts.signInAgain" : "settings.accounts.signIn")),
				signedIn ? h("button", { type: "button", class: "claude-sign-out", disabled: busy, onclick: () => ctx.act({ type: "claude-sign-out" }) }, ctx.tr("settings.accounts.signOut")) : null,
			),
		),
		view.flow.phase === "idle" ? (signedIn && view.storage === "file" ? h("p", { class: "note forge-note", "data-role": "storage" }, ctx.tr("claude.storageFile")) : null) : claudePanel(ctx, view, { inCard: true }),
	);
}

/** Linear's card: whether a key is saved, **Sign in** or **Change key** (the field), **Sign out** (deletes `linear.bin`), and the save, its setup and the restart offer inside the same card. */
function linearCard(ctx: SettingsCtx): HTMLElement | null {
	const view = ctx.view.linear;
	if (view === null) return null;
	const badge = LINEAR_BADGE[view.state];
	const busy = LINEAR_BUSY.includes(view.flow.phase) || view.restart.phase === "restarting";
	const has = view.state !== "not-saved";
	const speaking = view.flow.phase !== "idle" || view.restart.phase !== "none";
	return h(
		"li",
		{ class: "account-card", "data-account": "linear", "data-state": view.state },
		h(
			"div",
			{ class: "forge-head" },
			h("span", { class: "forge-name" }, ctx.tr("later.linear")),
			h("span", { class: `badge ${badge.cls}`, "data-badge": view.state }, ctx.tr(badge.key)),
			h(
				"span",
				{ class: "forge-buttons" },
				h("button", { type: "button", class: "linear-sign-in", disabled: busy, onclick: () => ctx.act({ type: "linear-edit" }) }, ctx.tr(has ? "linear.change" : "settings.accounts.signIn")),
				has ? h("button", { type: "button", class: "linear-sign-out", disabled: busy, onclick: () => ctx.act({ type: "linear-sign-out" }) }, ctx.tr("settings.accounts.signOut")) : null,
			),
		),
		view.state === "unreadable" && !speaking ? h("p", { class: "note forge-note" }, ctx.tr("linear.unreadable")) : null,
		speaking ? linearPanel(ctx, view, { inCard: true }) : null,
	);
}

/**
 * One card per code host: its name and state, the note on the state, its buttons, and the sign-in flow (the checks, a code, a refusal, the outcome of a sign-out) open inside the same card. The
 * note is left out while a flow speaks, since a refusal says the same thing (SA-T10-1). Parts have ids scoped to the host, so cards of several hosts never share one (T10R-F003).
 */
function forgeCard(ctx: SettingsCtx, view: ForgeView): HTMLElement {
	const badge = BADGE[view.state];
	const busy = BUSY.includes(view.flow.phase);
	const tool = ctx.tr(`forge.tool.${view.kind}`);
	const signedIn = view.state === "signed-in" || view.state === "left";
	// Sign out is offered whenever something may be there to remove: it removes what the app owns and, beside a sign-in it does not own, says that one was left alone (Removing a login).
	const canSignOut = view.state !== "not-signed-in";
	const speaking = view.flow.phase !== "idle";
	const note = speaking ? null : view.state === "left" ? ctx.tr("forge.changed", { host: view.host, tool }) : view.state === "foreign" ? ctx.tr("forge.foreign", { host: view.host, tool }) : null;
	return h(
		"li",
		{ class: "forge-card", "data-forge": view.host, "data-state": view.state },
		h(
			"div",
			{ class: "forge-head" },
			h("span", { class: "forge-name" }, ctx.tr(`later.${view.kind}`, { host: view.host })),
			h("span", { class: `badge ${badge.cls}`, "data-badge": view.state }, ctx.tr(badge.key)),
			h(
				"span",
				{ class: "forge-buttons" },
				h("button", { type: "button", class: "forge-sign-in-again", disabled: busy, onclick: () => ctx.act({ type: "forge-begin", kind: view.kind, host: view.host }) }, ctx.tr(signedIn ? "settings.accounts.signInAgain" : "settings.accounts.signIn")),
				canSignOut ? h("button", { type: "button", class: "forge-sign-out", disabled: busy, onclick: () => ctx.act({ type: "forge-sign-out", kind: view.kind, host: view.host }) }, ctx.tr("settings.accounts.signOut")) : null,
			),
		),
		note === null ? null : h("p", { class: "note forge-note" }, note),
		speaking ? forgePanel(ctx, view, { inCard: true }) : null,
	);
}

export function accounts(ctx: SettingsCtx): HTMLElement {
	const linear = linearCard(ctx);
	return sectionBox(
		ctx,
		"accounts",
		h("ul", { class: "accounts", id: "accounts-claude" }, claudeCard(ctx)),
		ctx.view.forges.length === 0 ? null : h("ul", { class: "accounts", id: "accounts-forges" }, ...ctx.view.forges.map((f) => forgeCard(ctx, f))),
		linear === null ? null : h("ul", { class: "accounts", id: "accounts-linear" }, linear),
	);
}
