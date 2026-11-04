import type { ShellState } from "../shared/shell-state.ts";
import { primaryAction, showsRepair } from "../shared/failure-action.ts";
import { currentLocale, listOf, type Locale } from "../shared/locale.ts";
import type { ShellNotice } from "../shared/wizard.ts";
import { h } from "./dom.ts";
import { catalogs, format, t } from "./i18n/index.ts";

// The runtime page of the shell view (spec: Runtime supervisor, Following the GUI; Crash and sleep): a small notice over the GUI while the stack restarts, or a whole screen when the GUI
// was stopped or a start failed, with **Start** or **Try again**. Main sends a state and this page words it from the catalog; it holds no logic of its own beyond that.

const shell = window.sbdShell;
let locale: Locale = shell?.locale ?? "en";
let last: ShellState = { mode: "none" };

const byId = <T extends HTMLElement>(id: string): T => {
	const el = document.getElementById(id);
	if (el === null) throw new Error(`screen.html has no #${id}`);
	return el as T;
};
const strip = byId<HTMLDivElement>("strip");
const stripText = byId<HTMLSpanElement>("strip-text");
const card = byId<HTMLElement>("card");
const title = byId<HTMLHeadingElement>("title");
const sentence = byId<HTMLParagraphElement>("sentence");
const leftovers = byId<HTMLUListElement>("leftovers");
const starting = byId<HTMLParagraphElement>("starting");
const retry = byId<HTMLButtonElement>("retry");
const details = byId<HTMLDetailsElement>("details");
const reason = byId<HTMLPreElement>("reason");
const repair = byId<HTMLButtonElement>("repair");
const repairing = byId<HTMLParagraphElement>("repairing");
const notices = byId<HTMLDivElement>("notices");

const BANNER_KEY = { restarting: "banner.restarting", "address-changed": "banner.addressChanged", starting: "banner.starting" } as const;

/** The catalog's sentence for a failure kind; a kind this build does not know reads as `other`. */
function failureSentence(kind: string, pid: number | undefined): string {
	const sentences = catalogs[locale].start.failure as Record<string, string>;
	const text = sentences[kind] ?? t(locale, "start.failure.other");
	return pid === undefined ? text : text.replaceAll("{pid}", String(pid));
}

const LATER_KEY = { claude: "later.claude", github: "later.github", gitlab: "later.gitlab", linear: "later.linear" } as const;

/** One row per notice: the WSL sentence with its Details and Dismiss, one row for every sign-in put off with a Settings button, and the new version of the app with Restart to update (or Updates). */
function noticeRow(notice: ShellNotice): HTMLElement {
	if (notice.id === "wsl") {
		const detail = h("pre", { hidden: true }, format(t(locale, "welcome.wslPath"), { path: notice.path }));
		return h(
			"div",
			{ class: "notice", "data-notice": "wsl", role: "status" },
			h("span", { class: "notice-text" }, t(locale, "welcome.wsl")),
			h("button", { type: "button", id: "wsl-details", onclick: () => (detail.hidden = !detail.hidden) }, t(locale, "later.wslDetails")),
			h("button", { type: "button", id: "wsl-dismiss", onclick: () => shell?.act({ type: "dismiss-notice", id: "wsl" }) }, t(locale, "later.dismiss")),
			detail,
		);
	}
	if (notice.id === "update") {
		const restart = notice.action === "restart";
		return h(
			"div",
			{ class: "notice", "data-notice": "update", role: "status" },
			h("span", { class: "notice-text" }, format(t(locale, restart ? "updateNotice.ready" : "updateNotice.available"), { version: notice.version })),
			restart
				? h("button", { type: "button", id: "update-banner-restart", class: "primary", onclick: () => shell?.act({ type: "update-restart" }) }, t(locale, "updateNotice.restart"))
				: h("button", { type: "button", id: "update-banner-open", onclick: () => shell?.act({ type: "open-settings", section: "updates" }) }, t(locale, "updateNotice.open")),
		);
	}
	const items = listOf(locale, notice.items.map((i) => format(t(locale, LATER_KEY[i.item]), "host" in i ? { host: i.host } : {})));
	return h(
		"div",
		{ class: "notice", "data-notice": "later", role: "status" },
		h("span", { class: "notice-text" }, format(t(locale, "later.banner"), { items })),
		h("button", { type: "button", id: "open-settings", onclick: () => shell?.act({ type: "open-settings", section: "accounts" }) }, t(locale, "later.settings")),
	);
}

