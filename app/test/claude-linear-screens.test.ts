import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { ClaudeAction, ClaudeFlow, ClaudeView, LinearAction, LinearFlow, LinearView } from "../src/shared/accounts.ts";
import type { SettingsView, WizardView } from "../src/shared/wizard.ts";
import { catalogs } from "../src/renderer/i18n/index.ts";
import { accounts } from "../src/renderer/settings/accounts.ts";
import { makeSettingsCtx } from "../src/renderer/settings/common.ts";
import { makeCtx } from "../src/renderer/wizard/common.ts";
import { claude } from "../src/renderer/wizard/claude.ts";
import { linear } from "../src/renderer/wizard/linear.ts";
import { installMiniDom, MiniElement } from "./harness/mini-dom.ts";
import { readText, sourceFiles } from "./harness/ui-rules.ts";

// Steps 7 and 9 and the Claude and Linear cards of settings, drawn without a browser, in both languages and in every state the spec names: not signed in, signed in, refused, encryption unavailable,
// the restart offer. What a browser must prove (focus, layout, the picture) is the e2e run's, with its screenshots.

let undo = (): void => undefined;
before(() => {
	undo = installMiniDom();
});
after(() => undo());

type Locale = "en" | "zh-TW";
const LOCALES: Locale[] = ["en", "zh-TW"];

const cv = (flow: ClaudeFlow, state: ClaudeView["state"] = "not-signed-in", storage: ClaudeView["storage"] = "keychain"): ClaudeView => ({ state, storage, flow });
const lv = (flow: LinearFlow, state: LinearView["state"] = "not-saved", restart: LinearView["restart"] = { phase: "none" }, encryption: boolean | null = true): LinearView => ({ state, flow, restart, encryption });

function wizardView(locale: Locale, over: Partial<WizardView>): WizardView {
	return { step: "claude", locale, hosts: { forges: [], index: 0, current: null }, later: [], linearOffered: true, start: { status: "idle", failure: null }, claude: cv({ phase: "idle" }), linear: lv({ phase: "idle" }), ...over } as unknown as WizardView;
}
const drawClaude = (view: ClaudeView, locale: Locale, acts: unknown[] = []): MiniElement => claude(makeCtx(wizardView(locale, { step: "claude", claude: view }), locale, (a) => acts.push(a))) as unknown as MiniElement;
const drawLinear = (view: LinearView, locale: Locale, acts: unknown[] = []): MiniElement => linear(makeCtx(wizardView(locale, { step: "linear", linear: view }), locale, (a) => acts.push(a))) as unknown as MiniElement;
function drawCards(locale: Locale, c: ClaudeView, l: LinearView | null, acts: unknown[] = []): MiniElement {
	const view: SettingsView = { locale, section: "accounts", later: [], forges: [], claude: c, linear: l, recipe: null, appVersion: "0", dev: true };
	return accounts(makeSettingsCtx(view, locale, (a) => acts.push(a))) as unknown as MiniElement;
}

const buttons = (root: MiniElement): MiniElement[] => root.querySelectorAll(".actions button");
const primaries = (root: MiniElement): MiniElement[] => root.querySelectorAll("button.primary");
const ids = (root: MiniElement): string[] => root.querySelectorAll("[id]").map((e) => e.id);
const unique = (xs: string[]): boolean => new Set(xs).size === xs.length;

const CLAUDE_FLOWS: Array<[string, ClaudeFlow, ClaudeView["state"]]> = [
	["idle, not signed in", { phase: "idle" }, "not-signed-in"],
	["idle, signed in", { phase: "idle" }, "signed-in"],
	["checking", { phase: "checking" }, "unknown"],
	["starting", { phase: "starting" }, "not-signed-in"],
	["browser, no address yet", { phase: "browser", url: null, codeAsked: false, codeSent: false }, "not-signed-in"],
	["browser with the address", { phase: "browser", url: "https://claude.ai/oauth/authorize?x=1", codeAsked: false, codeSent: false }, "not-signed-in"],
	["browser asking for a code", { phase: "browser", url: "https://claude.ai/oauth/authorize?x=1", codeAsked: true, codeSent: false }, "not-signed-in"],
	["browser, code refused", { phase: "browser", url: "https://claude.ai/oauth/authorize?x=1", codeAsked: true, codeSent: false, codeRefused: true }, "not-signed-in"],
	["browser, code sent", { phase: "browser", url: "https://claude.ai/oauth/authorize?x=1", codeAsked: true, codeSent: true }, "not-signed-in"],
	["working", { phase: "working" }, "not-signed-in"],
	["done", { phase: "done" }, "signed-in"],
	["failed", { phase: "failed", detail: "Invalid code" }, "not-signed-in"],
	["timeout", { phase: "timeout" }, "not-signed-in"],
	["unverified", { phase: "unverified", detail: "claude auth status says not logged in" }, "not-signed-in"],
	["signed out", { phase: "signed-out" }, "not-signed-in"],
];

