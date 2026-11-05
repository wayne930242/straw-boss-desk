import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { ComputerAction, ComputerView, DiagnosticsAction, DiagnosticsView, LeftEntry, RemoveState, RemoveStep } from "../src/shared/computer.ts";
import { isComputerAction, isDiagnosticsAction } from "../src/shared/computer.ts";
import type { SettingsAction, SettingsView } from "../src/shared/wizard.ts";
import { catalogs } from "../src/renderer/i18n/index.ts";
import { makeSettingsCtx } from "../src/renderer/settings/common.ts";
import { computer, formatSize } from "../src/renderer/settings/computer.ts";
import { diagnostics } from "../src/renderer/settings/diagnostics.ts";
import { installMiniDom, MiniElement } from "./harness/mini-dom.ts";

// The Computer and Diagnostics sections drawn without a browser (task 14): the removal's panels one by one, in both languages, with the entries it leaves named; the diagnostics cards and the
// requests each button sends. The shots of every state are the e2e's.

let undo = (): void => undefined;
before(() => {
	undo = installMiniDom();
});
after(() => undo());

type Locale = "en" | "zh-TW";
const settings = (locale: Locale, over: Partial<SettingsView>): SettingsView => ({ locale, section: "computer", later: [], forges: [], claude: { phase: "idle" } as unknown as SettingsView["claude"], linear: null, recipe: null, appVersion: "0.0.1", dev: true, ...over });

const drawComputer = (remove: RemoveState, locale: Locale = "en", acts: SettingsAction[] = [], keepAwake = false): MiniElement => {
	const view: ComputerView = { platform: "win32", keepAwake, remove };
	return computer(makeSettingsCtx(settings(locale, { computer: view }), locale, (a) => void acts.push(a))) as unknown as MiniElement;
};

const diagView = (over: Partial<DiagnosticsView> = {}): DiagnosticsView => ({ status: { phase: "idle" }, collect: { phase: "idle" }, repair: { phase: "idle" }, logsDir: "/root/logs", wslBash: null, ...over });
const drawDiag = (view: DiagnosticsView | undefined, locale: Locale = "en", acts: SettingsAction[] = []): MiniElement =>
	diagnostics(makeSettingsCtx(settings(locale, { section: "diagnostics", ...(view === undefined ? {} : { diagnostics: view }) }), locale, (a) => void acts.push(a))) as unknown as MiniElement;

const idsOf = (el: MiniElement): string[] => {
	const ids: string[] = [];
	const walk = (e: MiniElement): void => {
		if (e.id !== "") ids.push(e.id);
		for (const c of e.children) walk(c);
	};
	walk(el);
	return ids;
};
const text = (el: MiniElement, selector: string): string => el.querySelector(selector)?.textContent ?? "";
const click = (el: MiniElement, id: string): void => {
	const b = el.querySelector(`#${id}`);
	assert.ok(b, `button ${id}`);
	(b as MiniElement).fire("click");
};

const PLAN = { root: "C:\\Users\\pm\\AppData\\Roaming\\Straw Boss", bytes: 1_610_612_736, workFolder: "C:\\Users\\pm\\Straw Boss", left: [] as LeftEntry[], pathEntry: "C:\\Users\\pm\\AppData\\Roaming\\Straw Boss\\tools\\shims" };
const LEFT: LeftEntry[] = [
	{ name: "gh:github.com", account: "me", host: "github.com", why: "foreign" },
	{ name: "glab:gitlab.example.com:token", account: "", host: "gitlab.example.com", why: "changed" },
];
const STEPS: RemoveStep[] = ["stopping", "logins", "claude", "linear", "path", "safe-storage", "files"];

