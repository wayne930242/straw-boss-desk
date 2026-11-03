import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { describe, it } from "node:test";
import { checkPaneLookups, expandPercent, MACHINE_ENVIRONMENT_KEY, parseRegPath, pathEntries, readPaneRegistry, stubbedPaneFindings, USER_ENVIRONMENT_KEY, walkPanePath } from "../src/main/pane-path.ts";
import { createWinLocate } from "../src/main/platform/win.ts";
import { execRunner } from "../src/main/platform/exec.ts";
import type { CommandRunner } from "../src/main/platform/types.ts";

// The WSL check and the machine-PATH `pi` check (spec: Panes on Windows). The walk is a pure function of the machine value, the user value, and a
// file-exists check, so every case here is a table; the real `reg.exe` read runs once, on a Windows machine, and only has to parse.

const ENV = { SystemRoot: "C:\\Windows", USERPROFILE: "C:\\Users\\測試PM", ProgramFiles: "C:\\Program Files" };
const exists = (...files: string[]) => {
	const set = new Set(files.map((f) => f.toLowerCase()));
	return (path: string): boolean => set.has(path.toLowerCase());
};
const MACHINE = "%SystemRoot%\\system32;%SystemRoot%;%SystemRoot%\\System32\\Wbem;C:\\Program Files\\Git\\cmd";
const SHIMS = "C:\\Users\\測試PM\\AppData\\Local\\sbd 測試\\tools\\shims";

describe("the WSL check's walk", () => {
	it("reports System32\\bash.exe when it is the first bash on the machine PATH", () => {
		const found = walkPanePath({ machine: MACHINE, user: `${SHIMS};%USERPROFILE%\\bin`, exists: exists("C:\\Windows\\System32\\bash.exe", `${SHIMS}\\bash.cmd`), env: ENV });
		assert.equal(found.wslBash, true);
		assert.equal(found.firstBash, "C:\\Windows\\system32\\bash.exe", "the folder keeps the spelling the PATH gave");
		assert.equal(found.machinePi, null);
	});

	it("stays quiet when a Git for Windows bash.exe comes first", () => {
		const found = walkPanePath({ machine: "C:\\Program Files\\Git\\cmd;C:\\Program Files\\Git\\bin;%SystemRoot%\\system32", user: null, exists: exists("C:\\Program Files\\Git\\bin\\bash.exe", "C:\\Windows\\System32\\bash.exe"), env: ENV });
		assert.equal(found.wslBash, false);
		assert.equal(found.firstBash, "C:\\Program Files\\Git\\bin\\bash.exe");
	});

	it("walks the machine entries before the user's, so the shim's bash.cmd loses to WSL but wins where there is none", () => {
		const wsl = walkPanePath({ machine: MACHINE, user: SHIMS, exists: exists("C:\\Windows\\System32\\bash.exe", `${SHIMS}\\bash.cmd`), env: ENV });
		assert.equal(wsl.wslBash, true);
		const clean = walkPanePath({ machine: MACHINE, user: SHIMS, exists: exists(`${SHIMS}\\bash.cmd`), env: ENV });
		assert.equal(clean.wslBash, false);
		assert.equal(clean.firstBash, `${SHIMS}\\bash.cmd`);
	});

	it("tries the extensions of one folder in PATHEXT order, .exe before .cmd, and a folder before the next", () => {
		const both = walkPanePath({ machine: "C:\\a;C:\\b", user: null, exists: exists("C:\\a\\bash.cmd", "C:\\a\\bash.exe", "C:\\b\\bash.exe"), env: ENV });
		assert.equal(both.firstBash, "C:\\a\\bash.exe");
		const cmdOnly = walkPanePath({ machine: "C:\\a;C:\\b", user: null, exists: exists("C:\\a\\bash.cmd", "C:\\b\\bash.exe"), env: ENV });
		assert.equal(cmdOnly.firstBash, "C:\\a\\bash.cmd", "an earlier folder wins over a better extension later");
	});

	it("compares System32 without regard to case or the folder's spelling in the registry", () => {
		const found = walkPanePath({ machine: "C:\\WINDOWS\\SYSTEM32", user: null, exists: exists("c:\\windows\\system32\\bash.exe"), env: ENV });
		assert.equal(found.wslBash, true);
	});

	it("reads no bash at all as null, and a SystemRoot elsewhere as that folder", () => {
		assert.deepEqual(walkPanePath({ machine: null, user: null, exists: () => false, env: ENV }), { firstBash: null, wslBash: false, machinePi: null, machineBun: null, machineBunx: null });
		const moved = walkPanePath({ machine: "D:\\Win\\System32", user: null, exists: exists("D:\\Win\\System32\\bash.exe"), env: { SystemRoot: "D:\\Win" } });
		assert.equal(moved.wslBash, true);
	});

	it("finds a pi on the machine PATH only; one on the user PATH does not win over the shim", () => {
		const machine = walkPanePath({ machine: "C:\\Program Files\\nodejs;C:\\x", user: null, exists: exists("C:\\Program Files\\nodejs\\pi.cmd"), env: ENV });
		assert.equal(machine.machinePi, "C:\\Program Files\\nodejs\\pi.cmd");
		const user = walkPanePath({ machine: "C:\\x", user: `${SHIMS};C:\\Users\\測試PM\\AppData\\Roaming\\npm`, exists: exists("C:\\Users\\測試PM\\AppData\\Roaming\\npm\\pi.cmd"), env: ENV });
		assert.equal(user.machinePi, null);
	});
});

