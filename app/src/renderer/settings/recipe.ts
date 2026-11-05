import type { RecipeChange, RecipeCardState, RecipeCardView } from "../../shared/recipe-update.ts";
import { h } from "../dom.ts";
import { projectList } from "../projects/rows.ts";
import { stageLabel } from "../wizard/install.ts";
import { sectionBox, type SettingsCtx } from "./common.ts";

// Team recipe (spec: Settings, Team recipe; team-profile section 5). Three cards, one per item, each with ids of its own and one row of actions with the primary one first: the recipe in use, the
// update (the daily check, an offer with its change list, Apply and Keep), and the projects it sets up. The words are the catalog's; main sends phases, reasons and values (`shared/recipe-update.ts`).

type Tr = SettingsCtx["tr"];

const BADGE_CLASS = { working: "badge-working", done: "badge-done", failed: "badge-failed", warn: "badge-warn", quiet: "badge-blocked" } as const;
type BadgeKind = keyof typeof BADGE_CLASS;

const badge = (cls: BadgeKind, phase: string, text: string): HTMLElement => h("span", { class: `badge ${BADGE_CLASS[cls]}`, "data-badge": phase }, text);

const button = (id: string, text: string, onclick: () => void, options: { primary?: boolean; disabled?: boolean } = {}): HTMLElement =>
	h("button", { type: "button", id, class: options.primary === true ? "primary" : null, disabled: options.disabled === true, onclick }, text);

const row = (...buttons: Array<HTMLElement | null>): HTMLElement | null => {
	const present = buttons.filter((b): b is HTMLElement => b !== null);
	return present.length === 0 ? null : h("span", { class: "update-buttons" }, ...present);
};

const card = (role: string, state: string, head: Array<HTMLElement | null>, ...below: Array<HTMLElement | null>): HTMLElement =>
	h("li", { class: "update-card", "data-role": role, "data-state": state }, h("div", { class: "update-head" }, ...head), ...below);

function details(tr: Tr, raw: string | undefined): HTMLElement | null {
	if (raw === undefined || raw === "") return null;
	return h("details", { class: "update-details" }, h("summary", {}, tr("settings.recipe.details")), h("p", { class: "note update-detail" }, raw));
}

// ---- the change list ---------------------------------------------------------------------------------------------------

/** One change as a list item: the sentence, and for new team instructions the text in full beneath it. */
function changeItem(ctx: SettingsCtx, change: RecipeChange): HTMLElement {
	const tr = ctx.tr;
	const none = tr("settings.recipe.change.none");
	const key = (name: string, vars?: Record<string, string | number>): string => tr(`settings.recipe.change.${name}`, vars);
	let text: string;
	switch (change.kind) {
		case "name":
		case "version":
			text = key(change.kind, { from: change.from, to: change.to });
			break;
		case "forge-added":
			text = key("forge-added", { tool: tr(`forge.tool.${change.forge}`), host: change.host });
			break;
		case "forge-removed":
			text = key("forge-removed", { host: change.host });
			break;
		case "repo-added":
			text = change.defaultBranch === null ? key("repo-added", { label: change.label, host: change.host, folder: change.folder }) : key("repo-added-branch", { label: change.label, host: change.host, folder: change.folder, branch: change.defaultBranch });
			break;
		case "repo-removed":
			text = key("repo-removed", { folder: change.folder });
			break;
		case "repo-branch":
			// A branch change that starts or ends at "the code host's default" is one sentence of its own: built from a fragment it reads as broken Chinese (SA-T12-3).
			text = change.from === null ? key("repo-branch-fromDefault", { folder: change.folder, to: change.to ?? "" }) : change.to === null ? key("repo-branch-toDefault", { folder: change.folder, from: change.from }) : key("repo-branch", { folder: change.folder, from: change.from, to: change.to });
			break;
		case "repo-url":
			text = key("repo-url", { folder: change.folder, host: change.host });
			break;
		case "repo-label":
			text = key("repo-label", { folder: change.folder, from: change.from, to: change.to });
			break;
		case "relay":
			text = key("relay", { from: change.from ?? none, to: change.to ?? none });
			break;
		case "linear":
			text = key(change.to ? "linear-on" : "linear-off");
			break;
		case "tool-added":
			text = change.version === null ? key("tool-addedPlain", { name: change.name }) : key("tool-added", { name: change.name, version: change.version });
			break;
		case "tool-removed":
			text = key("tool-removed", { name: change.name });
			break;
		case "profile":
			text = key("profile", { from: change.from ?? none, to: change.to ?? none });
			break;
		case "package-added":
			text = key("package-added", { name: change.name, version: change.version });
			break;
		case "package-removed":
			text = key("package-removed", { name: change.name });
			break;
		case "package-changed":
			text = key("package-changed", { name: change.name, from: change.from, to: change.to });
			break;
		case "instructions":
			text = key(change.text === null ? "instructions-removed" : "instructions");
			break;
		case "update-host":
			text = key("update-host", { from: change.from ?? none, to: change.to ?? none });
			break;
	}
	return h("li", { "data-change": change.kind }, text, change.kind === "instructions" && change.text !== null ? h("pre", { class: "change-text" }, change.text) : null);
}

