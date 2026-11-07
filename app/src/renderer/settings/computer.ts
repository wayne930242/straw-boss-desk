import type { LeftEntry, RemovalProblem, RemovalResult, RemoveState } from "../../shared/computer.ts";
import { h, type Child } from "../dom.ts";
import { sectionBox, type SettingsCtx } from "./common.ts";

// Computer (spec: Settings, Uninstall and data): language, keep awake, and **Remove all data**. The removal is a short run of states, each with its own panel and ids (`remove-*`): the button, the
// confirmation that names what goes and what stays, the refusal, the work in progress, the stop that could not finish, and the result. Main sends phases and names; the words are the catalog's.

type Tr = SettingsCtx["tr"];

/** Bytes as a short size in the page's language: 1.2 GB. The unit names are the same in both languages. */
export function formatSize(bytes: number, locale: string): string {
	const units = ["B", "KB", "MB", "GB", "TB"];
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit++;
	}
	return `${value.toLocaleString(locale, { maximumFractionDigits: unit === 0 ? 0 : 1 })} ${units[unit]}`;
}

const entryText = (tr: Tr, e: { name: string; account: string }): string => (e.account === "" ? tr("settings.computer.remove.entry", { name: e.name }) : tr("settings.computer.remove.entryAccount", { name: e.name, account: e.account }));

/** The entries that stay, each with the reason. Empty list: the sentence that nothing stays. */
function leftList(tr: Tr, left: readonly LeftEntry[], heading: string, role: string): HTMLElement {
	if (left.length === 0) return h("p", { class: "note", "data-role": role }, tr("settings.computer.remove.leavesNone"));
	return h(
		"div",
		{ "data-role": role },
		h("p", {}, heading),
		h(
			"ul",
			{ class: "remove-entries" },
			...left.map((e) => h("li", { "data-entry": e.name, "data-why": e.why }, h("span", { class: "remove-entry" }, entryText(tr, e)), " ", h("span", { class: "remove-why" }, tr(`settings.computer.remove.why.${e.why}`)))),
		),
	);
}

const keptSentence = (tr: Tr, workFolder: string | null, withFolder: string, without: string): string => (workFolder === null ? tr(without) : tr(withFolder, { folder: workFolder }));

function confirmPanel(ctx: SettingsCtx, state: Extract<RemoveState, { phase: "confirm" }>): HTMLElement {
	const { tr } = ctx;
	const plan = state.plan;
	return h(
		"div",
		{ class: "finding", id: "remove-confirm-panel", "data-state": "confirm" },
		h("h3", { class: "remove-title" }, tr("settings.computer.remove.confirmTitle")),
		h("p", {}, plan.bytes === null ? tr("settings.computer.remove.sizeUnknown", { root: plan.root }) : tr("settings.computer.remove.size", { root: plan.root, size: formatSize(plan.bytes, ctx.locale) })),
		h("p", {}, tr("settings.computer.remove.signOuts")),
		plan.pathEntry === null ? null : h("p", { "data-role": "path" }, tr("settings.computer.remove.path", { path: plan.pathEntry })),
		h("p", { "data-role": "kept" }, keptSentence(tr, plan.workFolder, "settings.computer.remove.keeps", "settings.computer.remove.keepsNone")),
		leftList(tr, plan.left, tr("settings.computer.remove.leaves"), "leaves"),
		plan.left.length === 0 ? null : h("p", {}, h("button", { type: "button", id: "remove-guide", onclick: () => ctx.act({ type: "computer-open-guide" }) }, tr("settings.computer.remove.guide"))),
		h(
			"div",
			{ class: "update-buttons" },
			h("button", { type: "button", id: "remove-confirm", class: "primary", onclick: () => ctx.act({ type: "computer-remove-confirm" }) }, tr("settings.computer.remove.confirm")),
			h("button", { type: "button", id: "remove-cancel", onclick: () => ctx.act({ type: "computer-remove-cancel" }) }, tr("settings.computer.remove.cancel")),
		),
	);
}

/** The step's name in the list; the raw error (`electron: EBUSY…`) is under Details, not inline (SA-T14-4). */
const problemLine = (tr: Tr, p: RemovalProblem): HTMLElement =>
	h("li", { "data-step": p.step }, h("span", {}, tr(`settings.computer.remove.problem.${p.step}`)), p.detail === "" ? null : h("details", {}, h("summary", {}, tr("settings.diagnostics.details")), h("pre", { class: "remove-detail" }, p.detail)));

