import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { KeepAwake, readKeepAwake, type PowerBlockerLike } from "../src/main/computer/keep-awake.ts";
import { statusFields } from "../src/main/diagnostics/status.ts";
import { anchorOf, guideUrl, GUIDE_REMOVE_HEADING, GUIDE_REPO } from "../src/main/guide.ts";
import { preLaunch } from "../src/main/pre-launch.ts";
import { claudeItem, safeStorageItem } from "../src/main/removal/names.ts";
import { hasRemoveUserPath, hasStopStack } from "../src/main/runtime/args.ts";
import { stopForRemoval, stopSequenceReport, type StopParts } from "../src/main/stop-sequence.ts";
import type { UserPath } from "../src/main/platform/types.ts";

const bases: string[] = [];
after(() => {
	for (const b of bases) rmSync(b, { recursive: true, force: true });
});
const scratch = (): string => {
	const b = mkdtempSync(join(tmpdir(), "sbd-small-"));
	bases.push(b);
	return b;
};

describe("the two Keychain item names", () => {
	it("names the Safe Storage item after the running build, so a development build never names the shipped one", () => {
		assert.equal(safeStorageItem("Straw Boss Desk Dev"), "Straw Boss Desk Dev Safe Storage");
		assert.notEqual(safeStorageItem("Straw Boss Desk Dev"), safeStorageItem("Straw Boss Desk"));
		assert.throws(() => safeStorageItem(" "), /empty/);
	});
	it("names Claude Code's item from the first 8 hex digits of the SHA-256 of the app's CLAUDE_CONFIG_DIR, never the bare item", () => {
		const dir = "/Users/pm/Library/Application Support/straw-boss-desk/claude";
		const expected = `Claude Code-credentials-${createHash("sha256").update(dir).digest("hex").slice(0, 8)}`;
		assert.equal(claudeItem(dir), expected);
		assert.match(claudeItem(dir), /^Claude Code-credentials-[0-9a-f]{8}$/);
		assert.notEqual(claudeItem(dir), claudeItem(`${dir}2`));
	});
});

describe("the uninstaller's flags", () => {
	it("are matched exactly", () => {
		assert.ok(hasStopStack(["app", "--stop-stack"]) && !hasStopStack(["--stop-stack=1", "--stop-stacks"]));
		assert.ok(hasRemoveUserPath(["a", "--remove-user-path"]) && !hasRemoveUserPath(["--remove-user-path=1"]));
	});
});

describe("the NSIS uninstall script", () => {
	const nsh = readFileSync(join(import.meta.dirname, "..", "build", "installer.nsh"), "utf8");
	const code = nsh.split("\n").filter((l) => !l.trimStart().startsWith(";")).join("\n");

	it("is included by electron-builder", () => {
		const config = JSON.parse(readFileSync(join(import.meta.dirname, "..", "electron-builder.json"), "utf8")) as { nsis: { include?: string; deleteAppDataOnUninstall?: boolean } };
		assert.equal(config.nsis.include, "build/installer.nsh");
		assert.equal(config.nsis.deleteAppDataOnUninstall, false, "the uninstaller never deletes the data root");
	});

	it("stops the stack first, whether or not this is an update, and only when the installed program is still there", () => {
		const stop = code.indexOf("--stop-stack");
		assert.ok(stop > 0);
		assert.ok(code.indexOf('FileExists} "$INSTDIR\\${APP_EXECUTABLE_FILENAME}"') > 0 && code.indexOf("FileExists") < stop);
		const guard = code.indexOf("${ifNot} ${isUpdated}");
		assert.ok(guard > stop, "the stop comes before the isUpdated guard, so an update stops the stack too");
	});

	it("removes the PATH entry only outside an update: --remove-user-path sits inside the isUpdated guard and nowhere else", () => {
		const guard = code.indexOf("${ifNot} ${isUpdated}");
		const end = code.indexOf("${endIf}", guard);
		const remove = code.indexOf("--remove-user-path");
		assert.ok(guard > 0 && remove > guard && remove < end, "inside the guard");
		assert.equal(code.split("--remove-user-path").length - 1, 1, "once");
		assert.doesNotMatch(code, /tools\\shims|RegDelete|EnVar|WriteRegExpandStr/, "the script itself touches no registry value; the app does, through UserPath");
	});

	it("waits for each call and does not stop the uninstall on their exit codes", () => {
		assert.equal((code.match(/ExecWait/g) ?? []).length, 2);
		assert.doesNotMatch(code, /Abort|Quit/);
	});
});

