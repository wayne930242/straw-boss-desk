import type { ForgeState, ForgeView } from "../../shared/accounts.ts";
import { forgePanel } from "../accounts/forge-panel.ts";
import { h } from "../dom.ts";
import { laterLabel } from "../wizard/later.ts";
import { sectionBox, type SettingsCtx } from "./common.ts";

// Accounts (spec: Settings). Each code host has a row: its state, **Sign in again** (the checks of the code-host screens first) and **Sign out** (only entries the app owns). Task 11 fills Claude and
// Linear; until then a sign-in put off for either shows as a badge.

const BADGE: Record<ForgeState, { cls: string; key: string }> = {
	"signed-in": { cls: "badge-done", key: "settings.accounts.signedIn" },
	"not-signed-in": { cls: "badge-blocked", key: "settings.accounts.notSignedIn" },
	foreign: { cls: "badge-blocked", key: "settings.accounts.foreign" },
	left: { cls: "badge-failed", key: "settings.accounts.left" },
	unknown: { cls: "badge-blocked", key: "settings.accounts.unknown" },
};

const BUSY = ["checking", "waiting-code", "code", "working"];

function forgeRow(ctx: SettingsCtx, view: ForgeView): HTMLElement {
	const badge = BADGE[view.state];
	const busy = BUSY.includes(view.flow.phase);
	const tool = ctx.tr(`forge.tool.${view.kind}`);
	const signedIn = view.state === "signed-in" || view.state === "left";
	const note = view.state === "left" ? ctx.tr("forge.changed", { host: view.host, tool }) : view.state === "foreign" ? ctx.tr("forge.foreign", { host: view.host, tool }) : null;
	return h(
		"li",
		{ class: "forge-row", "data-forge": view.host, "data-state": view.state },
		h(
			"div",
			{ class: "forge-head" },
			h("span", { class: "forge-name" }, ctx.tr(`later.${view.kind}`, { host: view.host })),
			h("span", { class: `badge ${badge.cls}`, "data-badge": view.state }, ctx.tr(badge.key)),
			h(
				"span",
				{ class: "forge-buttons" },
				h("button", { type: "button", class: "forge-sign-in-again", disabled: busy, onclick: () => ctx.act({ type: "forge-begin", kind: view.kind, host: view.host }) }, ctx.tr(signedIn ? "settings.accounts.signInAgain" : "settings.accounts.signIn")),
				signedIn ? h("button", { type: "button", class: "forge-sign-out", disabled: busy, onclick: () => ctx.act({ type: "forge-sign-out", kind: view.kind, host: view.host }) }, ctx.tr("settings.accounts.signOut")) : null,
			),
		),
		note === null ? null : h("p", { class: "note forge-note" }, note),
	);
}

/** Where a sign-in stands, under the list: a panel per code host that has something to say (the checks, a code, a refusal, the outcome of a sign-out). */
function forgePanels(ctx: SettingsCtx): HTMLElement[] {
	return ctx.view.forges
		.filter((f) => f.flow.phase !== "idle")
		.map((f) => h("div", { class: "panel forge-holder", "data-forge": f.host }, h("h3", {}, ctx.tr(`later.${f.kind}`, { host: f.host })), forgePanel(ctx, f)));
}

export function accounts(ctx: SettingsCtx): HTMLElement {
	// The sign-ins put off that are not code hosts (Claude, Linear) keep their badge; a code host has its row.
	const others = ctx.view.later.filter((l) => l.item === "claude" || l.item === "linear");
	return sectionBox(
		ctx,
		"accounts",
		ctx.view.forges.length === 0 ? null : h("ul", { class: "accounts", id: "accounts-forges" }, ...ctx.view.forges.map((f) => forgeRow(ctx, f))),
		...forgePanels(ctx),
		others.length === 0
			? null
			: h("ul", { class: "accounts", id: "accounts-later" }, ...others.map((l) => h("li", { "data-item": l.item }, h("span", {}, laterLabel(ctx.tr, l)), h("span", { class: "badge badge-blocked" }, ctx.tr("settings.accounts.notSignedIn"))))),
		h("p", { class: "note soon" }, ctx.tr("settings.accounts.soon")),
	);
}
