import { h } from "../dom.ts";
import { sectionBox, soon, type SettingsCtx } from "./common.ts";

/** Team recipe (task 12 fills updates and Replace): the recipe in use. */
export function recipe(ctx: SettingsCtx): HTMLElement {
	const r = ctx.view.recipe;
	return sectionBox(ctx, "recipe", h("p", { id: "recipe-current" }, r === null ? ctx.tr("settings.recipe.none") : ctx.tr("settings.recipe.current", { name: r.name, version: r.version })), soon(ctx));
}
