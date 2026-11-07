import type { ProjectFailure, ProjectRow, ProjectsView } from "../../shared/projects.ts";
import { listParts, type Locale } from "../../shared/locale.ts";
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
	if (row.delivery !== undefined) out.push(ctx.tr(`projects.done.delivery.${row.delivery}`, { repository: row.label }));
	return out;
}

/** Marks where the list of paths goes in the sentence, until the sentence is split around it. */
const LIST_SLOT = "\u0001";

/** Text, with a break offered after each 「、」 (the ideographic comma between paths); the rest is left to the browser. */
const textNodes = (text: string): Array<string | HTMLElement> => text.split(/(?<=、)/).flatMap((part) => (part.endsWith("、") ? [part, h("wbr")] : part === "" ? [] : [part]));

/**
 * A path as one unit that wraps after a 「/」, and breaks inside a name only when that one name is wider than the card (SA-T12-6). Each name between slashes is an unbreakable box (`.path-name`), so a
 * hyphen inside a name that fits on a line is never a place to break; a name wider than the card still breaks, since there is nowhere else to break it.
 */
function pathNode(path: string): HTMLElement {
	const parts = path.split(/(?<=\/)/);
	return h("span", { class: "path-item" }, ...parts.flatMap((part, i) => [h("span", { class: "path-name" }, part), ...(i < parts.length - 1 ? [h("wbr")] : [])]));
}

/**
 * The sentence about links Windows could not make: the paths, at most ten, then how many more. Each path is its own node, and a break is offered after each 「/」 and each separator between paths.
 * The list is joined from the real paths (the spaces beside 「和」 depend on the characters next to it, CIN-F005) and read back in pieces, not searched for the paths.
 */
function linksNode(ctx: RowsCtx, row: ProjectRow, id: string): HTMLElement | null {
	if (row.links === null || row.links.paths.length === 0) return null;
	const { paths, more } = row.links;
	const items = more > 0 ? [...paths, ctx.tr("projects.linksMore", { n: more })] : paths;
	const [before = "", after = ""] = ctx.tr("projects.links", { repository: row.label, paths: LIST_SLOT }).split(LIST_SLOT);
	// The items come back in the order they were given: the first `paths.length` elements are the paths, a last one is the "and N more" text.
	let element = 0;
	const list = listParts(ctx.locale, items).flatMap((part) => {
		if (part.type !== "element") return textNodes(part.value);
		const path = paths[element++];
		return path === undefined ? textNodes(part.value) : [pathNode(path)];
	});
	const children = [...textNodes(before), ...list, ...textNodes(after)];
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
