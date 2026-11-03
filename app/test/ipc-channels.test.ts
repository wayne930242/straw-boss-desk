import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { CHANNELS } from "../src/shared/shell-state.ts";

// The preloads are CommonJS and cannot import the ESM constants, so they repeat the channel names as literals; this keeps the two lists equal (task 8b).
const preload = (name: string): string => readFileSync(join(import.meta.dirname, "..", "src", "preload", name), "utf8");

describe("the IPC channels of the preloads", () => {
	it("are the ones main registers, and the GUI preload uses only its two", () => {
		const gui = preload("gui.cts");
		assert.ok(gui.includes(`"${CHANNELS.guiOrigin}"`) && gui.includes(`"${CHANNELS.pickFolder}"`));
		assert.deepEqual([...gui.matchAll(/"(sbd:[a-z-]+)"/g)].map((m) => m[1]).sort(), [CHANNELS.guiOrigin, CHANNELS.pickFolder].sort());
	});

	it("give the shell preload the runtime page's three, the language's two, and the wizard's and settings' three each", () => {
		const shell = preload("shell.cts");
		const all = [CHANNELS.state, CHANNELS.stateChanged, CHANNELS.action, CHANNELS.locale, CHANNELS.localeChanged, CHANNELS.wizardState, CHANNELS.wizardChanged, CHANNELS.wizardAct, CHANNELS.settingsState, CHANNELS.settingsChanged, CHANNELS.settingsAct];
		assert.deepEqual([...new Set([...shell.matchAll(/"(sbd:[a-z-]+)"/g)].map((m) => m[1]))].sort(), all.sort());
	});

	it("registers in desk-window.ts a handler for every channel the shell preload sends", () => {
		const main = readFileSync(join(import.meta.dirname, "..", "src", "main", "desk-window.ts"), "utf8");
		for (const name of ["state", "action", "locale", "wizardState", "wizardAct", "settingsState", "settingsAct"] as const) assert.ok(main.includes(`CHANNELS.${name}`), name);
	});

	it("exposes strawBossDesk.pickFolder only after comparing the page's origin with the one main names", () => {
		const gui = preload("gui.cts");
		assert.match(gui, /here === origin/);
		assert.equal((gui.match(/exposeInMainWorld/g) ?? []).length, 1);
		assert.ok(gui.indexOf("here === origin") < gui.indexOf("exposeInMainWorld"));
	});
});
