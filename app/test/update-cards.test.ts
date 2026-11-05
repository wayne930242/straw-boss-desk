import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { SettingsAction, SettingsView } from "../src/shared/wizard.ts";
import type { ShellRefusal, ShellUpdateState, StackRefusal, StackUpdateState, UpdateAction, UpdatesView } from "../src/shared/updates.ts";
import { isUpdateAction } from "../src/shared/updates.ts";
import { catalogs, t } from "../src/renderer/i18n/index.ts";
import { makeSettingsCtx } from "../src/renderer/settings/common.ts";
import { updates } from "../src/renderer/settings/updates.ts";
import { installMiniDom, MiniElement } from "./harness/mini-dom.ts";
import { readText } from "./harness/ui-rules.ts";

// The Updates section drawn without a browser (task 13): one card per item, ids that do not repeat, one row of actions with the primary action first, the words of every state in both
// languages, and the requests each button sends. The shots of each state are the e2e's.

let undo = (): void => undefined;
before(() => {
	undo = installMiniDom();
});
after(() => undo());

const view = (over: Partial<UpdatesView> = {}): UpdatesView => ({ appVersion: "0.0.1", generation: 5, shell: { phase: "idle", checkedAt: null }, stack: { phase: "idle", checkedAt: null }, checking: false, checkedAt: null, platform: "win32", ...over });

const draw = (u: UpdatesView | undefined, locale: "en" | "zh-TW" = "en", acts: SettingsAction[] = []): MiniElement => {
	const settings: SettingsView = { locale, section: "updates", later: [], forges: [], claude: { phase: "idle" } as unknown as SettingsView["claude"], linear: null, recipe: null, appVersion: "0.0.1", dev: true, ...(u === undefined ? {} : { updates: u }) };
	return updates(makeSettingsCtx(settings, locale, (a) => void acts.push(a))) as unknown as MiniElement;
};

const card = (section: MiniElement, role: string): MiniElement => {
	const found = section.querySelector(`li[data-role="${role}"]`);
	assert.ok(found, `the ${role} card`);
	return found as MiniElement;
};
const buttons = (el: MiniElement): MiniElement[] => el.querySelectorAll("button");

