import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { ForgeFlow, ForgeView } from "../src/shared/accounts.ts";
import type { SettingsView, WizardView } from "../src/shared/wizard.ts";
import { catalogs } from "../src/renderer/i18n/index.ts";
import { hostId } from "../src/renderer/accounts/forge-panel.ts";
import { carryPasswords, restorePasswords } from "../src/renderer/dom.ts";
import { accounts } from "../src/renderer/settings/accounts.ts";
import { makeSettingsCtx } from "../src/renderer/settings/common.ts";
import { makeCtx } from "../src/renderer/wizard/common.ts";
import { hosts } from "../src/renderer/wizard/hosts.ts";
import { installMiniDom, MiniElement } from "./harness/mini-dom.ts";
import { flattenKeys, readText, valueAt } from "./harness/ui-rules.ts";

// The code-host screens drawn without a browser (task 10 fix round): one card per host in settings, ids that do not repeat between hosts, a token that stays with its host across a redraw, one row
// of actions per step with the primary button first, the words of the left-alone note, the plain-text outcome, and the parentheses and capitals of a host name.

let undo = (): void => undefined;
before(() => {
	undo = installMiniDom();
});
after(() => undo());

const forgeView = (kind: "github" | "gitlab", host: string, flow: ForgeFlow, state: ForgeView["state"] = "not-signed-in"): ForgeView => ({ kind, host, state, entries: [], flow });

const settingsView = (forges: ForgeView[], locale: "en" | "zh-TW" = "en"): SettingsView => ({ locale, section: "accounts", later: [], forges, recipe: null, appVersion: "0", dev: true });

const drawSettings = (forges: ForgeView[], locale: "en" | "zh-TW" = "en"): MiniElement => accounts(makeSettingsCtx(settingsView(forges, locale), locale, () => undefined)) as unknown as MiniElement;

const wizardView = (current: ForgeView, locale: "en" | "zh-TW" = "en"): WizardView =>
	({ step: "hosts", locale, hosts: { forges: [{ kind: current.kind, host: current.host }], index: 0, current }, later: [], linearOffered: false }) as unknown as WizardView;

const drawHosts = (current: ForgeView, locale: "en" | "zh-TW" = "en"): MiniElement => hosts(makeCtx(wizardView(current, locale), locale, () => undefined)) as unknown as MiniElement;

const READY: ForgeFlow = { phase: "ready" };