describe("a bun on the machine PATH (T6-F009)", () => {
	it("finds bun and bunx on the machine PATH only, with .exe before .cmd in a folder", () => {
		const machine = walkPanePath({ machine: "C:\\Program Files\\Bun;C:\\x", user: null, exists: exists("C:\\Program Files\\Bun\\bun.exe", "C:\\Program Files\\Bun\\bun.cmd", "C:\\x\\bunx.cmd"), env: ENV });
		assert.equal(machine.machineBun, "C:\\Program Files\\Bun\\bun.exe");
		assert.equal(machine.machineBunx, "C:\\x\\bunx.cmd");
		const user = walkPanePath({ machine: "C:\\x", user: `${SHIMS};C:\\Users\\測試PM\\.bun\\bin`, exists: exists(`${SHIMS}\\bun.cmd`, "C:\\Users\\測試PM\\.bun\\bin\\bun.exe"), env: ENV });
		assert.equal(user.machineBun, null, "a bun on the user PATH comes after the shims entry, which is first there");
		assert.equal(user.machineBunx, null);
	});
});

describe("expanding and splitting a registry Path value", () => {
	it("expands %VAR% entries from the environment, case-insensitively, and leaves an unknown name as it is", () => {
		assert.equal(expandPercent("%userprofile%\\bin", ENV), "C:\\Users\\測試PM\\bin");
		assert.equal(expandPercent("%NOPE%\\bin", ENV), "%NOPE%\\bin");
		assert.equal(expandPercent("C:\\100%\\bin", ENV), "C:\\100%\\bin", "a lone percent sign stays");
	});

	it("drops blanks and quotes, and keeps the order", () => {
		assert.deepEqual(pathEntries(' C:\\a ;;"C:\\b c";%SystemRoot%;', ENV), ["C:\\a", "C:\\b c", "C:\\Windows"]);
		assert.deepEqual(pathEntries(null, ENV), []);
	});
});

