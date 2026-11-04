import type { ChangeLine, ShellUpdateState, StackUpdateState, UpdatesView } from "../../shared/updates.ts";
import { listOf } from "../../shared/locale.ts";
import { h } from "../dom.ts";
import { stageLabel } from "../wizard/install.ts";
import { sectionBox, type SettingsCtx } from "./common.ts";

// Updates (spec: Updater, Settings). Three cards, one per item, each with ids of its own and one row of actions with the primary one first: the check, the app, and the stack of tools and
// packages. The words are the catalog's; main sends phases and reasons (`shared/updates.ts`).

type Tr = SettingsCtx["tr"];

const BADGE_CLASS = { working: "badge-working", done: "badge-done", failed: "badge-failed", warn: "badge-warn", quiet: "badge-blocked" } as const;
type BadgeKind = keyof typeof BADGE_CLASS;

const badge = (cls: BadgeKind, phase: string, text: string): HTMLElement => h("span", { class: `badge ${BADGE_CLASS[cls]}`, "data-badge": phase }, text);

/** The raw text of an error, under a Details fold: the sentence above it is the catalog's, and this is for whoever helps the PM. Null when there is none. */
function details(tr: Tr, raw: string | undefined): HTMLElement | null {
	if (raw === undefined || raw === "") return null;
	return h("details", { class: "update-details" }, h("summary", {}, tr("settings.updates.details")), h("p", { class: "note update-detail" }, raw));
}

/** A card: its head (name, what it is about, the badge, the one row of buttons), then the sentence, then whatever the state adds. */
function card(role: string, state: string, head: Array<HTMLElement | null>, ...below: Array<HTMLElement | null>): HTMLElement {
	return h("li", { class: "update-card", "data-role": role, "data-state": state }, h("div", { class: "update-head" }, ...head), ...below);
}

const row = (...buttons: Array<HTMLElement | null>): HTMLElement | null => {
	const present = buttons.filter((b): b is HTMLElement => b !== null);
	return present.length === 0 ? null : h("span", { class: "update-buttons" }, ...present);
};

const button = (id: string, text: string, onclick: () => void, options: { primary?: boolean; disabled?: boolean } = {}): HTMLElement =>
	h("button", { type: "button", id, class: options.primary === true ? "primary" : null, disabled: options.disabled === true, onclick }, text);

// ---- the check ---------------------------------------------------------------------------------------------------------

function checkCard(ctx: SettingsCtx, view: UpdatesView): HTMLElement {
	const time = view.checkedAt === null ? null : new Date(view.checkedAt).toLocaleTimeString(ctx.locale, { hour: "2-digit", minute: "2-digit" });
	return card(
		"check",
		view.checking ? "checking" : "idle",
		[h("span", { class: "update-name" }, ctx.tr("settings.updates.check.name")), row(button("update-check", ctx.tr(view.checking ? "settings.updates.check.busy" : "settings.updates.check.button"), () => ctx.act({ type: "update-check" }), { primary: true, disabled: view.checking || view.stack.phase === "applying" }))],
		h("p", { class: "note update-note", id: "update-checked" }, time === null ? ctx.tr("settings.updates.check.never") : ctx.tr("settings.updates.check.last", { time })),
	);
}

// ---- the app -----------------------------------------------------------------------------------------------------------

function appSentence(tr: Tr, state: ShellUpdateState): string {
	switch (state.phase) {
		case "off":
			return tr("settings.updates.app.off");
		case "idle":
			return tr("settings.updates.app.idle");
		case "checking":
			return tr("settings.updates.app.checking");
		case "available":
			return tr("settings.updates.app.available", { version: state.version });
		case "downloading":
			return state.percent === null ? tr("settings.updates.app.downloading", { version: state.version }) : tr("settings.updates.app.downloadingPercent", { version: state.version, percent: state.percent });
		case "ready":
			return state.installFailed === undefined ? tr("settings.updates.app.ready", { version: state.version }) : tr("settings.updates.app.installFailed", { version: state.version });
		case "downloaded":
			return tr("settings.updates.app.downloaded", { version: state.version });
		case "refused":
			return tr(`settings.updates.app.refused.${state.reason}`, { version: state.version });
		case "error":
			return state.kind === "network" ? tr("settings.updates.app.errorNetwork") : tr("settings.updates.app.errorOther");
	}
}

/** The raw reason behind a sentence, or undefined: a failed install start and every error carry one. */
const appDetail = (state: ShellUpdateState): string | undefined => (state.phase === "error" ? state.detail : state.phase === "ready" ? state.installFailed : undefined);

const APP_BADGE: Record<ShellUpdateState["phase"], BadgeKind> = { off: "quiet", idle: "done", checking: "working", available: "working", downloading: "working", ready: "done", downloaded: "done", refused: "failed", error: "failed" };

