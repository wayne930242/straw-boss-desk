import { h } from "../dom.ts";
import type { Ctx } from "./common.ts";
import { trOr } from "./common.ts";

// What the PM typed in "I have no recipe" survives a redraw (a refusal redraws the step).
const draft = { github: true, gitlabHost: "" };

/** The size past which a dropped file is not even read: the validator's own limit is 256 KB, so anything near it is refused by the validator with its rule. */
const MAX_READ_BYTES = 300 * 1024;

/** Step 2: drop or choose `<id>.strawboss.json`, or say which code hosts are used. A refusal names the field and the rule, never the value. */
export function recipe(ctx: Ctx): HTMLElement {
	const refused = ctx.view.recipe.refused;
	// The drop zone is also a button: Enter or Space opens the file dialog, as Choose does (T9-F004).
	const drop = h("div", { class: "drop", id: "recipe-drop", tabindex: 0, role: "button" }, ctx.tr("recipe.drop"));
	drop.addEventListener("keydown", (e) => {
		if (e.key !== "Enter" && e.key !== " ") return;
		e.preventDefault();
		ctx.act({ type: "choose-recipe-file" });
	});
	drop.addEventListener("click", () => ctx.act({ type: "choose-recipe-file" }));
	drop.addEventListener("dragover", (e) => {
		e.preventDefault();
		drop.classList.add("over");
	});
	drop.addEventListener("dragleave", () => drop.classList.remove("over"));
	drop.addEventListener("drop", (e) => {
		e.preventDefault();
		drop.classList.remove("over");
		const file = e.dataTransfer?.files[0];
		if (file === undefined) return;
		if (file.size > MAX_READ_BYTES) {
			ctx.act({ type: "recipe-text", name: file.name, text: "" });
			return;
		}
		void file.text().then((text) => ctx.act({ type: "recipe-text", name: file.name, text }));
	});
	const github = h("input", { type: "checkbox", id: "none-github", ...(draft.github ? { checked: true } : {}), onchange: (e) => (draft.github = (e.target as HTMLInputElement).checked) });
	const gitlab = h("input", { type: "text", id: "none-gitlab", value: draft.gitlabHost, placeholder: ctx.tr("recipe.gitlabPlaceholder"), autocomplete: "off", spellcheck: "false", oninput: (e) => (draft.gitlabHost = (e.target as HTMLInputElement).value) });
	return h(
		"div",
		{ class: "step", "data-step": "recipe" },
		h("h1", {}, ctx.tr("recipe.title")),
		h("p", { class: "lead" }, ctx.tr("recipe.lead")),
		drop,
		h("div", { class: "actions" }, h("button", { type: "button", id: "recipe-choose", class: "primary", onclick: () => ctx.act({ type: "choose-recipe-file" }) }, ctx.tr("recipe.choose"))),
		refused.length === 0
			? null
			: h(
					"div",
					{ class: "refusal", id: "recipe-refused" },
					h("h2", {}, ctx.tr("recipe.refusedTitle")),
					h("p", {}, ctx.tr("recipe.refusedLead")),
					h(
						"table",
						{},
						h("thead", {}, h("tr", {}, h("th", {}, ctx.tr("recipe.field")), h("th", {}, ctx.tr("recipe.rule")), h("th", {}, ctx.tr("recipe.explanation")))),
						h(
							"tbody",
							{},
							...refused.map((r) => h("tr", {}, h("td", { class: "field" }, r.field), h("td", { class: "rule" }, r.rule), h("td", {}, trOr(ctx, `recipe.rules.${r.rule}`, "recipe.rules.other")))),
						),
					),
				),
		h(
			"div",
			{ class: "panel none" },
			h("h2", {}, ctx.tr("recipe.noneTitle")),
			h("p", { class: "note" }, ctx.tr("recipe.noneLead")),
			h("label", { class: "check" }, github, ctx.tr("recipe.github")),
			h("label", { class: "field-label" }, ctx.tr("recipe.gitlab"), gitlab),
			h("div", { class: "actions" }, h("button", { type: "button", id: "recipe-none", onclick: () => ctx.act({ type: "no-recipe", github: draft.github, gitlabHost: draft.gitlabHost }) }, ctx.tr("recipe.useNone"))),
		),
	);
}
