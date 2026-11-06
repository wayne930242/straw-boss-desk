import type { DiagnosticsView, StatusFields } from "../../shared/computer.ts";
import { h } from "../dom.ts";
import { sectionBox, type SettingsCtx } from "./common.ts";
import { badge, button, card, details, row } from "./updates.ts";

// Diagnostics (spec: Settings): the stack's status, the logs, **Collect diagnostics** and **Repair**, one card each, built from the parts the Updates cards use. Reading the status costs a few seconds
// (on Windows one PowerShell start), so it runs on a button and never by itself. Main sends phases and values; the words are the catalog's. **Collect diagnostics** is the page's one primary action;
// the others are secondary.

type Tr = SettingsCtx["tr"];

const yesNo = (tr: Tr, value: boolean | null): string => (value === null ? tr("settings.diagnostics.status.unknown") : tr(value ? "settings.diagnostics.status.yes" : "settings.diagnostics.status.no"));

/** The state word in the catalog's words. A state the page does not know is not shown raw in the sentence: it says so, and the word itself is under Details. */
const KNOWN_STATES: readonly string[] = ["live"];

function stateLine(tr: Tr, state: string | null): HTMLElement {
	if (state === null) return h("li", { "data-field": "state" }, tr("settings.diagnostics.status.state", { state: tr("settings.diagnostics.status.unknown") }));
	if (KNOWN_STATES.includes(state)) return h("li", { "data-field": "state", "data-state": state }, tr("settings.diagnostics.status.state", { state: tr(`settings.diagnostics.status.states.${state}`) }));
	return h("li", { "data-field": "state", "data-state": "other" }, tr("settings.diagnostics.status.state", { state: tr("settings.diagnostics.status.stateOther") }), h("details", {}, h("summary", {}, tr("settings.diagnostics.details")), h("pre", {}, state)));
}

function statusLines(tr: Tr, f: StatusFields): HTMLElement {
	return h(
		"ul",
		{ class: "diag-facts", id: "diag-status-fields" },
		stateLine(tr, f.state),
		h("li", { "data-field": "primary" }, tr("settings.diagnostics.status.primary", { value: yesNo(tr, f.primary) })),
		h("li", { "data-field": "desk" }, tr("settings.diagnostics.status.desk", { value: yesNo(tr, f.desk) })),
		h("li", { "data-field": "version" }, tr("settings.diagnostics.status.version", { version: f.version ?? tr("settings.diagnostics.status.unknown") })),
	);
}

function statusCard(ctx: SettingsCtx, view: DiagnosticsView): HTMLElement {
	const { tr } = ctx;
	const s = view.status;
	const reading = s.phase === "reading";
	return card(
		"status",
		s.phase,
		[
			h("span", { class: "update-name" }, tr("settings.diagnostics.status.heading")),
			reading ? badge("working", "reading", tr("settings.diagnostics.status.reading")) : null,
			row(button("diag-status", tr(reading ? "settings.diagnostics.status.reading" : "settings.diagnostics.status.button"), () => ctx.act({ type: "diagnostics-status" }), { disabled: reading })),
		],
		h("p", { class: "note update-note" }, tr("settings.diagnostics.status.lead")),
		s.phase === "ok" ? statusLines(tr, s.fields) : null,
		s.phase === "failed" ? h("p", { class: "note update-note", id: "diag-status-failed", "data-reason": s.reason }, tr(`settings.diagnostics.status.failed.${s.reason}`)) : null,
		s.phase === "failed" ? details(tr, s.detail === "" ? undefined : s.detail) : null,
	);
}

function logsCard(ctx: SettingsCtx, view: DiagnosticsView): HTMLElement {
	const { tr } = ctx;
	return card(
		"logs",
		"idle",
		[h("span", { class: "update-name" }, tr("settings.diagnostics.logs.heading")), row(button("diag-logs", tr("settings.diagnostics.logs.button"), () => ctx.act({ type: "diagnostics-open-logs" })))],
		h("p", { class: "note update-note" }, tr("settings.diagnostics.logs.lead")),
		h("p", { class: "note update-note", id: "diag-logs-where" }, tr("settings.diagnostics.logs.where", { folder: view.logsDir })),
	);
}

function collectCard(ctx: SettingsCtx, view: DiagnosticsView): HTMLElement {
	const { tr } = ctx;
	const c = view.collect;
	const working = c.phase === "working";
	return card(
		"collect",
		c.phase,
		[
			h("span", { class: "update-name" }, tr("settings.diagnostics.collect.heading")),
			working ? badge("working", "working", tr("settings.diagnostics.collect.working")) : null,
			row(button("diag-collect", tr(working ? "settings.diagnostics.collect.working" : "settings.diagnostics.collect.button"), () => ctx.act({ type: "diagnostics-collect" }), { primary: true, disabled: working }), c.phase === "done" ? button("diag-reveal", tr("settings.diagnostics.collect.reveal"), () => ctx.act({ type: "diagnostics-reveal" })) : null),
		],
		h("p", { class: "note update-note" }, tr("settings.diagnostics.collect.lead")),
		c.phase === "done" ? h("p", { class: "note update-note", id: "diag-collect-done" }, tr("settings.diagnostics.collect.done", { file: c.file, files: c.files })) : null,
		c.phase === "done" && c.skipped > 0 ? h("p", { class: "note update-note", id: "diag-collect-skipped" }, tr("settings.diagnostics.collect.skipped", { count: c.skipped })) : null,
		c.phase === "failed" ? h("p", { class: "note update-note", id: "diag-collect-failed" }, tr("settings.diagnostics.collect.failed")) : null,
		c.phase === "failed" ? details(tr, c.detail) : null,
	);
}

function repairCard(ctx: SettingsCtx, view: DiagnosticsView): HTMLElement {
	const { tr } = ctx;
	const r = view.repair;
	const working = r.phase === "working";
	return card(
		"repair",
		r.phase,
		[
			h("span", { class: "update-name" }, tr("settings.diagnostics.repair.heading")),
			r.phase === "done" ? badge("done", "done", tr("settings.diagnostics.repair.done")) : working ? badge("working", "working", tr("settings.diagnostics.repair.working")) : null,
			row(button("diag-repair", tr(working ? "settings.diagnostics.repair.working" : "settings.diagnostics.repair.button"), () => ctx.act({ type: "diagnostics-repair" }), { disabled: working })),
		],
		h("p", { class: "note update-note" }, tr("settings.diagnostics.repair.lead")),
		r.phase === "failed" ? h("p", { class: "note update-note", id: "diag-repair-failed" }, tr("settings.diagnostics.repair.failed")) : null,
		r.phase === "failed" ? details(tr, r.detail) : null,
	);
}

/** Without a view (a page drawn before main answered) the section shows its heading only. */
export function diagnostics(ctx: SettingsCtx): HTMLElement {
	const view = ctx.view.diagnostics;
	if (view === undefined) return sectionBox(ctx, "diagnostics");
	return sectionBox(
		ctx,
		"diagnostics",
		view.wslBash === null ? null : h("div", { class: "finding", id: "diag-wsl", "data-path": view.wslBash }, h("p", {}, ctx.tr("welcome.wsl")), h("details", {}, h("summary", {}, ctx.tr("settings.diagnostics.details")), h("pre", {}, ctx.tr("welcome.wslPath", { path: view.wslBash })))),
		h("ul", { class: "accounts update-cards", id: "diag-cards" }, statusCard(ctx, view), logsCard(ctx, view), collectCard(ctx, view), repairCard(ctx, view)),
	);
}