describe("Remove all data: one panel per state", () => {
	it("idle offers the button; planning shows progress and no buttons", () => {
		const acts: SettingsAction[] = [];
		const idle = drawComputer({ phase: "idle" }, "en", acts);
		assert.equal(idle.querySelector("#remove-panel")?.getAttribute("data-state"), "idle");
		click(idle, "remove-open");
		assert.deepEqual(acts, [{ type: "computer-remove-plan" } satisfies ComputerAction]);
		const planning = drawComputer({ phase: "planning" });
		assert.equal(planning.querySelectorAll("button").filter((b) => b.id.startsWith("remove-")).length, 0);
		assert.ok(text(planning, "#remove-status").length > 5);
	});

	it("the confirmation names the folder and its size, the PATH entry, the work folder that stays, and nothing else that stays when the store is clear", () => {
		const acts: SettingsAction[] = [];
		const c = drawComputer({ phase: "confirm", plan: PLAN }, "en", acts);
		const panel = c.querySelector("#remove-confirm-panel");
		assert.ok(panel);
		assert.match(panel?.textContent ?? "", /1\.5 GB/);
		assert.match(text(c, '[data-role="path"]'), /tools\\shims/);
		assert.match(text(c, '[data-role="kept"]'), /C:\\Users\\pm\\Straw Boss/);
		assert.equal(c.querySelector('[data-role="leaves"] li'), null);
		assert.equal(c.querySelector("#remove-guide"), null, "no guide button when nothing stays");
		click(c, "remove-confirm");
		click(c, "remove-cancel");
		assert.deepEqual(acts, [{ type: "computer-remove-confirm" }, { type: "computer-remove-cancel" }]);
	});

	it("the confirmation lists each entry that stays with its reason, and offers the guide", () => {
		const acts: SettingsAction[] = [];
		const c = drawComputer({ phase: "confirm", plan: { ...PLAN, left: LEFT } }, "en", acts);
		const items = c.querySelectorAll('[data-role="leaves"] li');
		assert.deepEqual(items.map((i) => [i.getAttribute("data-entry"), i.getAttribute("data-why")]), [["gh:github.com", "foreign"], ["glab:gitlab.example.com:token", "changed"]]);
		assert.match(items[0]?.textContent ?? "", /gh:github\.com/);
		assert.match(items[0]?.textContent ?? "", /me/);
		click(c, "remove-guide");
		assert.deepEqual(acts, [{ type: "computer-open-guide" }]);
	});

	it("a size that could not be measured and a Mac without a PATH entry or a work folder drop those lines", () => {
		const c = drawComputer({ phase: "confirm", plan: { ...PLAN, bytes: null, workFolder: null, pathEntry: null } });
		assert.equal(c.querySelector('[data-role="path"]'), null);
		assert.doesNotMatch(c.querySelector("#remove-confirm-panel")?.textContent ?? "", /GB|MB/);
		assert.ok(text(c, '[data-role="kept"]').length > 5);
		assert.doesNotMatch(text(c, '[data-role="kept"]'), /[{}]/);
	});

	it("the refusal says the store cannot be read, offers a retry and a cancel, and has no confirm", () => {
		const c = drawComputer({ phase: "refused", reason: "store", detail: "keychain locked" });
		assert.equal(c.querySelector("#remove-refusal")?.getAttribute("data-reason"), "store");
		assert.equal(c.querySelector("#remove-confirm"), null);
		assert.ok(c.querySelector("#remove-retry") && c.querySelector("#remove-cancel"));
		assert.match(text(c, "#remove-refusal pre"), /keychain locked/);
	});

	it("each step of the work has its own sentence, hides the language, and the keep-awake box is disabled", () => {
		const sentences = new Set<string>();
		for (const step of STEPS) {
			const c = drawComputer({ phase: "working", step });
			assert.equal(c.querySelector("#remove-status")?.getAttribute("data-step"), step);
			sentences.add(text(c, "#remove-status"));
			assert.equal(c.querySelector(".language"), null, "the language is saved in the folder being deleted");
			assert.equal((c.querySelector("#keep-awake") as MiniElement).disabled, true);
		}
		assert.equal(sentences.size, STEPS.length);
	});

	it("a stop that could not finish lists each program by file and pid, and nothing was removed", () => {
		const c = drawComputer({ phase: "stop-failed", leftovers: [{ pid: 4242, file: "C:\\r\\tools\\node\\node.exe" }], detail: "" });
		const items = c.querySelectorAll("#remove-refusal li");
		assert.equal(items.length, 1);
		assert.match(items[0]?.textContent ?? "", /4242/);
		assert.match(items[0]?.textContent ?? "", /node\.exe/);
		assert.ok(c.querySelector("#remove-retry"));
	});

	it("an unexpected failure shows its detail under the refusal", () => {
		const c = drawComputer({ phase: "failed", detail: "EPERM" });
		assert.equal(c.querySelector("#remove-refusal")?.getAttribute("data-reason"), "failed");
		assert.match(text(c, "#remove-refusal pre"), /EPERM/);
	});

	it("the result keeps the work folder, names an entry that stayed (a foreign write over an owned one), lists the steps that failed, and offers Quit", () => {
		const acts: SettingsAction[] = [];
		const c = drawComputer({ phase: "done", result: { root: PLAN.root, workFolder: PLAN.workFolder, left: LEFT, problems: [{ step: "files", detail: "EBUSY" }, { step: "path", detail: "" }] } }, "en", acts);
		assert.match(text(c, '[data-role="kept"]'), /Straw Boss/);
		assert.equal(c.querySelectorAll("#remove-left li").length, 2);
		assert.equal(c.querySelector('#remove-left li[data-why="changed"]')?.getAttribute("data-entry"), "glab:gitlab.example.com:token");
		assert.deepEqual(c.querySelectorAll("#remove-problems li").map((l) => l.getAttribute("data-step")), ["files", "path"]);
		assert.match(text(c, "#remove-problems"), /EBUSY/);
		assert.ok(c.querySelector("#remove-guide"));
		click(c, "remove-quit");
		assert.deepEqual(acts, [{ type: "computer-quit" }]);
		const clean = drawComputer({ phase: "done", result: { root: PLAN.root, workFolder: null, left: [], problems: [] } });
		assert.equal(clean.querySelector("#remove-problems"), null);
		assert.equal(clean.querySelector("#remove-left"), null);
	});

	it("sends the keep-awake choice", () => {
		const acts: SettingsAction[] = [];
		const c = drawComputer({ phase: "idle" }, "en", acts, true);
		const box = c.querySelector("#keep-awake") as MiniElement;
		assert.equal(box.getAttribute("checked") !== null || (box as unknown as { checked?: boolean }).checked === true, true);
		box.fire("change", { target: { checked: false } });
		assert.deepEqual(acts, [{ type: "computer-keep-awake", on: false }]);
	});

	it("draws every state in both languages without a leftover placeholder or an empty sentence, and ids that never repeat", () => {
		const states: RemoveState[] = [
			{ phase: "idle" },
			{ phase: "planning" },
			{ phase: "confirm", plan: { ...PLAN, left: LEFT } },
			{ phase: "refused", reason: "store", detail: "x" },
			...STEPS.map((step): RemoveState => ({ phase: "working", step })),
			{ phase: "stop-failed", leftovers: [{ pid: 1, file: "f" }], detail: "" },
			{ phase: "failed", detail: "x" },
			{ phase: "done", result: { root: PLAN.root, workFolder: PLAN.workFolder, left: LEFT, problems: STEPS.map((step) => ({ step, detail: "d" })) } },
		];
		for (const locale of ["en", "zh-TW"] as const) {
			for (const s of states) {
				const c = drawComputer(s, locale);
				const walk = (e: MiniElement): void => {
					for (const n of e.childNodes) if (!(n instanceof MiniElement)) assert.doesNotMatch(n.textContent, /\{\w+\}/, `${locale} ${s.phase}`);
					for (const k of e.children) walk(k);
				};
				walk(c);
				assert.ok(c.textContent.length > 20);
				const ids = idsOf(c);
				assert.equal(new Set(ids).size, ids.length, `${locale} ${s.phase}: ${ids.join(",")}`);
			}
		}
		assert.notEqual(catalogs.en.settings.computer.remove.button, catalogs["zh-TW"].settings.computer.remove.button);
	});

	it("shows only the language before main has answered", () => {
		const c = computer(makeSettingsCtx(settings("en", {}), "en", () => undefined)) as unknown as MiniElement;
		assert.equal(c.querySelector("#remove-panel"), null);
		assert.ok(c.querySelector(".language"));
	});

	it("formats sizes in the page's language", () => {
		assert.equal(formatSize(0, "en"), "0 B");
		assert.equal(formatSize(1536, "en"), "1.5 KB");
		assert.equal(formatSize(5 * 1024 ** 3, "zh-TW"), "5 GB");
	});
});