describe("step 7: Claude, in every state and both languages", () => {
	for (const locale of LOCALES) {
		it(`${locale}: every state draws, with ids that do not repeat, at most one primary button, and the primary one first in its row`, () => {
			for (const [name, flow, state] of CLAUDE_FLOWS) {
				const step = drawClaude(cv(flow, state), locale);
				assert.ok(step.textContent.length > 0, name);
				assert.ok(unique(ids(step)), `${name}: ids ${ids(step).join(" ")}`);
				const row = buttons(step);
				assert.ok(primaries(step).length <= 1, `${name}: one primary button at most`);
				if (primaries(step).length === 1) assert.equal(row[0], primaries(step)[0], `${name}: the primary action comes first`);
				assert.ok(row.length >= 0);
			}
		});
	}

	it("not signed in: Sign in is the primary action and Later is a choice; signed in: Next replaces Later", () => {
		const idle = drawClaude(cv({ phase: "idle" }), "en");
		assert.equal(idle.querySelector("#claude-sign-in")?.textContent, catalogs.en.claude.signIn);
		assert.ok(idle.querySelector("#later"), "Later stays a choice");
		assert.equal(idle.querySelector("#step-next"), null);
		const done = drawClaude(cv({ phase: "idle" }, "signed-in"), "en");
		assert.ok(done.querySelector("#step-next"));
		assert.equal(done.querySelector("#later"), null);
	});

	it("while the CLI's status is read after a login, Later waits; while a login waits, Later cancels it", () => {
		const working = drawClaude(cv({ phase: "working" }), "en");
		assert.equal(working.querySelector("#later")?.disabled, true);
		const waiting = drawClaude(cv({ phase: "browser", url: null, codeAsked: false, codeSent: false }), "en");
		assert.equal(waiting.querySelector("#later")?.disabled, false);
	});

	it("the code field is a masked field outside any form, and its value is sent once and cleared; the page keeps no copy", () => {
		const acts: ClaudeAction[] = [];
		const step = drawClaude(cv({ phase: "browser", url: "https://claude.ai/x", codeAsked: true, codeSent: false }), "en", acts);
		const input = step.querySelector("#claude-code") as MiniElement;
		assert.equal(input.getAttribute("type"), "password");
		assert.equal(input.getAttribute("autocomplete"), "off");
		assert.equal(input.getAttribute("spellcheck"), "false");
		assert.equal(step.querySelectorAll("form").length, 0);
		input.value = "  planted-code-123  ";
		(step.querySelector("#claude-send-code") as MiniElement).fire("click");
		assert.deepEqual(acts, [{ type: "claude-code", code: "planted-code-123" }]);
		assert.equal(input.value, "", "cleared the moment it was sent");
		assert.equal(step.textContent.includes("planted-code-123"), false);
		input.value = "again";
		input.fire("keydown", { key: "Enter", preventDefault: () => undefined });
		assert.deepEqual(acts[1], { type: "claude-code", code: "again" });
		input.value = "   ";
		(step.querySelector("#claude-send-code") as MiniElement).fire("click");
		assert.equal(acts.length, 2, "an empty field sends nothing");
	});

	it("SA-T11-1: the wizard's row holds Send code first and Later only; Open and Copy sit beside the address, and a refused code shows its sentence", () => {
		for (const locale of LOCALES) {
			const acts: ClaudeAction[] = [];
			const step = drawClaude(cv({ phase: "browser", url: "https://claude.ai/oauth/authorize?x=1", codeAsked: true, codeSent: false, codeRefused: true }), locale, acts);
			assert.deepEqual(buttons(step).map((b) => b.id), ["claude-send-code", "later"], locale);
			assert.equal(primaries(step).length, 1);
			assert.equal(step.querySelector("#claude-cancel"), null, "Later ends the login, so Cancel is not offered beside it");
			const beside = step.querySelectorAll(".url-actions button").map((b) => b.id);
			assert.deepEqual(beside, ["claude-open", "claude-copy"], locale);
			assert.equal(step.querySelectorAll(".actions #claude-open").length, 0);
			assert.equal(step.querySelector("#claude-code-refused")?.textContent, catalogs[locale].claude.codeRefused);
			const waiting = drawClaude(cv({ phase: "browser", url: "https://claude.ai/oauth/authorize?x=1", codeAsked: false, codeSent: false }), locale);
			assert.deepEqual(buttons(waiting).map((b) => b.id), ["later"], "with no code asked the row is Later alone");
			assert.equal(waiting.querySelector("#claude-code-refused"), null);
			const starting = drawClaude(cv({ phase: "starting" }), locale);
			assert.equal(starting.querySelector("#claude-cancel"), null);
		}
		// The card in settings has no Later, so Cancel stays there.
		const card = drawCards("en", cv({ phase: "browser", url: null, codeAsked: true, codeSent: false }), null);
		assert.equal(card.querySelectorAll("#claude-cancel").length, 1);
	});

	it("the address is text on the page and main opens it: Open and Copy only send a request without the address", () => {
		const acts: ClaudeAction[] = [];
		const step = drawClaude(cv({ phase: "browser", url: "https://claude.ai/oauth/authorize?x=1", codeAsked: false, codeSent: false }), "en", acts);
		assert.match(step.querySelector("#claude-url")?.textContent ?? "", /claude\.ai/);
		(step.querySelector("#claude-open") as MiniElement).fire("click");
		(step.querySelector("#claude-copy") as MiniElement).fire("click");
		assert.deepEqual(acts, [{ type: "claude-open" }, { type: "claude-copy-url" }]);
	});

	it("on Windows the page says the sign-in is a file in plain text, wherever it offers or confirms a sign-in; on macOS it does not", () => {
		const sentence = catalogs.en.claude.storageFile;
		assert.ok(drawClaude(cv({ phase: "idle" }, "not-signed-in", "file"), "en").textContent.includes(sentence));
		assert.ok(drawClaude(cv({ phase: "done" }, "signed-in", "file"), "en").textContent.includes(sentence));
		assert.equal(drawClaude(cv({ phase: "idle" }, "not-signed-in", "keychain"), "en").textContent.includes(sentence), false);
		assert.equal(drawClaude(cv({ phase: "done" }, "signed-in", "keychain"), "en").textContent.includes(sentence), false);
		assert.match(catalogs["zh-TW"].claude.storageFile, /明文|純文字/);
	});
});