describe("parsing reg.exe's answer", () => {
	const en = ["", "HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment", "    Path    REG_EXPAND_SZ    %SystemRoot%\\system32;%SystemRoot%;C:\\Program Files\\Git\\cmd", ""].join("\r\n");
	// The key header is translated on a localized Windows; the value name and the type are not.
	const zh = ["", "HKEY_CURRENT_USER\\Environment", "    Path    REG_SZ    C:\\Users\\測試PM\\bin;D:\\x", ""].join("\r\n");

	it("takes the value and its type", () => {
		assert.deepEqual(parseRegPath(en), { type: "REG_EXPAND_SZ", value: "%SystemRoot%\\system32;%SystemRoot%;C:\\Program Files\\Git\\cmd" });
		assert.deepEqual(parseRegPath(zh), { type: "REG_SZ", value: "C:\\Users\\測試PM\\bin;D:\\x" });
	});

	it("reads an empty value, and no Path line at all, as what they are", () => {
		assert.deepEqual(parseRegPath("HKEY_CURRENT_USER\\Environment\r\n    Path    REG_SZ    \r\n"), { type: "REG_SZ", value: "" });
		assert.equal(parseRegPath("HKEY_CURRENT_USER\\Environment\r\n    TEMP    REG_EXPAND_SZ    %USERPROFILE%\\AppData\\Local\\Temp\r\n"), null);
		assert.equal(parseRegPath("錯誤: 系統找不到指定的登錄機碼或值。\r\n"), null);
	});

	it("reads both keys with reg.exe by its absolute path, and a key reg.exe cannot find as null", async () => {
		const calls: string[][] = [];
		const run: CommandRunner = async (file, args) => {
			calls.push([file, ...args]);
			return args[1] === MACHINE_ENVIRONMENT_KEY ? { code: 0, stdout: en, stderr: "" } : { code: 1, stdout: "", stderr: "ERROR: The system was unable to find the specified registry key or value." };
		};
		const locate = createWinLocate({ systemRoot: "C:\\Windows" });
		const read = await readPaneRegistry(run, locate);
		assert.deepEqual(read, { machine: "%SystemRoot%\\system32;%SystemRoot%;C:\\Program Files\\Git\\cmd", user: null });
		assert.deepEqual(calls, [
			["C:\\Windows\\System32\\reg.exe", "query", MACHINE_ENVIRONMENT_KEY, "/v", "Path"],
			["C:\\Windows\\System32\\reg.exe", "query", USER_ENVIRONMENT_KEY, "/v", "Path"],
		]);
		assert.ok(calls.every((c) => c[2]?.startsWith("HKLM\\") || c[2]?.startsWith("HKCU\\")) && calls.every((c) => c[1] === "query"), "only queries: no write to any hive");
		const checked = await checkPaneLookups({ run, locate, exists: exists("C:\\Windows\\System32\\bash.exe"), env: ENV });
		assert.equal(checked.wslBash, true);
	});
});

describe("the real reg.exe, on Windows", { skip: process.platform === "win32" ? false : "Windows only: reg.exe" }, () => {
	it("reads the machine and user Path values once and they parse", async () => {
		const locate = createWinLocate();
		const read = await readPaneRegistry(execRunner(), locate);
		assert.equal(typeof read.machine, "string", "every Windows has a machine Path");
		assert.match(read.machine as string, /system32/i);
		assert.ok(read.user === null || typeof read.user === "string");
		const found = await checkPaneLookups({ run: execRunner(), locate, exists: existsSync, env: process.env });
		assert.equal(typeof found.wslBash, "boolean");
	});
});

describe("the e2e's WSL stub", () => {
	it("answers only in a development build and only while the variable is set", () => {
		assert.deepEqual(stubbedPaneFindings({ SBD_TEST_WSL_BASH: "C:\\Windows\\System32\\bash.exe" }, true), { firstBash: "C:\\Windows\\System32\\bash.exe", wslBash: true, machinePi: null, machineBun: null, machineBunx: null });
		assert.equal(stubbedPaneFindings({ SBD_TEST_WSL_BASH: "C:\\x\\bash.exe" }, false), null, "a release build never reads it");
		assert.equal(stubbedPaneFindings({}, true), null);
		assert.equal(stubbedPaneFindings({ SBD_TEST_WSL_BASH: "" }, true), null);
	});
});