describe("settings: one card per host, ids that are the host's own", () => {
	it("draws one card for each host with the state, the buttons and the flow inside it, and no second panel under the list", () => {
		const section = drawSettings([forgeView("github", "github.com", { phase: "left-alone", foreign: [{ name: "gh:github.com", account: "sbd-foreign-user" }], left: [] }, "foreign"), forgeView("gitlab", "gitlab.com", { phase: "idle" }, "signed-in")]);
		const cards = section.querySelectorAll("li.forge-card");
		assert.equal(cards.length, 2, "one card per host");
		assert.deepEqual(cards.map((c) => c.getAttribute("data-forge")), ["github.com", "gitlab.com"]);
		assert.equal(section.querySelectorAll(".forge-panel").length, 1, "only the host with something to say has a flow");
		const github = cards[0] as MiniElement;
		assert.equal(github.querySelectorAll(".forge-panel").length, 1, "the flow is inside its own card");
		assert.equal(github.querySelectorAll(".forge-sign-out").length, 1, "the buttons are in the card");
		assert.equal(section.querySelectorAll("h3").length, 0, "no heading repeats the host's name");
		assert.equal(section.querySelectorAll(".forge-holder").length, 0);
	});

	it("says the state's sentence once: the note is left out while the flow speaks the same refusal", () => {
		const foreign = forgeView("github", "github.com", { phase: "foreign", entries: [{ name: "gh:github.com", account: "someone" }], changed: [] }, "foreign");
		const speaking = drawSettings([foreign]);
		const sentence = catalogs.en.forge.foreign.replace("{host}", "github.com").replace("{tool}", "GitHub");
		assert.equal(speaking.textContent.split(sentence).length - 1, 1, "the refusal appears once");
		const quiet = drawSettings([{ ...foreign, flow: { phase: "idle" } }]);
		assert.equal(quiet.textContent.split(sentence).length - 1, 1, "an idle host shows the note instead, also once");
		assert.equal(quiet.querySelectorAll(".forge-panel").length, 0);
	});

	it("gives every part of two GitLab hosts' panels an id of its own", () => {
		const section = drawSettings([forgeView("gitlab", "gitlab.one.example", READY), forgeView("gitlab", "gitlab.two.example", READY)]);
		const ids: string[] = [];
		const collect = (el: MiniElement): void => {
			if (el.id !== "") ids.push(el.id);
			for (const c of el.children) collect(c);
		};
		collect(section);
		assert.ok(ids.length > 0);
		assert.equal(new Set(ids).size, ids.length, `no id repeats: ${ids.join(", ")}`);
		const fields = section.querySelectorAll('input[type="password"]');
		assert.equal(fields.length, 2);
		for (const field of fields) {
			const label = section.querySelectorAll("label").find((l) => l.getAttribute("for") === field.id);
			assert.ok(label, `a label points at ${field.id}`);
		}
		assert.notEqual(hostId("a.b.example"), hostId("a-b.example"), "two names that differ only in a dot and a hyphen keep different ids");
	});

	it("keeps a half-typed token with its own host across a redraw", () => {
		const forges = [forgeView("gitlab", "gitlab.one.example", READY), forgeView("gitlab", "gitlab.two.example", READY)];
		const body = new MiniElement("div");
		body.appendChild(drawSettings(forges));
		const [first, second] = body.querySelectorAll('input[type="password"]');
		(first as MiniElement).value = "token-for-ONE";
		(second as MiniElement).value = "token-for-TWO";
		// What settings.ts's draw does when another row's refresh comes in: carry, rebuild, restore.
		const typed = carryPasswords(body as unknown as Element);
		body.replaceChildren(drawSettings(forges));
		restorePasswords(body as unknown as Element, typed);
		const [again1, again2] = body.querySelectorAll('input[type="password"]');
		assert.equal((again1 as MiniElement).value, "token-for-ONE");
		assert.equal((again2 as MiniElement).value, "token-for-TWO");
	});

	it("keeps only the token typed for the host that is still on screen", () => {
		const both = [forgeView("gitlab", "gitlab.one.example", READY), forgeView("gitlab", "gitlab.two.example", READY)];
		const body = new MiniElement("div");
		body.appendChild(drawSettings(both));
		const [first, second] = body.querySelectorAll('input[type="password"]');
		(first as MiniElement).value = "token-for-ONE";
		(second as MiniElement).value = "token-for-TWO";
		const typed = carryPasswords(body as unknown as Element);
		// Host one signed in meanwhile; only host two still shows its field.
		body.replaceChildren(drawSettings([forgeView("gitlab", "gitlab.one.example", { phase: "done" }, "signed-in"), both[1] as ForgeView]));
		restorePasswords(body as unknown as Element, typed);
		const fields = body.querySelectorAll('input[type="password"]');
		assert.equal(fields.length, 1);
		assert.equal((fields[0] as MiniElement).value, "token-for-TWO", "host one's token did not move into host two's field");
	});
});