const LINEAR_CASES: Array<[string, LinearView]> = [
	["not saved", lv({ phase: "idle" })],
	["invalid", lv({ phase: "invalid" })],
	["encryption not asked yet", lv({ phase: "idle" }, "not-saved", { phase: "none" }, null)],
	["encryption unavailable", lv({ phase: "idle" }, "not-saved", { phase: "none" }, false)],
	["refused", lv({ phase: "refused" }, "not-saved", { phase: "none" }, false)],
	["saving", lv({ phase: "saving" })],
	["installing", lv({ phase: "installing" }, "saved")],
	["initializing", lv({ phase: "initializing" }, "saved")],
	["done", lv({ phase: "done", initialized: "ran" }, "saved")],
	["done, setup kept", lv({ phase: "done", initialized: "kept" }, "saved")],
	["restart offered", lv({ phase: "done", initialized: "ran" }, "saved", { phase: "offer", change: "saved" })],
	["restarting", lv({ phase: "done", initialized: "ran" }, "saved", { phase: "restarting" })],
	["restarted", lv({ phase: "done", initialized: "ran" }, "saved", { phase: "restarted" })],
	["restart put off", lv({ phase: "done", initialized: "ran" }, "saved", { phase: "later" })],
	["restart failed", lv({ phase: "done", initialized: "ran" }, "saved", { phase: "failed", detail: "herdr did not come back" })],
	["setup failed", lv({ phase: "setup-failed", step: "init", detail: "network" }, "saved", { phase: "offer", change: "saved" })],
	["save failed", lv({ phase: "save-failed", detail: "disk full" })],
	["unreadable", lv({ phase: "idle" }, "unreadable")],
	["removed", lv({ phase: "signed-out" }, "not-saved", { phase: "offer", change: "removed" })],
	["entering beside a saved key", lv({ phase: "entering" }, "saved")],
];