describe("Diagnostics: four cards, one action row each", () => {
	it("draws status, logs, collect and repair as cards, and the WSL notice only when it applies", () => {
		const d = drawDiag(diagView());
		assert.deepEqual(d.querySelectorAll("li.update-card").map((c) => c.getAttribute("data-role")), ["status", "logs", "collect", "repair"]);
		assert.equal(d.querySelector("#diag-wsl"), null);
		const wsl = drawDiag(diagView({ wslBash: "C:\\Windows\\System32\\bash.exe" }));
		assert.equal(wsl.querySelector("#diag-wsl")?.getAttribute("data-path"), "C:\\Windows\\System32\\bash.exe");
		assert.match(text(d, "#diag-logs-where"), /\/root\/logs/);
		const ids = idsOf(d);
		assert.equal(new Set(ids).size, ids.length);
	});

	it("sends the request each button stands for, and Reveal only after a zip exists", () => {
		const acts: SettingsAction[] = [];
		const d = drawDiag(diagView(), "en", acts);
		for (const id of ["diag-status", "diag-logs", "diag-collect", "diag-repair"]) click(d, id);
		assert.deepEqual(acts, [{ type: "diagnostics-status" }, { type: "diagnostics-open-logs" }, { type: "diagnostics-collect" }, { type: "diagnostics-repair" }] satisfies DiagnosticsAction[]);
		assert.equal(d.querySelector("#diag-reveal"), null);
		const done = drawDiag(diagView({ collect: { phase: "done", file: "/root/d.zip", files: 12, skipped: 2 } }), "en", acts);
		click(done, "diag-reveal");
		assert.equal(acts.at(-1)?.type, "diagnostics-reveal");
		assert.match(text(done, "#diag-collect-done"), /d\.zip/);
		assert.match(text(done, "#diag-collect-skipped"), /2/);
		assert.equal(drawDiag(diagView({ collect: { phase: "done", file: "/r/d.zip", files: 3, skipped: 0 } })).querySelector("#diag-collect-skipped"), null);
	});

	it("disables a button while its run is under way", () => {
		const d = drawDiag(diagView({ status: { phase: "reading" }, collect: { phase: "working" }, repair: { phase: "working" } }));
		for (const id of ["diag-status", "diag-collect", "diag-repair"]) assert.equal((d.querySelector(`#${id}`) as MiniElement).disabled, true, id);
	});

	it("shows the status fields, with unknown for a field main could not read, and never a key's value", () => {
		const d = drawDiag(diagView({ status: { phase: "ok", at: "t", fields: { state: "live", primary: true, desk: null, version: "0.59.0", keys: ["zzkeyname", "yykeyname"] } } }));
		const fields = d.querySelectorAll("#diag-status-fields li");
		assert.deepEqual(fields.map((f) => f.getAttribute("data-field")), ["state", "primary", "desk", "version"]);
		assert.match(fields[0]?.textContent ?? "", /live/);
		assert.match(fields[3]?.textContent ?? "", /0\.59\.0/);
		assert.doesNotMatch(d.textContent, /keyname/);
	});

	it("says why a status or a repair failed, with the detail folded", () => {
		for (const reason of ["not-installed", "package", "busy", "failed"] as const) {
			const d = drawDiag(diagView({ status: { phase: "failed", reason, detail: "line" } }));
			assert.equal(d.querySelector("#diag-status-failed")?.getAttribute("data-reason"), reason);
			assert.ok(text(d, "#diag-status-failed").length > 10);
		}
		const bad = drawDiag(diagView({ repair: { phase: "failed", detail: "npm exited 1" }, collect: { phase: "failed", detail: "disk full" } }));
		assert.ok(bad.querySelector("#diag-repair-failed") && bad.querySelector("#diag-collect-failed"));
		assert.match(bad.textContent, /npm exited 1/);
		assert.match(bad.textContent, /disk full/);
	});

	it("draws every state in both languages without a placeholder", () => {
		const views = [
			diagView(),
			diagView({ status: { phase: "reading" }, collect: { phase: "working" }, repair: { phase: "working" } }),
			diagView({ status: { phase: "ok", at: "t", fields: { state: "live", primary: true, desk: true, version: "1", keys: [] } }, collect: { phase: "done", file: "f.zip", files: 3, skipped: 1 }, repair: { phase: "done" }, wslBash: "w" }),
			diagView({ status: { phase: "failed", reason: "busy", detail: "" }, collect: { phase: "failed", detail: "d" }, repair: { phase: "failed", detail: "d" } }),
		];
		for (const locale of ["en", "zh-TW"] as const)
			for (const v of views) {
				const d = drawDiag(v, locale);
				const walk = (e: MiniElement): void => {
					for (const n of e.childNodes) if (!(n instanceof MiniElement)) assert.doesNotMatch(n.textContent, /\{\w+\}/);
					for (const k of e.children) walk(k);
				};
				walk(d);
			}
		assert.ok(drawDiag(undefined).textContent.length > 0);
	});
});

describe("the requests the page may send", () => {
	it("accepts exactly the computer and diagnostics actions, and a keep-awake only with a boolean", () => {
		assert.equal(isComputerAction({ type: "computer-remove-plan" }), true);
		assert.equal(isComputerAction({ type: "computer-keep-awake", on: "yes" }), false);
		assert.equal(isComputerAction({ type: "computer-keep-awake", on: true }), true);
		assert.equal(isComputerAction({ type: "diagnostics-collect" }), false);
		assert.equal(isComputerAction({ type: "computer-delete-everything" }), false);
		assert.equal(isComputerAction(null), false);
		assert.equal(isDiagnosticsAction({ type: "diagnostics-repair" }), true);
		assert.equal(isDiagnosticsAction({ type: "computer-quit" }), false);
		assert.equal(isDiagnosticsAction("diagnostics-repair"), false);
	});
});