describe("one row of actions per step, the primary button first", () => {
	const rowsOf = (el: MiniElement): MiniElement[] => el.querySelectorAll(".actions");
	const labels = (row: MiniElement): string[] => row.querySelectorAll("button").map((b) => b.textContent);
	const primaryFirst = (row: MiniElement): void => {
		const buttons = row.querySelectorAll("button");
		assert.match((buttons[0] as MiniElement).className, /\bprimary\b/, `the first button of ${labels(row).join(" | ")} is the primary one`);
	};

	it("the GitLab token step: Sign in first, then the token page and Later, in one row", () => {
		const step = drawHosts(forgeView("gitlab", "gitlab.com", READY), "zh-TW");
		const rows = rowsOf(step);
		assert.equal(rows.length, 1, "one row");
		assert.deepEqual(labels(rows[0] as MiniElement), [catalogs["zh-TW"].forge.gitlab.signIn, catalogs["zh-TW"].forge.gitlab.open, catalogs["zh-TW"].hosts.later]);
		primaryFirst(rows[0] as MiniElement);
	});

	it("a refusal: Try again first, then Later", () => {
		for (const flow of [
			{ phase: "foreign", entries: [{ name: "glab:gitlab.com:token", account: "" }], changed: [] },
			{ phase: "failed", detail: "401" },
			{ phase: "timeout" },
			{ phase: "store-unavailable", detail: "x" },
			{ phase: "plain-text", detail: "x", removed: true },
			{ phase: "unverified", detail: "x" },
		] as const satisfies readonly ForgeFlow[]) {
			const step = drawHosts(forgeView("gitlab", "gitlab.com", flow), "zh-TW");
			const rows = rowsOf(step);
			assert.equal(rows.length, 1, `${flow.phase}: one row`);
			assert.deepEqual(labels(rows[0] as MiniElement), [catalogs["zh-TW"].forge.tryAgain, catalogs["zh-TW"].hosts.later], flow.phase);
			primaryFirst(rows[0] as MiniElement);
		}
	});

	it("the device code: Open GitHub first, then Copy, Cancel and Later; GitHub's Sign in then Later", () => {
		const code = rowsOf(drawHosts(forgeView("github", "github.com", { phase: "code", code: "ABCD-1234", deviceUrl: "https://github.com/login/device" })));
		assert.equal(code.length, 1);
		const en = catalogs.en;
		assert.deepEqual(labels(code[0] as MiniElement), [en.forge.github.open, en.forge.github.copy, en.forge.cancel, en.hosts.later]);
		primaryFirst(code[0] as MiniElement);
		const ready = rowsOf(drawHosts(forgeView("github", "github.com", READY)));
		assert.deepEqual(labels(ready[0] as MiniElement), [en.forge.github.signIn, en.hosts.later]);
		primaryFirst(ready[0] as MiniElement);
	});

	it("while the checks run the row holds Later alone, and Later is disabled while a login is being finished", () => {
		const checking = rowsOf(drawHosts(forgeView("gitlab", "gitlab.com", { phase: "checking" })));
		assert.equal(checking.length, 1);
		assert.equal((checking[0] as MiniElement).querySelectorAll("button").length, 1);
		const later = (el: MiniElement): MiniElement => el.querySelectorAll("#later")[0] as MiniElement;
		assert.equal(later(drawHosts(forgeView("gitlab", "gitlab.com", { phase: "checking" }))).disabled, false);
		assert.equal(later(drawHosts(forgeView("gitlab", "gitlab.com", { phase: "working" }))).disabled, true, "Later does not interrupt a login that glab is finishing");
	});

	it("once the sign-in passed, Next is the only button", () => {
		const done = rowsOf(drawHosts(forgeView("gitlab", "gitlab.com", { phase: "done" }, "signed-in")));
		assert.equal(done.length, 1);
		assert.deepEqual(labels(done[0] as MiniElement), [catalogs.en.hosts.next]);
	});
});

