import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { ProjectFailure, ProjectRow, ProjectsView } from "../src/shared/projects.ts";
import type { WizardAction, WizardView } from "../src/shared/wizard.ts";
import { catalogs } from "../src/renderer/i18n/index.ts";
import { announcementParts } from "../src/renderer/wizard/announce.ts";
import { makeCtx } from "../src/renderer/wizard/common.ts";
import { projects } from "../src/renderer/wizard/projects.ts";
import { installMiniDom, MiniElement } from "./harness/mini-dom.ts";
import { wizardView } from "./harness/views.ts";

// The projects step drawn without a browser (task 12): one card per repository, ids that do not repeat, one action row with the primary action first, a sentence for every failure and every
// phase in both languages, the links sentence, and what Next waits for. The pictures of each state are the e2e gallery's.

let undo = (): void => undefined;
before(() => {
	undo = installMiniDom();
});
after(() => undo());

const row = (over: Partial<ProjectRow> = {}): ProjectRow => ({ folder: "web", label: "Web", host: "github.com", defaultBranch: null, phase: "waiting", step: null, reused: false, opened: false, links: null, failure: null, detail: "", ...over });
const view = (rows: ProjectRow[], over: Partial<ProjectsView> = {}): ProjectsView => ({ rows, running: false, held: false, ...over });

const draw = (projectsView: ProjectsView, locale: "en" | "zh-TW" = "en", acts: WizardAction[] = []): MiniElement => {
	const v: WizardView = wizardView({ step: "projects", locale, projects: projectsView });
	return projects(makeCtx(v, locale, (a) => void acts.push(a))) as unknown as MiniElement;
};

const FAILURES: ProjectFailure[] = [
	{ kind: "reserved-folder" },
	{ kind: "other-origin" },
	{ kind: "not-empty" },
	{ kind: "clone", cause: "network" },
	{ kind: "clone", cause: "network-private", host: "gitlab.moldplan.app" },
	{ kind: "clone", cause: "auth" },
	{ kind: "clone", cause: "not-found" },
	{ kind: "clone", cause: "other" },
	{ kind: "branch-missing", branch: "develop" },
	{ kind: "git", step: "head" },
	{ kind: "git", step: "links" },
	{ kind: "git", step: "origin" },
	{ kind: "open", cause: "settings-unsafe" },
	{ kind: "open", cause: "not-allowed" },
	{ kind: "open", cause: "gui-unavailable" },
	{ kind: "open", cause: "busy" },
	{ kind: "open", cause: "refused" },
	{ kind: "open", cause: "timeout" },
	{ kind: "interrupted" },
];

const ids = (el: MiniElement): string[] => [el.id, ...el.children.flatMap(ids)].filter((i) => i !== "");