describe("Updates: three cards, one action row each", () => {
	it("draws the check, the app and the stack as cards of their own, and ids that never repeat", () => {
		const section = draw(view());
		assert.deepEqual(section.querySelectorAll("li.update-card").map((c) => c.getAttribute("data-role")), ["check", "app", "stack"]);
		const ids: string[] = [];
		const collect = (el: MiniElement): void => {
			if (el.id !== "") ids.push(el.id);
			for (const c of el.children) collect(c);
		};
		collect(section);
		assert.equal(new Set(ids).size, ids.length, `no id repeats: ${ids.join(", ")}`);
		for (const c of section.querySelectorAll("li.update-card")) assert.ok(c.querySelectorAll(".update-buttons").length <= 1, "at most one row of actions in a card");
		assert.equal(card(section, "app").querySelector("#app-version")?.textContent, "Version 0.0.1");
		assert.equal(card(section, "stack").querySelector("#stack-generation")?.textContent, "Generation 5");
	});

	it("puts Check now in its own card, as the primary action, and shows when the last check ended", () => {
		const never = draw(view());
		const check = card(never, "check");
		assert.deepEqual(buttons(check).map((b) => [b.id, b.className, b.textContent]), [["update-check", "primary", "Check now"]]);
		assert.equal(check.querySelector("#update-checked")?.textContent, catalogs.en.settings.updates.check.never);
		const later = draw(view({ checkedAt: "2026-11-04T10:00:00.000Z" }));
		assert.match(card(later, "check").querySelector("#update-checked")?.textContent ?? "", /^Last checked at .+\.$/);
		const busy = card(draw(view({ checking: true })), "check");
		assert.equal(buttons(busy)[0]?.disabled, true);
		assert.equal(buttons(busy)[0]?.textContent, "Checking…");
	});

	it("offers the app's one action for its state, and none while it has nothing to do", () => {
		const ids = (shell: ShellUpdateState, platform: "win32" | "darwin" = "win32") => buttons(card(draw(view({ shell, platform })), "app")).map((b) => b.id);
		assert.deepEqual(ids({ phase: "idle", checkedAt: null }), []);
		assert.deepEqual(ids({ phase: "off" }), []);
		assert.deepEqual(ids({ phase: "downloading", version: "0.0.2", percent: 40 }), []);
		assert.deepEqual(ids({ phase: "ready", version: "0.0.2" }), ["update-restart"]);
		assert.deepEqual(ids({ phase: "available", version: "0.0.2" }, "darwin"), ["update-download"]);
		assert.deepEqual(ids({ phase: "downloaded", version: "0.0.2", file: "/Users/x/Downloads/a.dmg" }, "darwin"), ["update-reveal"]);
		assert.deepEqual(ids({ phase: "refused", version: "0.0.2", reason: "bad-signature" }), []);
		assert.deepEqual(ids({ phase: "ready", version: "0.0.2" }, "darwin"), [], "a macOS app never restarts into an installer");
		const ready = card(draw(view({ shell: { phase: "ready", version: "0.0.2" } })), "app");
		assert.equal(buttons(ready)[0]?.className, "primary");
		assert.equal(buttons(ready)[0]?.textContent, "Restart to update");
	});

	it("offers Apply with the change list when an update is available, and a disabled Apply while it applies", () => {
		const available = card(draw(view({ stack: { phase: "available", generation: 6, changes: [{ kind: "tool", name: "node", stage: "node", from: "24.22.1", to: "24.99.0" }, { kind: "package", name: "pi-new", stage: "pkg:pi-new", from: null, to: "0.1.0" }, { kind: "package", name: "pi-old", stage: "pkg:pi-old", from: "1.0.0", to: null }] } })), "stack");
		assert.deepEqual(buttons(available).map((b) => [b.id, b.className, b.disabled]), [["update-apply", "primary", false]]);
		assert.deepEqual(available.querySelectorAll("#update-changes li").map((l) => l.textContent), ["Programming runtime: 24.22.1 to 24.99.0", "Agent add-on pi-new: new, 0.1.0", "Agent add-on pi-old: removed"]);
		const applying = card(draw(view({ stack: { phase: "applying", generation: 6, stage: "pkg:pi-lens", done: 3 } })), "stack");
		assert.deepEqual(buttons(applying).map((b) => [b.id, b.disabled]), [["update-apply", true]]);
		assert.equal(applying.querySelector("#update-stack-note")?.textContent, "Updating to generation 6. Now: Agent add-on pi-lens");
		const checking = card(draw(view({ stack: { phase: "applying", generation: 6, stage: null, done: 0 } })), "stack");
		assert.equal(checking.querySelector("#update-stack-note")?.textContent, "Updating to generation 6…");
		assert.equal(buttons(card(draw(view({ checking: false, stack: { phase: "applying", generation: 6, stage: null, done: 0 } })), "check"))[0]?.disabled, true, "Check now waits while an update applies");
	});

	it("says what a refusal is, with its reason, for every reason of both channels", () => {
		const stackReasons: StackRefusal[] = ["bad-signature", "no-signature", "malformed-signature", "no-keys", "bad-key-list", "invalid", "older", "min-shell", "recipe-tool", "too-large"];
		const shellReasons: ShellRefusal[] = ["bad-signature", "no-signature", "malformed-signature", "no-keys", "bad-key-list", "too-large", "bad-manifest", "not-newer", "hash-mismatch"];
		for (const locale of ["en", "zh-TW"] as const) {
			for (const reason of stackReasons) {
				const note = card(draw(view({ stack: { phase: "refused", reason, generation: 4, minShell: "2.0.0", tools: ["bun", "tool"] } }), locale), "stack").querySelector("#update-stack-note");
				assert.equal(note?.getAttribute("data-reason"), reason);
				assert.doesNotMatch(note?.textContent ?? "", /[{}]/, `${locale} ${reason} leaves a placeholder`);
				assert.ok((note?.textContent ?? "").length > 10);
			}
			for (const reason of shellReasons) {
				const note = card(draw(view({ shell: { phase: "refused", version: "0.0.2", reason } }), locale), "app").querySelector("#update-app-note");
				assert.equal(note?.getAttribute("data-reason"), reason);
				assert.match(note?.textContent ?? "", /0\.0\.2/);
				assert.doesNotMatch(note?.textContent ?? "", /[{}]/);
			}
		}
		const min = card(draw(view({ stack: { phase: "refused", reason: "min-shell", generation: 6, minShell: "2.0.0" } })), "stack").querySelector("#update-stack-note")?.textContent;
		assert.equal(min, "The offered update needs Straw Boss 2.0.0 or newer. Update the app first.");
		const tools = card(draw(view({ stack: { phase: "refused", reason: "recipe-tool", generation: 6, tools: ["bun", "tool"] } })), "stack").querySelector("#update-stack-note")?.textContent;
		assert.match(tools ?? "", /bun and tool/, "a list is joined the way the language joins it");
		const zh = card(draw(view({ stack: { phase: "refused", reason: "recipe-tool", generation: 6, tools: ["bun", "tool"] } }), "zh-TW"), "stack").querySelector("#update-stack-note")?.textContent;
		assert.match(zh ?? "", /bun 和 tool/);
	});

	it("names the stage a rolled-back update stopped at, and the generation the machine is on again", () => {
		const en = card(draw(view({ generation: 5, stack: { phase: "rolled-back", generation: 6, stage: "pi", category: "registry", restored: true, at: "2026-11-04T10:00:00.000Z" } })), "stack");
		assert.equal(en.querySelector("#update-stack-note")?.textContent, "The update to generation 6 stopped at “Coding agent” and was undone. You are on generation 5 again.");
		assert.equal(en.querySelector("#update-stack-note")?.getAttribute("data-reason"), "pi");
		assert.equal(en.querySelector(".badge")?.getAttribute("data-badge"), "rolled-back");
		// SA-T13-2: a rollback is a safe recovery, so the badge is the warning tone, not the red of a refusal.
		assert.match(en.querySelector(".badge")?.className ?? "", /\bbadge-warn\b/);
		assert.doesNotMatch(en.querySelector(".badge")?.className ?? "", /badge-failed/);
		assert.match(card(draw(view({ stack: { phase: "refused", reason: "older", generation: 1 } })), "stack").querySelector(".badge")?.className ?? "", /badge-failed/, "a refusal stays red");
		const zh = card(draw(view({ generation: 5, stack: { phase: "rolled-back", generation: 6, stage: "pi", category: "registry", restored: true, at: "x" } }), "zh-TW"), "stack");
		assert.equal(zh.querySelector("#update-stack-note")?.textContent, "更新到第 6 代時，在「代理程式」這一步停了下來，已經還原。你目前又回到第 5 代。".replace("代理程式", t("zh-TW", "install.stage.pi")));
		const partly = card(draw(view({ stack: { phase: "rolled-back", generation: 6, stage: "pi", category: "registry", restored: false, at: "x" } })), "stack").querySelector("#update-stack-note")?.textContent;
		assert.match(partly ?? "", /Run Repair/);
		const cut = card(draw(view({ stack: { phase: "rolled-back", generation: 6, stage: "interrupted", category: "other", restored: true, at: "x" } })), "stack").querySelector("#update-stack-note")?.textContent;
		assert.equal(cut, "The update to generation 6 was cut short and has been undone.");
	});

	it("words every state of both channels in both languages without a missing key or a placeholder left", () => {
		const shells: ShellUpdateState[] = [
			{ phase: "off" },
			{ phase: "idle", checkedAt: null },
			{ phase: "checking" },
			{ phase: "available", version: "0.0.2" },
			{ phase: "downloading", version: "0.0.2", percent: null },
			{ phase: "downloading", version: "0.0.2", percent: 42 },
			{ phase: "ready", version: "0.0.2" },
			{ phase: "downloaded", version: "0.0.2", file: "/x/a.dmg" },
			{ phase: "error", kind: "network", detail: "d" },
			{ phase: "error", kind: "other", detail: "the feed is not YAML" },
		];
		const stacks: StackUpdateState[] = [
			{ phase: "idle", checkedAt: null },
			{ phase: "checking" },
			{ phase: "available", generation: 6, changes: [] },
			{ phase: "applying", generation: 6, stage: null, done: 0 },
			{ phase: "applied", generation: 6, at: "x" },
			{ phase: "error", kind: "network", detail: "d" },
			{ phase: "error", kind: "other", detail: "busy" },
		];
		for (const locale of ["en", "zh-TW"] as const) {
			for (const shell of shells) for (const platform of ["win32", "darwin"] as const) assert.doesNotMatch(draw(view({ shell, platform }), locale).textContent, /[{}]/, `${locale} ${shell.phase}`);
			for (const stack of stacks) assert.doesNotMatch(draw(view({ stack }), locale).textContent, /[{}]/, `${locale} ${stack.phase}`);
		}
		assert.equal(card(draw(view({ shell: { phase: "downloading", version: "0.0.2", percent: 42 } })), "app").querySelector("#update-app-note")?.textContent, "Downloading version 0.0.2: 42 %");
		assert.equal(card(draw(view({ shell: { phase: "downloading", version: "0.0.2", percent: 42 } }), "zh-TW"), "app").querySelector("#update-app-note")?.textContent, "正在下載版本 0.0.2：42%");
	});

	it("sends the request of each button", () => {
		const acts: SettingsAction[] = [];
		const click = (section: MiniElement, id: string): void => {
			const b = section.querySelector(`#${id}`);
			assert.ok(b, id);
			(b as MiniElement).fire("click");
		};
		click(draw(view(), "en", acts), "update-check");
		click(draw(view({ shell: { phase: "ready", version: "0.0.2" } }), "en", acts), "update-restart");
		click(draw(view({ shell: { phase: "available", version: "0.0.2" }, platform: "darwin" }), "en", acts), "update-download");
		click(draw(view({ shell: { phase: "downloaded", version: "0.0.2", file: "f" }, platform: "darwin" }), "en", acts), "update-reveal");
		click(draw(view({ stack: { phase: "available", generation: 6, changes: [] } }), "en", acts), "update-apply");
		assert.deepEqual(acts, [{ type: "update-check" }, { type: "update-restart" }, { type: "update-download" }, { type: "update-reveal" }, { type: "update-apply" }] satisfies UpdateAction[]);
		for (const a of acts) assert.ok(isUpdateAction(a));
		assert.equal(isUpdateAction({ type: "update-install-anything" }), false);
		assert.equal(isUpdateAction(null), false);
		assert.equal(isUpdateAction({ type: 5 }), false);
	});

	it("draws only the app's version before main has built the view", () => {
		const section = draw(undefined);
		assert.equal(section.querySelectorAll("li.update-card").length, 0);
		assert.equal(section.querySelector("#app-version")?.textContent, "Version 0.0.1");
	});
});