// ---- the sentences ----------------------------------------------------------------------------------------------------

function refusedSentence(ctx: SettingsCtx, state: Extract<RecipeCardState, { phase: "refused" }>): string {
	const tr = ctx.tr;
	if (state.reason === "fetch") {
		const reason = state.fetch ?? "network";
		if (reason === "status") return state.status === undefined ? tr("settings.recipe.fetch.statusPlain") : tr("settings.recipe.fetch.status", { status: state.status });
		return tr(`settings.recipe.fetch.${reason}`);
	}
	return tr(`settings.recipe.refused.${state.reason}`);
}

const BADGE_KEY: Record<RecipeCardState["phase"], string> = { idle: "idle", checking: "checking", offered: "offered", applying: "applying", applied: "applied", kept: "kept", refused: "refused", failed: "failed", error: "error" };
const BADGE: Record<RecipeCardState["phase"], BadgeKind> = { idle: "done", checking: "working", offered: "working", applying: "working", applied: "done", kept: "quiet", refused: "failed", failed: "warn", error: "failed" };

/** The label of the project whose Git or whose opening is on its way, or null. The update's install waits for a project copy (one job queue), and a busy refusal can come from a base still opening. */
function runningProject(view: RecipeCardView, steps: readonly string[]): string | null {
	const row = view.projects.rows.find((r) => r.phase === "working" && r.step !== null && steps.includes(r.step));
	return row?.label ?? null;
}

function sentence(ctx: SettingsCtx, view: RecipeCardView): string {
	const tr = ctx.tr;
	const state = view.state;
	switch (state.phase) {
		case "idle": {
			if (view.active !== null && view.active.updateHost === null) return tr("settings.recipe.noUpdates");
			return tr("settings.recipe.idle");
		}
		case "checking":
			return tr("settings.recipe.checking");
		case "offered":
			return tr(state.origin === "file" ? (state.replaces ? "settings.recipe.offeredReplace" : "settings.recipe.offeredFile") : state.replaces ? "settings.recipe.offeredReplace" : "settings.recipe.offered", { name: state.name, version: state.version });
		case "applying": {
			// The install runs after a project copy that is under way ends (they share one queue): until then the agents still run, and the sentence names the copy.
			const copying = state.step === "install" ? runningProject(view, ["cloning", "fetching", "head", "links"]) : null;
			return copying === null ? tr(`settings.recipe.applying.${state.step}`) : tr("settings.recipe.applying.waitCopy", { repository: copying });
		}
		case "applied":
			return tr("settings.recipe.applied", { version: state.version });
		case "kept":
			return tr("settings.recipe.kept", { version: state.version });
		case "refused":
			return refusedSentence(ctx, state);
		case "failed":
			return tr(state.restored ? "settings.recipe.failed" : "settings.recipe.failedPartly", { stage: stageLabel(ctx, state.stage) });
		case "error": {
			if (state.kind !== "busy") return tr("settings.recipe.errorOther");
			const running = runningProject(view, ["queued", "cloning", "fetching", "head", "links", "opening"]);
			return running === null ? tr("settings.recipe.errorBusy") : tr("settings.recipe.errorBusyProject", { repository: running });
		}
	}
}

// ---- the cards ---------------------------------------------------------------------------------------------------------

function currentCard(ctx: SettingsCtx, view: RecipeCardView): HTMLElement {
	const active = view.active;
	const busy = view.state.phase === "applying" || view.state.phase === "checking";
	// Replace is secondary while the update card beside it has the page's primary action (Apply or Check now); a recipe with no address to ask has none, so Replace is then the page's one (SA-T12-4).
	const updateHasPrimary = view.state.phase === "offered" || (active !== null && active.updateHost !== null);
	const replace = button("recipe-replace", ctx.tr("settings.recipe.replace"), () => ctx.act({ type: "recipe-replace" }), { primary: !updateHasPrimary, disabled: !view.enabled || busy });
	if (active === null) return card("recipe", "none", [h("span", { class: "update-name" }, ctx.tr("settings.recipe.card.name")), row(replace)], h("p", { class: "note update-note", id: "recipe-current" }, ctx.tr("settings.recipe.none")));
	const source = active.source.kind === "file" ? ctx.tr("settings.recipe.source.file", { fileName: active.source.fileName }) : ctx.tr("settings.recipe.source.url", { host: active.source.host });
	return card(
		"recipe",
		"active",
		[
			h("span", { class: "update-name", id: "recipe-name" }, active.name),
			h("span", { class: "update-version", id: "recipe-version" }, ctx.tr("settings.recipe.version", { version: active.version })),
			row(replace),
		],
		h("p", { class: "note update-note", id: "recipe-source" }, source),
	);
}