/**
 * What did not finish. Only the files step is tried again (when the app closes); the others are named with a pointer to the guide, because the record that knew about them is gone. That sentence carries
 * the guide's button, whether or not an entry stays (SA-T14-6); the list of entries above has none then, so there is one button on the screen.
 */
function problemsBox(ctx: SettingsCtx, problems: readonly RemovalProblem[]): HTMLElement {
	const { tr } = ctx;
	const files = problems.some((p) => p.step === "files");
	const others = problems.some((p) => p.step !== "files");
	return h(
		"div",
		{ class: "refusal", id: "remove-problems" },
		h("p", {}, tr("settings.computer.remove.problemsTitle")),
		h("ul", { class: "remove-entries" }, ...problems.map((p) => problemLine(tr, p))),
		files ? h("p", { class: "note", "data-role": "retry-files" }, tr("settings.computer.remove.problemsLater")) : null,
		others ? h("p", { class: "note", "data-role": "see-guide" }, tr("settings.computer.remove.problemsGuide")) : null,
		others ? h("p", {}, h("button", { type: "button", id: "remove-guide-problems", onclick: () => ctx.act({ type: "computer-open-guide" }) }, tr("settings.computer.remove.guide"))) : null,
	);
}

function donePanel(ctx: SettingsCtx, result: RemovalResult): HTMLElement {
	const { tr } = ctx;
	// A files step that failed changes the head: the files are not all deleted, and the page must not say they are (SA-T14-4).
	const filesFailed = result.problems.some((p) => p.step === "files");
	// The problems box points to the guide in its own words and holds the one guide button; the list of entries that stay has it only when that box does not (SA-T14-6).
	const guideBelow = result.problems.some((p) => p.step !== "files");
	return h(
		"div",
		{ class: "panel", id: "remove-done-panel", "data-state": "done", "data-files": filesFailed ? "failed" : "deleted" },
		h("h3", { class: "remove-title" }, tr(filesFailed ? "settings.computer.remove.doneTitleFiles" : "settings.computer.remove.doneTitle")),
		h("p", { "data-role": "done-body" }, tr(filesFailed ? "settings.computer.remove.doneBodyFiles" : "settings.computer.remove.doneBody")),
		h("p", { "data-role": "kept" }, keptSentence(tr, result.workFolder, "settings.computer.remove.doneKept", "settings.computer.remove.doneKeptNone")),
		result.left.length === 0
			? h("p", { class: "note", "data-role": "leaves" }, tr("settings.computer.remove.leavesNone"))
			: h("div", { class: "finding", id: "remove-left" }, leftList(tr, result.left, tr("settings.computer.remove.leftTitle"), "leaves"), guideBelow ? null : h("p", {}, h("button", { type: "button", id: "remove-guide", onclick: () => ctx.act({ type: "computer-open-guide" }) }, tr("settings.computer.remove.guide")))),
		result.problems.length === 0 ? null : problemsBox(ctx, result.problems),
		h("p", { class: "note" }, tr("settings.computer.remove.uninstall")),
		h("div", { class: "update-buttons" }, h("button", { type: "button", id: "remove-quit", class: "primary", onclick: () => ctx.act({ type: "computer-quit" }) }, tr("settings.computer.remove.quit"))),
	);
}