function appCard(ctx: SettingsCtx, view: UpdatesView): HTMLElement {
	const state = view.shell;
	const restart = state.phase === "ready" && view.platform === "win32" ? button("update-restart", ctx.tr("settings.updates.app.restart"), () => ctx.act({ type: "update-restart" }), { primary: true }) : null;
	const download = state.phase === "available" && view.platform === "darwin" ? button("update-download", ctx.tr("settings.updates.app.download"), () => ctx.act({ type: "update-download" }), { primary: true }) : null;
	const reveal = state.phase === "downloaded" ? button("update-reveal", ctx.tr("settings.updates.app.reveal"), () => ctx.act({ type: "update-reveal" }), { primary: true }) : null;
	return card(
		"app",
		state.phase,
		[
			h("span", { class: "update-name" }, ctx.tr("settings.updates.app.name")),
			h("span", { class: "update-version", id: "app-version" }, ctx.tr("settings.updates.version", { version: view.appVersion })),
			badge(APP_BADGE[state.phase], state.phase, ctx.tr(`settings.updates.app.badge.${state.phase}`)),
			row(restart, download, reveal),
		],
		h("p", { class: "note update-note", id: "update-app-note", "data-reason": state.phase === "refused" ? state.reason : state.phase === "ready" && state.installFailed !== undefined ? "install-failed" : null }, appSentence(ctx.tr, state)),
		details(ctx.tr, appDetail(state)),
	);
}

// ---- the stack ---------------------------------------------------------------------------------------------------------

const STACK_BADGE_KEY: Record<StackUpdateState["phase"], string> = { idle: "idle", checking: "checking", available: "available", applying: "applying", applied: "applied", "rolled-back": "rolledBack", refused: "refused", error: "error" };
const STACK_BADGE: Record<StackUpdateState["phase"], BadgeKind> = { idle: "done", checking: "working", available: "working", applying: "working", applied: "done", "rolled-back": "warn", refused: "failed", error: "failed" };

function changeLine(ctx: SettingsCtx, change: ChangeLine): HTMLElement {
	const name = stageLabel(ctx, change.stage);
	const text =
		change.from !== null && change.to !== null
			? ctx.tr("settings.updates.stack.changed", { name, from: change.from, to: change.to })
			: change.to !== null
				? ctx.tr("settings.updates.stack.added", { name, to: change.to })
				: ctx.tr("settings.updates.stack.removed", { name });
	return h("li", { "data-stage": change.stage }, text);
}

function stackSentence(ctx: SettingsCtx, view: UpdatesView): string {
	const tr = ctx.tr;
	const state = view.stack;
	switch (state.phase) {
		case "idle":
			return tr("settings.updates.stack.idle");
		case "checking":
			return tr("settings.updates.stack.checking");
		case "available":
			return tr("settings.updates.stack.available", { generation: state.generation });
		case "applying":
			return state.stage === null ? tr("settings.updates.stack.applying", { generation: state.generation }) : tr("settings.updates.stack.applyingStage", { generation: state.generation, stage: stageLabel(ctx, state.stage) });
		case "applied":
			return tr("settings.updates.stack.applied", { generation: state.generation });
		case "rolled-back":
			if (state.stage === "interrupted") return tr("settings.updates.stack.interrupted", { generation: state.generation });
			return tr(state.restored ? "settings.updates.stack.rolledBack" : "settings.updates.stack.rolledBackPartly", { generation: state.generation, stage: stageLabel(ctx, state.stage), previous: view.generation });
		case "refused":
			return tr(`settings.updates.stack.refused.${state.reason}`, { generation: state.generation ?? 0, minShell: state.minShell ?? "", tools: listOf(ctx.locale, state.tools ?? []) });
		case "error":
			return tr(state.kind === "network" ? "settings.updates.stack.errorNetwork" : state.kind === "busy" ? "settings.updates.stack.errorBusy" : "settings.updates.stack.errorOther");
	}
}

function stackCard(ctx: SettingsCtx, view: UpdatesView): HTMLElement {
	const state = view.stack;
	const apply = state.phase === "available" || state.phase === "applying" ? button("update-apply", ctx.tr("settings.updates.stack.apply"), () => ctx.act({ type: "update-apply" }), { primary: true, disabled: state.phase === "applying" }) : null;
	return card(
		"stack",
		state.phase,
		[
			h("span", { class: "update-name" }, ctx.tr("settings.updates.stack.name")),
			h("span", { class: "update-version", id: "stack-generation" }, ctx.tr("settings.updates.stack.generation", { generation: view.generation })),
			badge(STACK_BADGE[state.phase], state.phase, ctx.tr(`settings.updates.stack.badge.${STACK_BADGE_KEY[state.phase]}`)),
			row(apply),
		],
		h("p", { class: "note update-note", id: "update-stack-note", "data-reason": state.phase === "refused" ? state.reason : state.phase === "rolled-back" ? state.stage : null }, stackSentence(ctx, view)),
		details(ctx.tr, state.phase === "error" ? state.detail : undefined),
		state.phase === "available" && state.changes.length > 0
			? h("details", { class: "update-changes-box", id: "update-changes", open: true }, h("summary", {}, ctx.tr("settings.updates.stack.changes")), h("ul", { class: "update-changes" }, ...state.changes.map((c) => changeLine(ctx, c))))
			: null,
	);
}

/** Without a view (a page drawn before main answered) the section shows only the app's version. */
export function updates(ctx: SettingsCtx): HTMLElement {
	const view = ctx.view.updates;
	if (view === undefined) return sectionBox(ctx, "updates", h("p", { id: "app-version" }, ctx.tr("settings.updates.version", { version: ctx.view.appVersion })));
	return sectionBox(ctx, "updates", h("ul", { class: "accounts update-cards", id: "update-cards" }, checkCard(ctx, view), appCard(ctx, view), stackCard(ctx, view)));
}