function updateCard(ctx: SettingsCtx, view: RecipeCardView): HTMLElement {
	const state = view.state;
	const offered = state.phase === "offered";
	const time = state.phase === "idle" && state.checkedAt !== null ? new Date(state.checkedAt).toLocaleTimeString(ctx.locale, { hour: "2-digit", minute: "2-digit" }) : null;
	const checkable = view.active !== null && view.active.updateHost !== null;
	const apply = offered ? button("recipe-apply", ctx.tr("settings.recipe.apply"), () => ctx.act({ type: "recipe-apply" }), { primary: true }) : null;
	const keep = offered ? button("recipe-keep", ctx.tr("settings.recipe.keep"), () => ctx.act({ type: "recipe-keep" })) : null;
	const check = !offered && checkable ? button("recipe-check", ctx.tr(state.phase === "checking" ? "settings.recipe.checkBusy" : "settings.recipe.check"), () => ctx.act({ type: "recipe-check" }), { primary: true, disabled: !view.enabled || state.phase === "checking" || state.phase === "applying" }) : null;
	return card(
		"update",
		state.phase,
		[h("span", { class: "update-name" }, ctx.tr("settings.recipe.card.updates")), badge(BADGE[state.phase], state.phase, ctx.tr(`settings.recipe.badge.${BADGE_KEY[state.phase]}`)), row(apply, keep, check)],
		h("p", { class: state.phase === "refused" || state.phase === "error" ? "problem" : "note update-note", id: "recipe-update-note", "data-reason": state.phase === "refused" ? (state.reason === "fetch" ? (state.fetch ?? "network") : state.reason) : state.phase === "failed" ? state.stage : null }, sentence(ctx, view)),
		time === null ? null : h("p", { class: "note update-note", id: "recipe-checked" }, ctx.tr("settings.recipe.checkedAt", { time })),
		state.phase === "idle" && time === null && checkable ? h("p", { class: "note update-note", id: "recipe-never" }, ctx.tr("settings.recipe.never")) : null,
		state.phase === "offered" ? h("p", { class: "note update-note", id: "recipe-install-note" }, ctx.tr("settings.recipe.installNote")) : null,
		state.phase === "refused" && state.reason === "invalid" && state.fields !== undefined && state.fields.length > 0
			? h(
					"table",
					{ id: "recipe-refusals" },
					h("thead", {}, h("tr", {}, h("th", {}, ctx.tr("settings.recipe.refused.field")), h("th", {}, ctx.tr("settings.recipe.refused.rule")))),
					h("tbody", {}, ...state.fields.map((f) => h("tr", {}, h("td", { class: "field" }, f.field), h("td", { class: "rule" }, f.rule)))),
				)
			: null,
		details(ctx.tr, state.phase === "error" ? state.detail : undefined),
		state.phase === "offered" && state.changes.length > 0
			? h("details", { class: "update-changes-box", id: "recipe-changes", open: true }, h("summary", {}, ctx.tr("settings.recipe.changes")), h("ul", { class: "update-changes" }, ...state.changes.map((c) => changeItem(ctx, c))))
			: null,
	);
}

export function recipe(ctx: SettingsCtx): HTMLElement {
	const view = ctx.view.recipeCard;
	if (view === undefined) {
		const r = ctx.view.recipe;
		return sectionBox(ctx, "recipe", h("p", { id: "recipe-current" }, r === null ? ctx.tr("settings.recipe.none") : ctx.tr("settings.recipe.current", { name: r.name, version: r.version })));
	}
	const projects = view.projects.rows.length === 0
		? h("p", { class: "note", id: "recipe-projects-none" }, ctx.tr("settings.recipe.projectsNone"))
		: projectList({ locale: ctx.locale, tr: ctx.tr, retry: (folder) => ctx.act({ type: "project-retry", folder }) }, view.projects, "recipe-projects");
	return sectionBox(ctx, "recipe", h("ul", { class: "accounts update-cards", id: "recipe-cards" }, currentCard(ctx, view), updateCard(ctx, view)), h("h2", { id: "recipe-projects-title" }, ctx.tr("settings.recipe.card.projects")), projects);
}