function removePanel(ctx: SettingsCtx, state: RemoveState): Child[] {
	const { tr } = ctx;
	switch (state.phase) {
		case "idle":
			return [h("div", { class: "update-buttons" }, h("button", { type: "button", id: "remove-open", onclick: () => ctx.act({ type: "computer-remove-plan" }) }, tr("settings.computer.remove.button")))];
		case "planning":
			return [h("p", { class: "status", id: "remove-status" }, h("span", { class: "spinner", "aria-hidden": "true" }), tr("settings.computer.remove.planning"))];
		case "confirm":
			return [confirmPanel(ctx, state)];
		case "refused":
			return [
				h("div", { class: "refusal", id: "remove-refusal", "data-reason": state.reason }, h("p", {}, tr(`settings.computer.remove.refused.${state.reason}`)), state.detail === "" ? null : h("details", {}, h("summary", {}, tr("settings.diagnostics.details")), h("pre", {}, state.detail))),
				// Nothing to cancel after a refusal: the one action is to look again.
				h("div", { class: "update-buttons" }, h("button", { type: "button", id: "remove-retry", onclick: () => ctx.act({ type: "computer-remove-plan" }) }, tr("settings.computer.remove.retry"))),
			];
		case "working":
			return [h("p", { class: "status", id: "remove-status", "data-step": state.step }, h("span", { class: "spinner", "aria-hidden": "true" }), tr(`settings.computer.remove.working.${state.step}`))];
		case "stop-failed":
			return [
				h(
					"div",
					{ class: "refusal", id: "remove-refusal", "data-reason": "stop" },
					h("p", {}, tr("settings.computer.remove.stopFailed")),
					state.leftovers.length === 0 ? null : h("p", {}, tr("settings.computer.remove.stopFailedList")),
					state.leftovers.length === 0 ? null : h("ul", { class: "remove-entries" }, ...state.leftovers.map((l) => h("li", { "data-pid": l.pid }, tr("settings.computer.remove.leftover", { file: l.file, pid: l.pid })))),
				),
				h("div", { class: "update-buttons" }, h("button", { type: "button", id: "remove-retry", onclick: () => ctx.act({ type: "computer-remove-plan" }) }, tr("settings.computer.remove.button")), h("button", { type: "button", id: "remove-cancel", onclick: () => ctx.act({ type: "computer-remove-cancel" }) }, tr("settings.computer.remove.cancel"))),
			];
		case "busy":
			return [
				h("div", { class: "refusal", id: "remove-refusal", "data-reason": "busy" }, h("p", {}, tr("settings.computer.remove.busy"))),
				h("div", { class: "update-buttons" }, h("button", { type: "button", id: "remove-retry", onclick: () => ctx.act({ type: "computer-remove-plan" }) }, tr("settings.computer.remove.retry"))),
			];
		case "failed":
			return [
				h("div", { class: "refusal", id: "remove-refusal", "data-reason": "failed" }, h("p", {}, tr("settings.computer.remove.failed")), h("details", {}, h("summary", {}, tr("settings.diagnostics.details")), h("pre", {}, state.detail))),
				h("div", { class: "update-buttons" }, h("button", { type: "button", id: "remove-retry", onclick: () => ctx.act({ type: "computer-remove-plan" }) }, tr("settings.computer.remove.button")), h("button", { type: "button", id: "remove-cancel", onclick: () => ctx.act({ type: "computer-remove-cancel" }) }, tr("settings.computer.remove.cancel"))),
			];
		case "done":
			return [donePanel(ctx, state.result)];
	}
}

/** Keep awake, language, and the removal. Without a view (a page drawn before main answered) only the language shows. */
export function computer(ctx: SettingsCtx): HTMLElement {
	const view = ctx.view.computer;
	const language = h(
		"div",
		{ class: "language", role: "group", "aria-label": ctx.tr("settings.computer.language") },
		h("span", { class: "language-label" }, ctx.tr("settings.computer.language")),
		...(["en", "zh-TW"] as const).map((l) => h("button", { type: "button", class: "language-button", "data-locale": l, "aria-pressed": String(l === ctx.locale), onclick: () => ctx.act({ type: "set-locale", locale: l }) }, ctx.tr(l === "en" ? "language.en" : "language.zhTW"))),
	);
	if (view === undefined) return sectionBox(ctx, "computer", language);
	const busy = view.remove.phase === "working" || view.remove.phase === "done";
	// The language is saved in the data root, so it is not offered while the root is being deleted.
	return sectionBox(
		ctx,
		"computer",
		busy ? null : language,
		h(
			"div",
			{ class: "panel", id: "keep-awake-panel" },
			h("label", { class: "check" }, h("input", { type: "checkbox", id: "keep-awake", checked: view.keepAwake, disabled: busy, onchange: (event: Event) => ctx.act({ type: "computer-keep-awake", on: (event.target as HTMLInputElement).checked }) }), h("span", {}, ctx.tr("settings.computer.keepAwake.label"))),
			h("p", { class: "note" }, ctx.tr("settings.computer.keepAwake.hint")),
		),
		h("div", { class: "panel", id: "remove-panel", "data-state": view.remove.phase }, h("h2", {}, ctx.tr("settings.computer.remove.heading")), h("p", { class: "note" }, ctx.tr("settings.computer.remove.lead")), ...removePanel(ctx, view.remove)),
	);
}
