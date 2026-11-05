import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { anchorOf, GUIDE_REMOVE_HEADING, GUIDE_REPO } from "../src/main/guide.ts";
import { appRoot } from "./harness/packaged.ts";

// The PM guide and the README (task 14): the page the app links to is in the file, the screenshot placeholders that tasks 16 and 17 fill are marked and named, and the guide covers each item the boss
// decided to put in it. The guide's words are not tested; its presence and its markers are.

const repo = join(appRoot, "..");
const guide = readFileSync(join(repo, "docs", "pm-guide.zh-TW.md"), "utf8");
const readme = readFileSync(join(repo, "README.md"), "utf8");

describe("the PM guide", () => {
	it("holds the heading the app opens, and its link goes to that heading in the guide's own file", () => {
		const headings = guide.split("\n").filter((l) => l.startsWith("## ")).map((l) => l.slice(3).trim());
		assert.ok(headings.includes(GUIDE_REMOVE_HEADING));
		assert.equal(GUIDE_REPO.endsWith("/docs/pm-guide.zh-TW.md"), true);
		// The contents list links to every section by the anchor GitHub makes of its heading.
		for (const h of headings.filter((x) => x !== "目錄")) assert.ok(guide.includes(`(#${anchorOf(h)})`), `the contents link to ${h}`);
	});

	it("marks every screenshot placeholder with the task that fills it and a file name under docs/images, and none of those files is claimed to exist yet", () => {
		const marks = [...guide.matchAll(/【截圖待補・任務 (16|17)】`(docs\/images\/[A-Za-z0-9.-]+\.png)`/g)];
		assert.ok(marks.length >= 6, `placeholders: ${marks.length}`);
		const names = marks.map((m) => m[2] as string);
		assert.equal(new Set(names).size, names.length, "a file name is used once");
		for (const [, task, file] of marks) {
			assert.ok(task === "16" || task === "17");
			assert.equal(existsSync(join(repo, file as string)), false, `${file} is a placeholder, so the task that fills it adds the file and removes the mark`);
		}
		// A Windows picture belongs to task 16 and a macOS picture to task 17.
		for (const [, task, file] of marks) assert.equal((file as string).includes("macos") ? "17" : "16", task);
	});

	it("covers what the boss decided it covers: install paths, SmartScreen, Gatekeeper, Smart App Control, the existing sign-in, WSL, closing the window, Claude's plain-text login, the WARP line, and Remove all data before uninstalling", () => {
		for (const needle of ["%LOCALAPPDATA%\\Programs\\Straw Boss Desk", "Application Support/straw-boss-desk", "SmartScreen", "仍要打開", "Smart App Control", "不支援", "WSL", "關閉視窗", ".credentials.json", "Cloudflare WARP", "先在應用程式裡按「移除所有資料」，再解除安裝", "鑰匙圈存取", "認證管理員"]) {
			assert.ok(guide.includes(needle), `the guide says ${needle}`);
		}
	});

	it("names the buttons by the words of the zh-TW catalog", async () => {
		const { catalogs } = await import("../src/renderer/i18n/index.ts");
		const zh = catalogs["zh-TW"];
		for (const label of [zh.settings.computer.remove.button.replace("…", ""), zh.settings.computer.remove.confirm, zh.settings.diagnostics.collect.button, zh.settings.diagnostics.repair.button, zh.settings.diagnostics.status.button, zh.settings.accounts.signInAgain, zh.settings.computer.title, zh.settings.diagnostics.title]) {
			assert.ok(guide.includes(`「${label}」`) || guide.includes(`「${label}…」`), `the guide uses 「${label}」`);
		}
	});
});

describe("the README", () => {
	it("points at the design record, the phase 2 spec, the PM guide and AGENTS.md, and each target exists", () => {
		for (const target of ["docs/specs/2026-10-25-design.md", "docs/specs/2026-11-01-phase2-shell.md", "docs/pm-guide.zh-TW.md", "AGENTS.md", "docs/releasing-profile.md", "profile/"]) {
			assert.ok(readme.includes(`(${target})`), `the README links ${target}`);
			assert.ok(existsSync(join(repo, target)), `${target} exists`);
		}
	});

	it("names the PATH entry once per platform and the removal's kill rule", () => {
		assert.match(readme, /<root>\\tools\\shims/);
		assert.match(readme, /Kill rule/);
		assert.match(readme, /Remove all data/);
	});
});