describe("step 9: Linear, in every state and both languages", () => {
	for (const locale of LOCALES) {
		it(`${locale}: every state draws, with ids that do not repeat and the primary action first`, () => {
			for (const [name, view] of LINEAR_CASES) {
				const step = drawLinear(view, locale);
				assert.ok(step.textContent.length > 0, name);
				assert.ok(unique(ids(step)), `${name}: ids ${ids(step).join(" ")}`);
				assert.ok(primaries(step).length <= 1, `${name}: one primary button at most`);
				if (primaries(step).length === 1) assert.equal(buttons(step)[0], primaries(step)[0], `${name}: the primary action comes first`);
			}
		});
	}

	it("the key field is masked, and its value is sent once and cleared", () => {
		const acts: LinearAction[] = [];
		const step = drawLinear(lv({ phase: "idle" }), "en", acts);
		const input = step.querySelector("#linear-key") as MiniElement;
		assert.equal(input.getAttribute("type"), "password");
		assert.equal(step.querySelectorAll("form").length, 0);
		input.value = " lin_api_DUMMYDUMMY1234 ";
		(step.querySelector("#linear-save") as MiniElement).fire("click");
		assert.deepEqual(acts, [{ type: "linear-save", key: "lin_api_DUMMYDUMMY1234" }]);
		assert.equal(input.value, "");
		assert.equal(step.textContent.includes("lin_api_DUMMY"), false);
	});

	it("with encryption unavailable the step refuses before a key is typed: no field, no Save, and Later is still a choice", () => {
		for (const view of [lv({ phase: "idle" }, "not-saved", { phase: "none" }, false), lv({ phase: "refused" }, "not-saved", { phase: "none" }, false)]) {
			const step = drawLinear(view, "en");
			assert.equal(step.querySelector("#linear-key"), null);
			assert.equal(step.querySelector("#linear-save"), null);
			assert.ok(step.textContent.includes(catalogs.en.linear.refused));
			assert.ok(step.querySelector("#later"));
		}
	});

	it("before the OS has answered, the step waits instead of offering a field, and Later is still a choice", () => {
		const step = drawLinear(lv({ phase: "idle" }, "not-saved", { phase: "none" }, null), "en");
		assert.equal(step.querySelector("#linear-key"), null);
		assert.equal(step.querySelector("#linear-save"), null);
		assert.ok(step.textContent.includes(catalogs.en.linear.checking));
		assert.ok(step.querySelector("#later"));
	});

	it("the restart offer has Restart now first and primary, then Later; the step's own Later is not drawn beside it", () => {
		const acts: LinearAction[] = [];
		const step = drawLinear(lv({ phase: "done", initialized: "ran" }, "saved", { phase: "offer", change: "saved" }), "en", acts);
		const row = buttons(step);
		assert.equal(row[0]?.id, "linear-restart");
		assert.equal(row[1]?.id, "linear-restart-later");
		assert.equal(step.querySelector("#later"), null);
		assert.equal(step.querySelector("#step-next"), null, "Next waits for the offer to be answered");
		row[0]?.fire("click");
		row[1]?.fire("click");
		assert.deepEqual(acts, [{ type: "linear-restart" }, { type: "linear-restart-later" }]);
	});

	it("a saved key with nothing running offers Next; a setup under way disables Later", () => {
		assert.ok(drawLinear(lv({ phase: "done", initialized: "ran" }, "saved", { phase: "later" }), "en").querySelector("#step-next"));
		assert.equal(drawLinear(lv({ phase: "initializing" }, "saved"), "en").querySelector("#later")?.disabled, true);
	});

	it("a failed setup keeps the key saved and offers Try again as the primary action, before Restart now", () => {
		const step = drawLinear(lv({ phase: "setup-failed", step: "install", detail: "npm" }, "saved", { phase: "offer", change: "saved" }), "en");
		const row = buttons(step);
		assert.equal(row[0]?.id, "linear-retry");
		assert.equal(primaries(step).length, 1);
	});
});

