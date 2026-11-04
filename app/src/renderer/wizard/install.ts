import type { InstallFailure, InstallView } from "../../shared/wizard.ts";
import { h } from "../dom.ts";
import type { Ctx } from "./common.ts";

let detailsOpen = false;

/** The plain label of an engine stage; a name the catalog does not know reads as "Step <name>". Package names show only under Details. */
export function stageLabel(ctx: Pick<Ctx, "tr">, name: string): string {
	const [head, rest] = name.split(":", 2);
	switch (head) {
		case "opt":
			return ctx.tr("install.stage.opt", { name: rest ?? "" });
		case "pkg":
			return ctx.tr("install.stage.pkg", { name: rest ?? "" });
		case "team-pkg":
			return ctx.tr("install.stage.team-pkg", { name: rest ?? "" });
		case "preflight":
		case "node":
		case "git":
		case "herdr":
		case "fd-rg":
		case "gh":
		case "glab":
		case "tool-paths":
		case "launchers":
		case "git-helpers":
		case "pi":
		case "pi-shim":
		case "profile":
		case "pi-settings":
		case "claude":
			return ctx.tr(`install.stage.${head}`);
		default:
			return ctx.tr("install.stage.other", { name });
	}
}

/** The category's sentence for a failed stage, in the catalog's words (the kit's sentences, Bootstrap engine: Logs and failures). */
export function failureSentence(ctx: Ctx, f: InstallFailure): string {
	const p = f.params;
	switch (f.category) {
		case "network":
			if (p.cause === "tls") return ctx.tr("install.failure.networkTls", { host: p.host ?? "" });
			if (p.cause === "path") return ctx.tr("install.failure.networkPath", { host: p.host ?? "" });
			return ctx.tr("install.failure.network", { host: p.host ?? "" });
		case "integrity":
			return ctx.tr("install.failure.integrity", { tool: p.tool ?? "" });
		case "registry":
			return ctx.tr("install.failure.registry", { what: p.what ?? "" });
		case "disk":
			return ctx.tr("install.failure.disk");
		case "locked":
			if (p.reason === "tools-running") return ctx.tr("install.failure.toolsRunning");
			return ctx.tr("install.failure.locked");
		case "other":
			if (p.reason === "package-may-load") return ctx.tr("install.failure.packageMayLoad", { name: p.name ?? "" });
			if (p.reason === "short-names") return ctx.tr("install.failure.shortNames", { name: p.name ?? "" });
			if (f.stage === "") return ctx.tr("install.failure.engine");
			return ctx.tr("install.failure.other", { stage: stageLabel(ctx, p.stage ?? f.stage) });
	}
}

/**
 * The plain line about what is going on: the one stage that works, or how many when several do at once (the downloads run three at a time, and an npm step beside them), so the line
 * never names one of several (SA-07). Read from the badges, which are what the list shows. Null when none works.
 */
export function nowLine(ctx: Ctx, i: InstallView): string | null {
	const working = i.stages.filter((s) => s.badge === "working");
	if (i.status !== "running" || working.length === 0) return null;
	const [only] = working;
	return working.length === 1 && only !== undefined ? ctx.tr("install.now", { stage: stageLabel(ctx, only.name) }) : ctx.tr("install.nowMany", { count: String(working.length) });
}

/** Step 5: the engine's stages as a list with a badge each, one plain line for the current action, **Details**, and **Try again** on a failure. */
export function install(ctx: Ctx): HTMLElement {
	const i = ctx.view.install;
	const failed = i.status === "failed";
	const now = nowLine(ctx, i);
	return h(
		"div",
		{ class: "step", "data-step": "install", "data-status": i.status },
		h("h1", {}, ctx.tr("install.title")),
		h("p", { class: "lead" }, ctx.tr("install.lead")),
		h(
			"p",
			{ class: "status", id: "install-line" },
			now !== null ? h("span", { class: "spinner", "aria-hidden": "true" }) : null,
			now ?? (i.status === "done" ? ctx.tr("install.allDone") : ""),
		),
		h(
			"ul",
			{ class: "stages", id: "install-stages" },
			...i.stages.map((s) => h("li", { "data-stage": s.name, "data-badge": s.badge }, h("span", { class: "stage-name" }, stageLabel(ctx, s.name)), h("span", { class: `badge badge-${s.badge}` }, ctx.tr(`install.badge.${s.badge}`)))),
		),
		...i.failures.map((f) => h("p", { class: "problem" }, failureSentence(ctx, f))),
		i.crashed === null ? null : h("p", { class: "problem" }, ctx.tr("install.crashed")),
		failed ? h("div", { class: "actions" }, h("button", { type: "button", id: "install-retry", class: "primary", onclick: () => ctx.act({ type: "install-retry" }) }, ctx.tr("install.retry"))) : null,
		i.failures.length === 0 && i.tail.length === 0
			? null
			: h(
					"details",
					{ id: "install-details", ...(detailsOpen ? { open: true } : {}), ontoggle: (e) => (detailsOpen = (e.target as HTMLDetailsElement).open) },
					h("summary", { id: "install-summary" }, ctx.tr("install.details")),
					h("pre", {}, [...i.failures.map((f) => `${f.stage || ctx.tr("install.setup")}: ${f.detail}`), ...i.tail].join("\n")),
				),
	);
}
