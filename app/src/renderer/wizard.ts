import type { Locale } from "../shared/locale.ts";
import type { WizardView } from "../shared/wizard.ts";
import { clear, h } from "./dom.ts";
import { catalogs, t } from "./i18n/index.ts";
import { makeCtx, type Ctx } from "./wizard/common.ts";
import { done, launching } from "./wizard/done.ts";
import { folder } from "./wizard/folder.ts";
import { install } from "./wizard/install.ts";
import { claude, hosts, linear } from "./wizard/later.ts";
import { recipe } from "./wizard/recipe.ts";
import { start } from "./wizard/start.ts";
import { trust } from "./wizard/trust.ts";
import { welcome } from "./wizard/welcome.ts";

// The wizard page of the shell view (spec: The wizard, First run). Main sends the whole view whenever it changes and this page words it from the catalog and draws the step; the page keeps no
// state of its own beyond what the PM is typing. Every request goes back to main as a typed action, and main ignores one that is out of turn.

const shell = window.sbdShell;
let locale: Locale = shell?.locale ?? "en";
let view: WizardView | null = null;

const byId = (id: string): HTMLElement => {
	const el = document.getElementById(id);
	if (el === null) throw new Error(`wizard.html has no #${id}`);
	return el;
};
const root = byId("step");
const header = byId("header");

const STEPS: Record<string, (ctx: Ctx) => HTMLElement> = { welcome, recipe, trust, folder, install, start, claude, hosts, linear, done, launching };

function draw(): void {
	document.documentElement.lang = locale;
	document.title = catalogs[locale].app.name;
	if (view === null) return;
	const ctx = makeCtx(view, locale, (action) => void shell?.wizardAct(action));
	const render = STEPS[view.step] ?? welcome;
	const index = view.steps.indexOf(view.step as never);
	document.body.dataset.step = view.step;
	clear(header);
	header.append(
		h("span", { class: "badge dev-badge", id: "dev-badge", hidden: !view.dev }, t(locale, "welcome.devBuild")),
		h("span", { class: "progress", id: "progress" }, index >= 0 ? ctx.tr("steps.label", { n: index + 1, total: view.steps.length }) : ""),
		h(
			"span",
			{ class: "language", role: "group", "aria-label": t(locale, "welcome.languageLabel") },
			...(["en", "zh-TW"] as const).map((l) =>
				h("button", { type: "button", class: "language-button", "data-locale": l, "aria-pressed": String(l === locale), onclick: () => void shell?.wizardAct({ type: "set-locale", locale: l }) }, t(locale, l === "en" ? "language.en" : "language.zhTW")),
			),
		),
	);
	clear(root);
	root.append(render(ctx));
}

if (shell) {
	shell.onLocale((next) => {
		locale = next;
		draw();
	});
	shell.onWizard((next) => {
		view = next;
		locale = next.locale;
		draw();
	});
	void shell.wizardState().then((first) => {
		view = first;
		locale = first.locale;
		draw();
	});
}
draw();