describe("an error is worded from the catalog and keeps the raw text under Details (R13-F006)", () => {
	const raw = "the stack could not be stopped: C:\\Users\\x\\tools\\node.exe still runs";
	it("shows the sentence of its kind in the interface language and never the raw text as the sentence", () => {
		for (const locale of ["en", "zh-TW"] as const) {
			for (const [stack, key] of [
				[{ phase: "error", kind: "busy", detail: raw }, "settings.updates.stack.errorBusy"],
				[{ phase: "error", kind: "other", detail: raw }, "settings.updates.stack.errorOther"],
				[{ phase: "error", kind: "network", detail: raw }, "settings.updates.stack.errorNetwork"],
			] as const) {
				const c = card(draw(view({ stack }), locale), "stack");
				assert.equal(c.querySelector("#update-stack-note")?.textContent, t(locale, key), `${locale} ${stack.kind}`);
				assert.equal(c.querySelector(".update-detail")?.textContent, raw);
				assert.equal(c.querySelector("details.update-details summary")?.textContent, locale === "en" ? "Details" : "詳細資料");
			}
			const app = card(draw(view({ shell: { phase: "error", kind: "other", detail: raw } }), locale), "app");
			assert.equal(app.querySelector("#update-app-note")?.textContent, t(locale, "settings.updates.app.errorOther"));
			assert.equal(app.querySelector(".update-detail")?.textContent, raw);
		}
		const zh = card(draw(view({ stack: { phase: "error", kind: "busy", detail: raw } }), "zh-TW"), "stack").querySelector("#update-stack-note")?.textContent ?? "";
		assert.doesNotMatch(zh, /[A-Za-z]{4,}/, "no English word in the zh-TW sentence");
	});

	it("shows no Details when there is no error, and the refused offer of a failed install start with its reason", () => {
		assert.equal(card(draw(view()), "stack").querySelector(".update-details"), null);
		const failed = card(draw(view({ shell: { phase: "ready", version: "0.0.2", installFailed: "No update filepath provided" } })), "app");
		assert.equal(failed.querySelector("#update-app-note")?.textContent, "The installer for version 0.0.2 could not start, so nothing changed: your agents are running again. You can try again.");
		assert.equal(failed.querySelector("#update-app-note")?.getAttribute("data-reason"), "install-failed");
		assert.equal(failed.querySelector(".update-detail")?.textContent, "No update filepath provided");
		assert.deepEqual(buttons(failed).map((b) => b.id), ["update-restart"], "the offer is armed again");
	});
});