describe("pre-launch (before userData, the lock and any window)", () => {
	const userPath = (log: string[], over: Partial<UserPath> = {}): UserPath => ({ supported: true, read: async () => null, ensureFirst: async () => ({ changed: false }), remove: async (e) => (log.push(`remove ${e}`), { changed: true }), ...over });
	const base = { root: "C:\\Users\\PM\\AppData\\Local\\sbd 測試", home: "C:\\Users\\PM", platform: "win32" as const };

	it("continues on an ordinary launch", async () => {
		assert.deepEqual(await preLaunch({ ...base, argv: ["app"], userPath: userPath([]), exists: () => true, finish: () => ({ found: false }) }), { action: "continue" });
	});
	it("removes the app's one PATH entry for --remove-user-path whether or not the root exists, and exits 0", async () => {
		const log: string[] = [];
		assert.deepEqual(await preLaunch({ ...base, argv: ["app", "--remove-user-path"], userPath: userPath(log), exists: () => false, finish: () => ({ found: false }) }), { action: "exit", code: 0 });
		assert.deepEqual(log, ["remove C:\\Users\\PM\\AppData\\Local\\sbd 測試\\tools\\shims"]);
	});
	it("exits 1 when the PATH entry cannot be removed, and 0 on macOS where there is none", async () => {
		assert.deepEqual(await preLaunch({ ...base, argv: ["--remove-user-path"], userPath: userPath([], { remove: async () => { throw new Error("denied"); } }), finish: () => ({ found: false }) }), { action: "exit", code: 1 });
		assert.deepEqual(await preLaunch({ ...base, argv: ["--remove-user-path"], userPath: userPath([], { supported: false }), finish: () => ({ found: false }) }), { action: "exit", code: 0 });
	});
	it("ends --stop-stack at once when there is no root, so the uninstall after Remove all data re-creates nothing", async () => {
		assert.deepEqual(await preLaunch({ ...base, argv: ["--stop-stack"], userPath: userPath([]), exists: () => false, finish: () => ({ found: false }) }), { action: "exit", code: 0 });
		assert.deepEqual(await preLaunch({ ...base, argv: ["--stop-stack"], userPath: userPath([]), exists: () => true, finish: () => ({ found: false }) }), { action: "continue" });
	});
	it("finishes a pending removal first and then starts as on a new machine; a failed deletion stops the launch with the folder named", async () => {
		assert.deepEqual(await preLaunch({ ...base, argv: ["app"], userPath: userPath([]), finish: () => ({ found: true, removed: true, fallbackRemoved: false }) }), { action: "continue" });
		// With --stop-stack the root is gone afterwards, so there is nothing to stop.
		assert.deepEqual(await preLaunch({ ...base, argv: ["--stop-stack"], userPath: userPath([]), exists: () => false, finish: () => ({ found: true, removed: true, fallbackRemoved: false }) }), { action: "exit", code: 0 });
		assert.deepEqual(await preLaunch({ ...base, argv: ["app"], userPath: userPath([]), finish: () => ({ found: true, removed: false, fallbackRemoved: false, error: "EBUSY" }) }), { action: "stop", code: 1, folder: base.root, detail: "EBUSY" });
	});
});