describe("the projects step: one card per repository", () => {
	it("draws a card for each row with ids that never repeat and at most one row of actions", () => {
		const step = draw(view([row({ folder: "web", label: "Web", phase: "done", opened: true }), row({ folder: "api", label: "Api", phase: "failed", failure: { kind: "other-origin" } }), row({ folder: "docs", label: "Docs" })]));
		assert.deepEqual(step.querySelectorAll("li.project-card").map((c) => c.getAttribute("data-folder")), ["web", "api", "docs"]);
		const all = ids(step);
		assert.equal(new Set(all).size, all.length, `no id repeats: ${all.join(", ")}`);
		for (const c of step.querySelectorAll("li.project-card")) assert.ok(c.querySelectorAll(".update-buttons").length <= 1);
		assert.deepEqual(step.querySelectorAll("li.project-card").map((c) => c.getAttribute("data-state")), ["done", "failed", "waiting"]);
	});

	it("offers Try again only on a failed card, as its primary action, and sends the folder", () => {
		const acts: WizardAction[] = [];
		const step = draw(view([row({ folder: "web", phase: "done", opened: true }), row({ folder: "api", label: "Api", phase: "failed", failure: { kind: "clone", cause: "network" } })]), "en", acts);
		const buttons = step.querySelectorAll("li.project-card button");
		assert.deepEqual(buttons.map((b) => [b.id, b.className, b.textContent]), [["project-1-retry", "primary", "Try again"]]);
		buttons[0]?.fire("click");
		assert.deepEqual(acts, [{ type: "project-retry", folder: "api" }]);
	});

	it("words every failure in both languages with the repository, the folder or the branch in it, and no unfilled placeholder", () => {
		for (const locale of ["en", "zh-TW"] as const) {
			for (const failure of FAILURES) {
				const step = draw(view([row({ folder: "web", label: "Web app", defaultBranch: "main", phase: "failed", failure, detail: "fatal: x" })]), locale);
				const text = step.querySelector("#project-0-note")?.textContent ?? "";
				assert.ok(text.length > 10, `${locale} ${JSON.stringify(failure)}`);
				assert.doesNotMatch(text, /\{[A-Za-z]+\}/, `${locale} ${JSON.stringify(failure)}`);
				assert.ok(text.includes("Web app") || text.includes("web") || text.includes("Straw Boss") || (failure.kind === "clone" && failure.cause === "network-private" && text.includes(failure.host)), `${locale} ${JSON.stringify(failure)} names the repository: ${text}`);
				if (failure.kind === "branch-missing") assert.ok(text.includes("develop"), text);
				assert.equal(step.querySelector("#project-0-detail")?.textContent, "fatal: x");
			}
		}
	});

	it("names the host and the company network for a code host that does not answer, in both languages (R12-F004)", () => {
		const failure: ProjectFailure = { kind: "clone", cause: "network-private", host: "gitlab.moldplan.app" };
		const en = draw(view([row({ phase: "failed", failure })])).querySelector("#project-0-note")?.textContent ?? "";
		assert.equal(en, "Could not reach gitlab.moldplan.app; it may be reachable only on the company network, so connect to that network and try again.");
		const zh = draw(view([row({ phase: "failed", failure })]), "zh-TW").querySelector("#project-0-note")?.textContent ?? "";
		assert.ok(zh.includes("gitlab.moldplan.app") && zh.includes("公司網路"), zh);
		assert.equal(draw(view([row({ phase: "failed", failure })])).querySelector("li.project-card")?.getAttribute("data-reason"), "clone.network-private");
	});

	it("says the folder named Straw Boss is refused, and that another origin was left untouched", () => {
		const reserved = draw(view([row({ phase: "failed", failure: { kind: "reserved-folder" } })]));
		assert.match(reserved.querySelector("#project-0-note")?.textContent ?? "", /Straw Boss/);
		const other = draw(view([row({ folder: "web", phase: "failed", failure: { kind: "other-origin" } })]));
		assert.match(other.querySelector("#project-0-note")?.textContent ?? "", /another address/);
		assert.match(other.querySelector("#project-0-note")?.textContent ?? "", /left the folder as it is/);
	});

	it("shows the one sentence for links, the paths and how many more, in both languages, on a done row", () => {
		const links = { paths: [".agents/skills", ".pi/x"], more: 3 };
		const en = draw(view([row({ label: "Web app", phase: "done", opened: true, links })]));
		const sentence = en.querySelector('[data-role="links"]')?.textContent ?? "";
		assert.ok(sentence.includes("Web app") && sentence.includes(".agents/skills") && sentence.includes("3 more"), sentence);
		const zh = draw(view([row({ label: "Web app", phase: "done", opened: true, links })]), "zh-TW");
		assert.ok((zh.querySelector('[data-role="links"]')?.textContent ?? "").includes(".agents/skills"));
		assert.equal(draw(view([row({ phase: "done", opened: true, links: null })])).querySelector('[data-role="links"]'), null);
		assert.equal(draw(view([row({ phase: "done", opened: true, links: { paths: [], more: 0 } })])).querySelector('[data-role="links"]'), null);
	});

	it("says done differently for a fresh clone, a reused folder and a head-only run", () => {
		const text = (r: Partial<ProjectRow>) => draw(view([row({ phase: "done", opened: true, ...r })])).querySelector("#project-0-note")?.textContent ?? "";
		assert.match(text({}), /Copied to web and opened/);
		assert.match(text({ reused: true }), /already here with the same address/);
		assert.match(text({ defaultBranch: "develop" }), /starting branch is develop/);
		assert.match(text({ opened: false, defaultBranch: "develop" }), /starting branch is now develop/);
	});

	it("names the step that works, and the trust question that waits", () => {
		assert.equal(draw(view([row({ phase: "working", step: "cloning" })], { running: true })).querySelector("#project-0-note")?.textContent, "Copying…");
		assert.match(draw(view([row({ phase: "trust" })], { held: true })).querySelector("#project-0-note")?.textContent ?? "", /Straw Boss window/);
	});

	it("keeps Next off until every row has ended, or the rest waits behind a trust question", () => {
		const next = (v: ProjectsView) => draw(v).querySelector("#projects-next")?.disabled;
		assert.equal(next(view([row({ phase: "working", step: "cloning" })], { running: true })), true);
		assert.equal(next(view([row({ phase: "done", opened: true }), row({ folder: "b", phase: "waiting" })], { running: true })), true);
		assert.equal(next(view([row({ phase: "done", opened: true })])), false);
		assert.equal(next(view([row({ phase: "failed", failure: { kind: "other-origin" } })])), false);
		assert.equal(next(view([row({ phase: "trust" }), row({ folder: "b", phase: "waiting" })], { held: true })), false);
		assert.equal(next(view([])), true, "nothing was begun yet");
	});

	it("sends projects-next from Next", () => {
		const acts: WizardAction[] = [];
		draw(view([row({ phase: "done", opened: true })]), "en", acts).querySelector("#projects-next")?.fire("click");
		assert.deepEqual(acts, [{ type: "projects-next" }]);
	});

	it("speaks what it is doing, and the outcome once, in the page's language", () => {
		const parts = (v: ProjectsView, locale: "en" | "zh-TW" = "en") => announcementParts(makeCtx(wizardView({ step: "projects", locale, projects: v }), locale, () => undefined));
		assert.deepEqual(parts(view([row({ phase: "working", step: "cloning" })], { running: true })), [catalogs.en.steps.projects, catalogs.en.projects.running]);
		assert.deepEqual(parts(view([row({ phase: "done", opened: true })])), [catalogs.en.steps.projects, catalogs.en.projects.allDone]);
		assert.deepEqual(parts(view([row({ phase: "failed", failure: { kind: "other-origin" } })]), "zh-TW"), [catalogs["zh-TW"].steps.projects, catalogs["zh-TW"].projects.someFailed]);
		assert.deepEqual(parts(view([row({ phase: "trust" })], { held: true })), [catalogs.en.steps.projects, catalogs.en.projects.held]);
	});
});