describe("the words of the screens", () => {
	it("the left-alone note says the plain sentence and keeps the store's names for Details", () => {
		const flow: ForgeFlow = { phase: "left-alone", foreign: [{ name: "glab:gitlab.com:token", account: "sbd-foreign-user" }], left: [{ name: "gh:github.com", account: "" }] };
		for (const locale of ["zh-TW", "en"] as const) {
			const card = drawSettings([forgeView("gitlab", "gitlab.com", flow, "left")], locale);
			const note = card.querySelectorAll('[data-role="left-alone"]')[0] as MiniElement;
			const [sentence, detailsEl] = [note.children[0] as MiniElement, note.querySelectorAll("details")[0] as MiniElement];
			assert.doesNotMatch(sentence.textContent, /glab:|gh:|sbd-foreign-user/, `${locale}: no store key in the sentence`);
			assert.ok(detailsEl.textContent.includes("glab:gitlab.com:token"), "Details names the key");
			assert.ok(detailsEl.textContent.includes("sbd-foreign-user"), "and the account");
			assert.ok(detailsEl.textContent.includes("gh:github.com"), "and what was left");
		}
		const zh = drawSettings([forgeView("gitlab", "gitlab.com", flow, "left")], "zh-TW");
		const sentence = ((zh.querySelectorAll('[data-role="left-alone"]')[0] as MiniElement).children[0] as MiniElement).textContent;
		assert.equal(sentence, "Straw Boss 沒有登出 gitlab.com：這台電腦上的登入不是它建立的，所以保持原樣。");
		const en = drawSettings([forgeView("gitlab", "gitlab.com", flow, "left")], "en");
		assert.equal(((en.querySelectorAll('[data-role="left-alone"]')[0] as MiniElement).children[0] as MiniElement).textContent, "Straw Boss did not sign out of gitlab.com: the sign-in on this computer was not made by it, so it was left as it is.");
	});

	it("the token step quotes no label of GitLab's page, in either language", () => {
		for (const locale of ["zh-TW", "en"] as const) {
			const step = catalogs[locale].forge.gitlab.step1;
			assert.doesNotMatch(step, /建立個人存取權杖|Create personal access token|Generate token/i, locale);
		}
		assert.match(catalogs["zh-TW"].forge.gitlab.step1, /按頁面最下方的建立按鈕/);
	});

	it("the plain-text screen says no token stays only when the files were read again and are clean", () => {
		const gone = drawSettings([forgeView("gitlab", "gitlab.com", { phase: "plain-text", detail: "d", removed: true })]);
		const stays = drawSettings([forgeView("gitlab", "gitlab.com", { phase: "plain-text", detail: "config.yml still holds a token", removed: false })]);
		const outcome = (el: MiniElement): MiniElement => el.querySelectorAll('[data-role="plain-outcome"]')[0] as MiniElement;
		assert.equal(outcome(gone).textContent, catalogs.en.forge.plainRemoved.replace("{host}", "gitlab.com"));
		assert.equal(outcome(stays).textContent, catalogs.en.forge.plainStays.replace("{host}", "gitlab.com"));
		assert.doesNotMatch(outcome(stays).textContent, /no token stays/);
		assert.match(stays.textContent, /config\.yml still holds a token/, "Details has the line");
	});

	it("keeps a host's capitals: no element that holds a host's name is uppercased by the style sheets", () => {
		const css = readText(join(import.meta.dirname, "..", "src", "renderer", "desk.css"));
		// h3 is the one heading style that uppercases; the cards use none, and the panel draws no heading.
		assert.match(css, /h3 \{[^}]*text-transform: uppercase/, "the sheet still uppercases h3 (so no host may be put in one)");
		const section = drawSettings([forgeView("github", "GitHub.Example.COM", { phase: "checking" })]);
		assert.equal(section.querySelectorAll("h3, th").length, 0);
		assert.ok(section.textContent.includes("GitHub.Example.COM"), "the host is shown as the recipe wrote it");
	});

	it("uses no space beside a full-width parenthesis in any zh-TW string, and no half-width one", () => {
		for (const key of flattenKeys(catalogs["zh-TW"])) {
			const text = String(valueAt(catalogs["zh-TW"], key));
			assert.doesNotMatch(text, /\s[（）]|[（）]\s/, `zh-TW ${key} has a space inside or beside a full-width parenthesis`);
			assert.doesNotMatch(text, /[()]/, `zh-TW ${key}`);
		}
	});
});