describe("keep awake", () => {
	const blocker = (): PowerBlockerLike & { started: number; stopped: number[] } => {
		const live = new Set<number>();
		const b = { started: 0, stopped: [] as number[], start: () => (live.add(++b.started), b.started), stop: (id: number) => (live.delete(id), void b.stopped.push(id)), isStarted: (id: number) => live.has(id) };
		return b;
	};
	it("is off by default and when the file is damaged", () => {
		const root = scratch();
		assert.equal(readKeepAwake({ state: join(root, "state") }), false);
		mkdirSync(join(root, "state"));
		writeFileSync(join(root, "state", "computer.json"), "{oops");
		assert.equal(readKeepAwake({ state: join(root, "state") }), false);
	});
	it("saves the setting, blocks suspension while on, and applies the saved setting at launch", () => {
		const state = join(scratch(), "state");
		const b = blocker();
		const k = new KeepAwake({ state }, b);
		k.apply();
		assert.equal(k.on, false);
		k.change(true);
		assert.equal(k.on, true);
		k.change(true);
		assert.equal(b.started, 1, "turned on twice, blocked once");
		assert.deepEqual(JSON.parse(readFileSync(join(state, "computer.json"), "utf8")), { keepAwake: true });
		const again = new KeepAwake({ state }, b);
		again.apply();
		assert.equal(again.on, true);
		k.change(false);
		assert.equal(k.on, false);
		assert.deepEqual(b.stopped, [1]);
	});
});

describe("stopSequenceReport", () => {
	const parts = (stop: StopParts["supervisor"]["stop"]): StopParts => {
		const acct = { dispose() {}, settled: async () => undefined };
		return { supervisor: { beginQuit() {}, stop }, updates: { dispose() {} }, accounts: acct, claude: acct, linear: acct, engineHost: { dispose: async () => undefined }, log() {} };
	};
	it("names the programs the stop could not end, by pid and file, and passes the wait option to the stop", async () => {
		let seen: unknown;
		const outcome = await stopSequenceReport(parts(async (o) => ((seen = o), { ok: false, leftovers: [{ pid: 7, file: "node" }, "junk"] })), { waitForTools: true });
		assert.deepEqual(outcome, { ok: false, leftovers: [{ pid: 7, file: "node" }] });
		assert.deepEqual(seen, { waitForTools: true });
	});
	it("stopForRemoval always waits for the tools folder to empty, as Repair's stop does", async () => {
		let seen: unknown = "unset";
		const outcome = await stopForRemoval(parts(async (o) => ((seen = o), { ok: true, leftovers: [] })));
		assert.deepEqual(outcome, { ok: true, leftovers: [] });
		assert.deepEqual(seen, { waitForTools: true });
	});
	it("reports a stop that throws as not stopped", async () => {
		assert.deepEqual(await stopSequenceReport(parts(async () => { throw new Error("x"); })), { ok: false, leftovers: [] });
	});
});

describe("the status Diagnostics shows", () => {
	it("passes on four named fields and the key names, never the page's address or token", () => {
		const raw = JSON.stringify({ state: "live", primary: true, desk: true, version: "0.59.0", gui: { url: "http://127.0.0.1:41234/abcdef/", token: "SECRET" }, control: "SECRET2" });
		const f = statusFields(raw);
		assert.deepEqual(f, { state: "live", primary: true, desk: true, version: "0.59.0", keys: ["control", "desk", "gui", "primary", "state", "version"] });
		assert.ok(!JSON.stringify(f).includes("SECRET"));
	});
	it("leaves out a value that is not the expected kind, and answers null for output that is not a JSON object", () => {
		assert.deepEqual(statusFields('{"state":"http://127.0.0.1:1/token","primary":"yes","version":3}'), { state: null, primary: null, desk: null, version: "3", keys: ["primary", "state", "version"] });
		for (const bad of ["", "nope", "[]", "3", "null"]) assert.equal(statusFields(bad), null, bad);
	});
});

describe("the guide address", () => {
	it("is the repository's guide and the section for removing a sign-in by hand", () => {
		assert.equal(guideUrl(), `${GUIDE_REPO}#${encodeURIComponent(anchorOf(GUIDE_REMOVE_HEADING))}`);
		assert.equal(anchorOf("A heading, with (marks)!"), "a-heading-with-marks");
	});
});
