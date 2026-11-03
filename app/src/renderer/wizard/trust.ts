import { h, type Child } from "../dom.ts";
import type { Ctx } from "./common.ts";

const section = (title: string, ...body: Child[]): HTMLElement => h("section", { class: "trust-item" }, h("h3", {}, title), ...body);

/** Step 3: **Trust: show before applying**, line by line. Nothing is written before Apply. */
export function trust(ctx: Ctx): HTMLElement {
	const t = ctx.view.trust;
	// A trust page with nothing to show still leaves a way out (T9-F001).
	if (t === null) {
		return h("div", { class: "step", "data-step": "trust" }, h("h1", {}, ctx.tr("trust.title")), h("div", { class: "actions" }, h("button", { type: "button", id: "trust-cancel", onclick: () => ctx.act({ type: "trust-cancel" }) }, ctx.tr("trust.cancel"))));
	}
	const list = (items: Child[]): HTMLElement => h("ul", {}, ...items.map((i) => h("li", {}, i)));
	return h(
		"div",
		{ class: "step", "data-step": "trust" },
		h("h1", {}, ctx.tr("trust.title")),
		h("p", { class: "lead" }, ctx.tr("trust.lead")),
		h(
			"div",
			{ class: "trust-list", id: "trust-list" },
			section(ctx.tr("trust.recipe"), h("p", { class: "strong" }, t.name), h("p", {}, ctx.tr("trust.version", { version: t.version })), h("p", {}, ctx.tr("trust.source", { file: t.source })), h("p", {}, ctx.tr("trust.sha"), h("br"), h("code", {}, t.sha256))),
			section(ctx.tr("trust.forges"), list(t.forges.map((f) => ctx.tr("trust.forgeLine", { host: f.host, cli: f.cli })))),
			section(
				ctx.tr("trust.repos"),
				t.repos.length === 0
					? h("p", {}, ctx.tr("trust.nothing"))
					: list(t.repos.map((r) => (r.defaultBranch === null ? ctx.tr("trust.repoLine", { label: r.label, url: r.url, folder: r.folder }) : ctx.tr("trust.repoBranchLine", { label: r.label, url: r.url, folder: r.folder, branch: r.defaultBranch })))),
			),
			t.relay === null ? null : section(ctx.tr("trust.relay"), h("p", {}, t.relay)),
			t.tools.length === 0 ? null : section(ctx.tr("trust.tools"), list(t.tools.map((x) => ctx.tr("trust.toolVersion", { name: x.name, version: x.version ?? "?" })))),
			t.profile === null ? null : section(ctx.tr("trust.profile"), h("p", { class: t.profile.olderThanDefault ? "warn" : "" }, t.profile.olderThanDefault ? ctx.tr("trust.profileOlder", { version: t.profile.version }) : t.profile.version)),
			t.instructions === null ? null : section(ctx.tr("trust.instructions"), h("pre", { class: "instructions" }, t.instructions)),
			t.packages.length === 0 ? null : section(ctx.tr("trust.packages"), list(t.packages.map((p) => ctx.tr("trust.packageLine", { name: p.name, version: p.version })))),
			t.linear ? section(ctx.tr("trust.linear")) : null,
		),
		h(
			"div",
			{ class: "actions" },
			h("button", { type: "button", id: "trust-apply", class: "primary", onclick: () => ctx.act({ type: "trust-apply" }) }, ctx.tr("trust.apply")),
			h("button", { type: "button", id: "trust-cancel", onclick: () => ctx.act({ type: "trust-cancel" }) }, ctx.tr("trust.cancel")),
		),
	);
}
