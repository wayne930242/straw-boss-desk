import type { Locale } from "../shared/locale.ts";
import type { WizardView } from "../shared/wizard.ts";
import { carryPasswords, clear, h, restorePasswords } from "./dom.ts";
import { catalogs, t } from "./i18n/index.ts";
import { announcementParts, newParts } from "./wizard/announce.ts";
import { makeCtx, type Ctx } from "./wizard/common.ts";
import { done, launching } from "./wizard/done.ts";
import { folder } from "./wizard/folder.ts";
import { install } from "./wizard/install.ts";
import { hosts } from "./wizard/hosts.ts";
import { claude } from "./wizard/claude.ts";
import { linear } from "./wizard/linear.ts";
import { projects } from "./wizard/projects.ts";
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
const announce = byId("announce");
let spoken: string[] = [];
let shownStep = "";

const STEPS: Record<string, (ctx: Ctx) => HTMLElement> = { welcome, recipe, trust, folder, install, start, claude, hosts, linear, projects, done, launching };

/** The element the PM is on, by something that survives a redraw: its id, or the language it switches to. */
function focusKey(): string | null {
	const el = document.activeElement;
	if (el === null || el === document.body || !(root.contains(el) || header.contains(el))) return null;
	if (el.id !== "") return `#${el.id}`;
	const locale = el.getAttribute("data-locale");
	return locale === null ? null : `[data-locale="${locale}"]`;
}

function draw(): void {
	document.documentElement.lang = locale;
	document.title = catalogs[locale].app.name;
	if (view === null) return;
	const ctx = makeCtx(view, locale, (action) => void shell?.wizardAct(action));
	const render = STEPS[view.step] ?? welcome;
	const index = view.steps.indexOf(view.step as never);
	const keep = focusKey();
	const selection = document.activeElement instanceof HTMLInputElement ? [document.activeElement.selectionStart, document.activeElement.selectionEnd] : null;
	document.body.dataset.step = view.step;
	clear(header);
	header.append(
		h("span", { class: "brand" }, t(locale, "app.name")),
		h("span", { class: "badge dev-badge", id: "dev-badge", hidden: !view.dev }, t(locale, "welcome.devBuild")),
		h("span", { class: "progress", id: "progress" }, index >= 0 ? ctx.tr("steps.label", { n: index + 1, total: view.steps.length }) : ""),
		h("span", { class: "track", "aria-hidden": "true" }, ...view.steps.map((_, i) => h("span", { class: "seg", "data-state": i < index ? "done" : i === index ? "current" : "todo" }))),
		h(
			"span",
			{ class: "language", role: "group", "aria-label": t(locale, "welcome.languageLabel") },
			...(["en", "zh-TW"] as const).map((l) =>
				h("button", { type: "button", class: "language-button", "data-locale": l, "aria-pressed": String(l === locale), onclick: () => void shell?.wizardAct({ type: "set-locale", locale: l }) }, t(locale, l === "en" ? "language.en" : "language.zhTW")),
			),
		),
	);
	// A token being typed survives the redraw: carried in a local, put back, and never kept anywhere.
	const typed = carryPasswords(root);
	clear(root);
	const step = render(ctx);
	root.append(step);
	restorePasswords(root, typed);
	// Focus stays where the PM was; a new step starts at its heading.
	const target = keep === null ? null : document.querySelector<HTMLElement>(keep);
	if (view.step !== shownStep) {
		const heading = step.querySelector<HTMLElement>("h1");
		heading?.setAttribute("tabindex", "-1");
		if (keep !== null || shownStep === "") heading?.focus({ preventScroll: true });
	} else if (target !== null) {
		target.focus({ preventScroll: true });
		if (target instanceof HTMLInputElement && selection !== null) target.setSelectionRange(selection[0] ?? null, selection[1] ?? null);
	}
	shownStep = view.step;
	// A screen reader hears what changed, not the step again.
	const parts = announcementParts(ctx);
	const text = newParts(locale, spoken, parts);
	spoken = parts;
	if (text !== "") announce.textContent = text;
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
