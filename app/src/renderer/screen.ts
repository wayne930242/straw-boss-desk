import type { ShellState } from "../shared/shell-state.ts";
import type { Locale } from "../shared/locale.ts";
import { catalogs, t } from "./i18n/index.ts";

// The runtime page of the shell view (spec: Runtime supervisor, Following the GUI; Crash and sleep): a small notice over the GUI while the stack restarts, or a whole screen when the GUI
// was stopped or a start failed, with **Start** or **Try again**. Main sends a state and this page words it from the catalog; it holds no logic of its own beyond that.

const shell = window.sbdShell;
const locale: Locale = shell?.locale ?? "en";

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

const BANNER_KEY = { restarting: "banner.restarting", "address-changed": "banner.addressChanged", starting: "banner.starting" } as const;

/** The catalog's sentence for a failure kind; a kind this build does not know reads as `other`. */
function failureSentence(kind: string, pid: number | undefined): string {
	const sentences = catalogs[locale].start.failure as Record<string, string>;
	const text = sentences[kind] ?? t(locale, "start.failure.other");
	return pid === undefined ? text : text.replaceAll("{pid}", String(pid));
}

function render(state: ShellState): void {
	document.documentElement.lang = locale;
	document.title = catalogs[locale].app.name;
	document.body.dataset.mode = state.mode;
	strip.hidden = state.mode !== "banner";
	card.hidden = state.mode !== "screen";
	starting.hidden = true;
	retry.disabled = false;
	for (const el of document.querySelectorAll<HTMLElement>("[data-i18n]")) el.textContent = t(locale, el.dataset.i18n ?? "");
	if (state.mode === "banner") {
		stripText.textContent = t(locale, BANNER_KEY[state.banner]);
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
		leftovers.replaceChildren(...(failure.leftovers ?? []).map((l) => Object.assign(document.createElement("li"), { textContent: `${l.file} (${l.pid})` })));
		leftovers.hidden = (failure.leftovers?.length ?? 0) === 0;
		reason.textContent = failure.reason;
		details.hidden = failure.reason === "";
		return;
	}
	delete card.dataset.failureKind;
	const key = state.screen === "gui-stopped" ? "screen.guiStopped" : "screen.serverStopped";
	title.textContent = t(locale, `${key}.title`);
	sentence.textContent = t(locale, `${key}.body`);
	retry.textContent = t(locale, "screen.start");
	leftovers.hidden = true;
	details.hidden = true;
}

retry.addEventListener("click", () => {
	retry.disabled = true;
	starting.hidden = false;
	shell?.act("retry");
});

if (shell) {
	shell.onState(render);
	void shell.state().then(render);
} else {
	render({ mode: "none" });
}