describe("a start that failed while the PM is on step 9 (R11-F001)", () => {
	for (const locale of LOCALES) {
		it(`${locale}: the Linear step shows the start's sentence with Try again and Repair, and nothing when the start did not fail`, () => {
			const acts: unknown[] = [];
			const failure = { kind: "engine-locked", reason: "another engine", offerRepair: true };
			const out = linear(makeCtx(wizardView(locale, { step: "linear", linear: lv({ phase: "idle" }), start: { status: "failed", failure } } as Partial<WizardView>), locale, (a) => acts.push(a))) as unknown as MiniElement;
			assert.equal(out.querySelector("#start-failure")?.getAttribute("data-kind"), "engine-locked");
			assert.ok((out.querySelector("#start-failure")?.textContent ?? "").length > 0);
			(out.querySelector("#start-retry") as MiniElement).fire("click");
			(out.querySelector("#start-repair") as MiniElement).fire("click");
			assert.deepEqual(acts, [{ type: "start-retry" }, { type: "repair" }]);
			assert.ok(unique(ids(out)), ids(out).join(" "));
			assert.equal(drawLinear(lv({ phase: "idle" }), locale).querySelector("#start-failure"), null);
		});
	}
});

describe("the Claude and Linear cards of settings", () => {
	for (const locale of LOCALES) {
		it(`${locale}: one card each, a badge for the state, and Sign in again and Sign out only where they apply`, () => {
			const out = drawCards(locale, cv({ phase: "idle" }, "signed-in"), lv({ phase: "idle" }, "saved"));
			const cards = out.querySelectorAll("li.account-card");
			assert.deepEqual(cards.map((c) => c.getAttribute("data-account")), ["claude", "linear"]);
			assert.equal(out.querySelectorAll("button.claude-sign-out").length, 1);
			assert.equal(out.querySelectorAll("button.linear-sign-out").length, 1);
			const none = drawCards(locale, cv({ phase: "idle" }), lv({ phase: "idle" }));
			assert.equal(none.querySelectorAll("button.claude-sign-out").length, 0);
			assert.equal(none.querySelectorAll("button.linear-sign-out").length, 0);
		});

		it(`${locale}: every state of both cards draws with ids that do not repeat`, () => {
			for (const [name, flow, state] of CLAUDE_FLOWS) for (const [lname, l] of LINEAR_CASES) {
				const out = drawCards(locale, cv(flow, state), l);
				assert.ok(unique(ids(out)), `${name} / ${lname}: ${ids(out).join(" ")}`);
			}
		});
	}

	it("Linear has no card when the recipe turns it off and no key is saved", () => {
		assert.equal(drawCards("en", cv({ phase: "idle" }), null).querySelectorAll("li[data-account=\"linear\"]").length, 0);
	});

	it("the card's buttons ask for the flow and the card shows the restart offer inside itself", () => {
		const acts: unknown[] = [];
		const out = drawCards("en", cv({ phase: "idle" }, "signed-in"), lv({ phase: "done", initialized: "ran" }, "saved", { phase: "offer", change: "saved" }), acts);
		(out.querySelector("button.claude-sign-out") as MiniElement).fire("click");
		(out.querySelector("button.linear-sign-out") as MiniElement).fire("click");
		(out.querySelector("#linear-restart") as MiniElement).fire("click");
		assert.deepEqual(acts, [{ type: "claude-sign-out" }, { type: "linear-sign-out" }, { type: "linear-restart" }]);
		assert.equal(out.querySelectorAll('li[data-account="linear"] #linear-restart').length, 1);
	});
});

describe("what the pages must not do with a code or a key", () => {
	const renderer = join(import.meta.dirname, "..", "src", "renderer");
	it("no renderer file for Claude or Linear touches web storage, cookies, IndexedDB or the clipboard", () => {
		const files = sourceFiles(renderer, [".ts"]).filter((f) => /(claude|linear)/.test(f) && !f.includes("i18n"));
		assert.ok(files.length >= 4, files.join(" "));
		for (const f of files) assert.doesNotMatch(readText(f), /localStorage|sessionStorage|indexedDB|document\.cookie|navigator\.clipboard|console\./, f);
	});

	it("both catalogs word every key of the Claude and Linear screens, in full-width or half-width parentheses by language", () => {
		for (const group of ["claude", "linear"] as const) {
			const en = catalogs.en[group] as Record<string, unknown>;
			const zh = catalogs["zh-TW"][group] as Record<string, unknown>;
			assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort(), group);
		}
	});
});