function render(state: ShellState): void {
	last = state;
	document.documentElement.lang = locale;
	document.title = catalogs[locale].app.name;
	document.body.dataset.mode = state.mode;
	strip.hidden = state.mode !== "banner";
	card.hidden = state.mode !== "screen";
	notices.hidden = state.mode !== "notices";
	starting.hidden = true;
	repairing.hidden = true;
	retry.disabled = false;
	repair.disabled = false;
	repair.hidden = true;
	repair.textContent = t(locale, "start.repair");
	for (const el of document.querySelectorAll<HTMLElement>("[data-i18n]")) el.textContent = t(locale, el.dataset.i18n ?? "");
	if (state.mode === "banner") {
		stripText.textContent = t(locale, BANNER_KEY[state.banner]);
		return;
	}
	if (state.mode === "notices") {
		notices.replaceChildren(...state.notices.map(noticeRow));
		return;
	}
	if (state.mode !== "screen") return;
	card.dataset.screen = state.screen;
	if (state.screen === "failed") {
		const { failure } = state;
		card.dataset.failureKind = failure.kind;
		const stopped = failure.kind === "sb-unverified" || (failure.leftovers?.length ?? 0) > 0;
		title.textContent = t(locale, stopped ? "start.stopTitle" : "start.title");
		sentence.textContent = failureSentence(failure.kind, failure.pid);
		retry.textContent = t(locale, "start.retry");
		leftovers.replaceChildren(...(failure.leftovers ?? []).map((l) => Object.assign(document.createElement("li"), { textContent: format(t(locale, "start.leftover"), { file: l.file, pid: l.pid }) })));
		leftovers.hidden = (failure.leftovers?.length ?? 0) === 0;
		reason.textContent = failure.reason;
		details.hidden = failure.reason === "";
		repair.hidden = !showsRepair(failure);
		// The action the sentence names is the primary button (SA-10).
		const repairFirst = primaryAction(failure) === "repair";
		repair.classList.toggle("primary", repairFirst);
		retry.classList.toggle("primary", !repairFirst);
		return;
	}
	delete card.dataset.failureKind;
	retry.classList.add("primary");
	repair.classList.remove("primary");
	const key = state.screen === "gui-stopped" ? "screen.guiStopped" : "screen.serverStopped";
	title.textContent = t(locale, `${key}.title`);
	sentence.textContent = t(locale, `${key}.body`);
	retry.textContent = t(locale, "screen.start");
	leftovers.hidden = true;
	details.hidden = true;
}

// The window gives the notice strip the height this page measures (it clamps it): only the page knows how tall its rows are.
new ResizeObserver(() => {
	if (!notices.hidden) shell?.act({ type: "strip-height", height: Math.ceil(notices.getBoundingClientRect().height) });
}).observe(notices);

repair.addEventListener("click", () => {
	repair.disabled = true;
	retry.disabled = true;
	repairing.hidden = false;
	shell?.act("repair");
});

retry.addEventListener("click", () => {
	retry.disabled = true;
	starting.hidden = false;
	shell?.act("retry");
});

if (shell) {
	shell.onLocale((next) => {
		locale = next;
		render(last);
	});
	shell.onState(render);
	// The window's first language is in the preload argument; the PM may have changed it since (in the wizard or in settings), so the first draw asks main (T9-F003).
	void Promise.all([currentLocale(shell), shell.state()]).then(([now, state]) => {
		locale = now;
		render(state);
	});
} else {
	render({ mode: "none" });
}