describe("the Updates copy uses the words the rest of the app uses (SA-T13-3)", () => {
	it("calls the PM's agents 代理程式 in zh-TW wherever the English says agents, as the wizard and the other settings do", () => {
		const walk = (value: unknown, path: string, out: Array<[string, string]>): Array<[string, string]> => {
			if (typeof value === "string") out.push([path, value]);
			else if (typeof value === "object" && value !== null) for (const [k, v] of Object.entries(value)) walk(v, `${path}.${k}`, out);
			return out;
		};
		const en = new Map(walk(catalogs.en.settings.updates, "updates", []));
		const zh = new Map(walk(catalogs["zh-TW"].settings.updates, "updates", []));
		let seen = 0;
		for (const [path, text] of en) {
			if (!/\bagents\b/.test(text)) continue;
			seen++;
			assert.match(zh.get(path) ?? "", /代理程式/, path);
			assert.doesNotMatch(zh.get(path) ?? "", /助理|代理人|智慧代理|AI/, path);
		}
		assert.ok(seen >= 2);
		// The rest of the catalog says it the same way.
		const elsewhere = walk(catalogs["zh-TW"], "catalog", []).filter(([path, text]) => !path.startsWith("catalog.settings.updates") && text.includes("你的代理程式"));
		assert.ok(elsewhere.length >= 2, "the wizard's copy uses the same term");
	});
});

describe("the Updates styles", () => {
	it("sets no colour and no border of its own: the cards use the accounts list's frame and the badge's colours", () => {
		// The card parts live in desk.css, beside the card list's frame (R12-F014); settings.css keeps the update cards' own.
		const css = ["desk.css", "settings.css"].map((f) => readText(join(import.meta.dirname, "..", "src", "renderer", f))).join("\n");
		const rules = [...css.matchAll(/^([^{}\n]*update-[^{}\n]*)\{([^}]*)\}/gm)];
		assert.ok(rules.length >= 5);
		for (const [, selector, body] of rules) assert.doesNotMatch(body as string, /(^|[;\s])(color|background(-color)?|border[\w-]*)\s*:/, `${selector} sets a colour or a border`);
	});
});
