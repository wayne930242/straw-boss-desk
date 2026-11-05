import type { ProjectFailure, ProjectRow, ProjectsView } from "../../shared/projects.ts";
import { listOf, type Locale } from "../../shared/locale.ts";
import { h } from "../dom.ts";

// One card per repository (spec: First run, step 10; Settings, Team recipe), shared by the wizard's projects step and settings' Team recipe card. Each card has ids of its own (the row's position
// in the list) and `data-role`s, one row of actions with the primary one first, and the sentences are the catalog's: main sends phases, causes and values (`shared/projects.ts`).

export interface RowsCtx {
	locale: Locale;
	tr(key: string, vars?: Readonly<Record<string, string | number>>): string;
	retry(folder: string): void;
}

const BADGE_CLASS = { waiting: "badge-waiting", working: "badge-working", trust: "badge-warn", done: "badge-done", failed: "badge-failed" } as const;

/** The catalog key of the sentence for a failure, below `projects.failure`. */
export function failureKey(failure: ProjectFailure): string {
	switch (failure.kind) {
		case "clone":
			return `clone.${failure.cause}`;
		case "git":
			return `git.${failure.step}`;
		case "open":
			return `open.${failure.cause}`;
		default:
			return failure.kind;
	}
}

export const failureSentence = (ctx: RowsCtx, row: ProjectRow, failure: ProjectFailure): string =>
	ctx.tr(`projects.failure.${failureKey(failure)}`, {
		repository: row.label,
		folder: row.folder,
		branch: failure.kind === "branch-missing" ? failure.branch : (row.defaultBranch ?? ""),
		host: failure.kind === "clone" && failure.cause === "network-private" ? failure.host : row.host,
	});

function doneSentences(ctx: RowsCtx, row: ProjectRow): string[] {
	const out: string[] = [];
	if (!row.opened) {
		if (row.defaultBranch !== null) out.push(ctx.tr("projects.done.headOnly", { branch: row.defaultBranch }));
		return out;
	}
	out.push(ctx.tr(row.reused ? "projects.done.reused" : "projects.done.cloned", { folder: row.folder }));
	if (row.defaultBranch !== null) out.push(ctx.tr("projects.done.branch", { branch: row.defaultBranch }));
	return out;
}

/** Marks where a path goes in the sentence, until the sentence is split around it. */
const PATH_MARK = /\u0001(\d+)\u0001/;

/** A path as one unit that wraps only after a 「/」, so a line break never falls inside a name (SA-T12-6); a segment wider than the card still breaks, since there is nowhere else to break it. */
function pathNode(path: string): HTMLElement {
	const parts = path.split(/(?<=\/)/);
	return h("span", { class: "path-item" }, ...parts.flatMap((part, i) => (i < parts.length - 1 ? [part, h("wbr")] : [part])));
}

/** The sentence about links Windows could not make: the paths, at most ten, then how many more. Each path is its own node, and a break is offered after each 「/」 and each separator between paths. */
function linksNode(ctx: RowsCtx, row: ProjectRow, id: string): HTMLElement | null {
	if (row.links === null || row.links.paths.length === 0) return null;
	const marks = row.links.paths.map((_, i) => `\u0001${i}\u0001`);
	const items = row.links.more > 0 ? [...marks, ctx.tr("projects.linksMore", { n: row.links.more })] : marks;
	const text = ctx.tr("projects.links", { repository: row.label, paths: listOf(ctx.locale, items) });
	const children = text.split(new RegExp(PATH_MARK.source, "g")).flatMap((piece, i) => {
		// `split` with one group alternates text and the captured index.
		if (i % 2 === 1) return [pathNode(row.links?.paths[Number(piece)] ?? "")];
		// The ideographic comma between paths is a break the line may take; the text around it is left to the browser.
		return piece.split(/(?<=、)/).flatMap((part) => (part.endsWith("、") ? [part, h("wbr")] : [part]));
	});
	return h("p", { class: "finding update-note", id, "data-role": "links" }, ...children);
}

export function projectCard(ctx: RowsCtx, row: ProjectRow, index: number): HTMLElement {
	const retry =
		row.phase === "failed"
			? h("button", { type: "button", id: `project-${index}-retry`, class: "primary", onclick: () => ctx.retry(row.folder) }, ctx.tr("projects.retry"))
			: null;
	const failure = row.phase === "failed" && row.failure !== null ? failureSentence(ctx, row, row.failure) : null;
	const sentence =
		row.phase === "working"
			? ctx.tr(`projects.step.${row.step ?? "cloning"}`)
			: row.phase === "trust"
				? ctx.tr("projects.trust")
				: row.phase === "done"
					? doneSentences(ctx, row).join(" ")
					: failure;
	const links = linksNode(ctx, row, `project-${index}-links`);
	return h(
		"li",
		{ class: "project-card", "data-role": "project", "data-folder": row.folder, "data-state": row.phase, ...(row.failure !== null ? { "data-reason": failureKey(row.failure) } : {}) },
		h(
			"div",
			{ class: "update-head" },
			h("span", { class: "update-name" }, row.label),
			h("span", { class: "update-version mono", id: `project-${index}-folder` }, ctx.tr("projects.target", { folder: row.folder })),
			h("span", { class: `badge ${BADGE_CLASS[row.phase]}`, "data-badge": row.phase, id: `project-${index}-badge` }, ctx.tr(`projects.badge.${row.phase}`)),
			retry === null ? null : h("span", { class: "update-buttons" }, retry),
		),
		sentence === null || sentence === "" ? null : h("p", { class: row.phase === "failed" ? "problem" : "note update-note", id: `project-${index}-note` }, sentence),
		links,
		row.phase === "failed" && row.detail !== ""
			? h("details", { class: "update-details" }, h("summary", {}, ctx.tr("projects.details")), h("p", { class: "note update-detail", id: `project-${index}-detail` }, row.detail))
			: null,
	);
}

export const projectList = (ctx: RowsCtx, view: ProjectsView, id: string): HTMLElement =>
	h("ul", { class: "accounts update-cards", id }, ...view.rows.map((row, i) => projectCard(ctx, row, i)));
