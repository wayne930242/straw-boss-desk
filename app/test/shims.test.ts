import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, linkSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { removeTree } from "../src/main/bootstrap/fsutil.ts";
import { cmdShim, everyShimFile, shPi, shimFiles, SHIM_SPECS } from "../src/main/bootstrap/stages/shim-files.ts";
import { pathFiles } from "../src/main/bootstrap/stages/path-files.ts";
import { shimDrop } from "../src/main/bootstrap/stages/pi-shim.ts";
import { systemEnv } from "../src/main/env.ts";
import { computeLayout, toolDir, type Layout } from "../src/main/paths.ts";
import { run } from "./harness/e2e-light.ts";

// The Windows shims (spec: Panes on Windows). What they say is checked everywhere; what they do is run where it can be: the POSIX `pi` under a bash of
// version 4 or later (the MSYS bash of Git for Windows is 5; macOS's own is 3.2), the batch files on Windows with roots that hold cmd's special
// characters, the T5-F007 pattern. The Windows e2e (`e2e-light.test.ts`) runs the real ones against the real stack.

const scratch: string[] = [];
after(() => {
	for (const d of scratch) removeTree(d);
});
const isWindows = process.platform === "win32";

describe("what the shim files say", () => {
	const files = shimFiles(["bun"]);

	it("lists pi.cmd, pi, and bash.cmd, and bun.cmd and bunx.cmd only for a recipe that names bun", () => {
		assert.deepEqual(Object.keys(shimFiles([])).sort(), ["bash.cmd", "pi", "pi.cmd"]);
		assert.deepEqual(Object.keys(files).sort(), ["bash.cmd", "bun.cmd", "bunx.cmd", "pi", "pi.cmd"]);
		assert.deepEqual([...everyShimFile(["bun"])].sort(), Object.keys(files).sort());
		assert.deepEqual(everyShimFile([]).sort(), ["bash.cmd", "pi", "pi.cmd"]);
	});

	it("is ASCII only, with CRLF in every batch file and LF in the POSIX one", () => {
		for (const [name, text] of Object.entries(files)) {
			assert.ok(!/[^\x09\x0a\x0d\x20-\x7e]/.test(text), `${name} holds a character outside ASCII`);
			if (name.endsWith(".cmd")) assert.ok(!/(^|[^\r])\n/.test(text), `${name} has a bare LF`);
			else assert.ok(!text.includes("\r"), `${name} has a CR`);
		}
	});

	it("holds no version string, no drive path, and no user folder", () => {
		for (const [name, text] of Object.entries(files)) {
			assert.ok(!/\d+\.\d+\.\d+/.test(text), `${name} holds a version`);
			assert.ok(!/[A-Za-z]:[\\/]/.test(text), `${name} holds a drive path`);
			assert.ok(!/Users|AppData|LOCALAPPDATA/i.test(text), `${name} names a user folder`);
		}
	});

	it("follows the T5-F007 pattern: DisableDelayedExpansion, pushd, call \".\\paths.cmd\", and the program run inside the setlocal (no endlocal)", () => {
		for (const name of ["pi.cmd", "bash.cmd"]) {
			const text = files[name] as string;
			assert.match(text, /setlocal DisableDelayedExpansion\r\n/);
			assert.match(text, /pushd "%~dp0\.\.\\bin"\r\ncall "\.\\paths\.cmd"\r\npopd\r\n/, name);
			assert.ok(!/call "?%/.test(text), `${name} calls a path built from variables`);
			assert.ok(!/^\s*call (?!"\.\\paths\.cmd")/m.test(text), `${name} uses call for anything but the paths file`);
			assert.match(text, /^set "PATH=%SBD_PATH%;%PATH%"\r\n"%[A-Z_]+%(?:\\[^"]*)?" %\*\r\nexit \/b %ERRORLEVEL%\r$/m, `${name}'s exec lines`);
			assert.ok(!/endlocal/.test(text), `${name} leaves its setlocal before the program runs: cmd /v:on would then strip a "!" from the line`);
		}
		assert.match(files["bun.cmd"] as string, /^"%SBD_APP_ROOT%\\tools\\bin\\bun\.cmd" %\*\r\nexit \/b %ERRORLEVEL%\r$/m);
		assert.match(files["bunx.cmd"] as string, /bunx\.cmd" %\*/);
	});

	it("tests the desk variables and the root case-insensitively with a trailing backslash dropped, and passes through otherwise", () => {
		for (const name of ["pi.cmd", "bash.cmd", "bun.cmd"]) {
			const text = files[name] as string;
			assert.match(text, /if not "%STRAW_BOSS_DESK%"=="1" goto :pass/);
			assert.match(text, /if \/i not "%SBD_WANT%"=="%SBD_HAVE%" goto :pass/);
			assert.match(text, /%SBD_REST:\*\\tools\\shims;=%/, "the pass-through skips up to the first shims entry");
			assert.match(text, /:missing_pass[\s\S]*exit \/b 9009/);
		}
		assert.match(files.pi as string, /\[ "\$\{want,,\}" = "\$\{have,,\}" \]/);
		assert.match(files.pi as string, /want=\$\{STRAW_BOSS_DESK_ROOT\/\/\\\\\/\/\}/, "every backslash of the variable becomes a slash");
	});

	it("keeps the pass-through list in step with each command's name", () => {
		for (const spec of Object.values(SHIM_SPECS)) {
			const text = cmdShim(spec);
			assert.ok(text.includes(`${spec.name}.com ${spec.name}.exe ${spec.name}.bat ${spec.name}.cmd`));
		}
	});

	it("drops the bun shims when the recipe no longer names bun, and nothing else", () => {
		const dir = "/r/tools/shims";
		assert.deepEqual(shimDrop(dir, { clis: [], optional: [] }, ["bun"]).map((p) => p.replace(/\\/g, "/")), ["/r/tools/shims/bun.cmd", "/r/tools/shims/bunx.cmd"]);
		assert.deepEqual(shimDrop(dir, { clis: [], optional: ["bun"] }, ["bun"]), []);
	});
});

// ---- the POSIX pi ------------------------------------------------------------------------------------------------------

/** A bash of version 4 or later, which the shim's `${var,,}` needs; the MSYS bash of Git for Windows is 5. */
function modernBash(): string | null {
	for (const candidate of [process.env.SBD_BASH, "/opt/homebrew/bin/bash", "/usr/local/bin/bash", "/usr/bin/bash", "/bin/bash"]) {
		if (candidate === undefined || candidate === "") continue;
		const probe = spawnSync(candidate, ["-c", "echo ${BASH_VERSINFO[0]}"], { encoding: "utf8" });
		if (probe.status === 0 && Number(probe.stdout.trim()) >= 4) return candidate;
	}
	return null;
}
const bash = modernBash();

describe("the POSIX pi shim, run under bash 4 or later", { skip: isWindows ? "the Windows e2e runs it under Git's own bash" : bash === null ? "no bash of version 4 or later here (set SBD_BASH)" : false }, () => {
	let base = "";
	let root = "";
	let shims = "";
	let other = "";

	before(() => {
		base = realpathSync(mkdtempSync(join(tmpdir(), "sbd-shpi-")));
		scratch.push(base);
		root = join(base, "root 測試 (1)");
		shims = join(root, "tools", "shims");
		other = join(base, "other pi");
		const bin = join(root, "tools", "bin");
		for (const dir of [shims, bin, join(root, "tools", "npm"), join(root, "tools", "node", "1", "bin"), other]) mkdirSync(dir, { recursive: true });
		writeFileSync(join(shims, "pi"), shPi(), { mode: 0o755 });
		// paths.sh as the tool-paths stage writes it: the relative entries, and the variables (here only the list matters).
		writeFileSync(join(bin, "paths.sh"), `SBD_REL_PATH='tools/bin tools/node/1/bin'\nSBD_PATH="$SBD_APP_ROOT/tools/bin;$SBD_APP_ROOT/tools/node/1/bin"\n`);
		// The pinned pi: reports it was reached, its arguments, and the first two PATH entries by whether they hold the app's folders.
		writeFileSync(
			join(root, "tools", "npm", "pi"),
			'#!/bin/sh\necho "PINNED args=[$*] n=$#"\nfirst=${PATH%%:*}\ncase $first in "$SBD_CHECK_ROOT/tools/bin") echo BIN_FIRST ;; esac\nexit 7\n',
			{ mode: 0o755 },
		);
		writeFileSync(join(other, "pi"), '#!/bin/sh\necho "OTHER args=[$*]"\nexit 3\n', { mode: 0o755 });
	});

	const sh = (args: string[], env: Record<string, string>) => {
		const result = spawnSync(bash as string, [join(shims, "pi"), ...args], { env: { PATH: `${shims}:${other}:/usr/bin:/bin`, HOME: base, SBD_CHECK_ROOT: root, ...env }, encoding: "utf8" });
		return { code: result.status, out: result.stdout, err: result.stderr };
	};

	it("in a desk pane runs the pinned pi with the app's folders first on the PATH, and passes its arguments and exit code", () => {
		const r = sh(["--session", "a b", "x&y"], { STRAW_BOSS_DESK: "1", STRAW_BOSS_DESK_ROOT: root });
		assert.equal(r.code, 7);
		assert.match(r.out, /PINNED args=\[--session a b x&y\] n=3/);
		assert.match(r.out, /BIN_FIRST/);
	});

	it("compares the root without regard to case, a trailing slash, or backslashes", () => {
		for (const written of [`${root}/`, root.toUpperCase(), root.replace(/\//g, "\\")]) {
			const r = sh([], { STRAW_BOSS_DESK: "1", STRAW_BOSS_DESK_ROOT: written });
			// The backslash form is the root once every `\` is a `/`, which is what `pwd -W` and a Windows variable come to.
			assert.equal(r.code, 7, `${written}: ${r.out}${r.err}`);
		}
	});

	it("passes through to the next pi on the PATH when the desk variables are absent, name another root, or STRAW_BOSS_DESK is not 1", () => {
		const cases: Array<Record<string, string>> = [{}, { STRAW_BOSS_DESK: "1" }, { STRAW_BOSS_DESK: "1", STRAW_BOSS_DESK_ROOT: join(base, "elsewhere") }, { STRAW_BOSS_DESK: "0", STRAW_BOSS_DESK_ROOT: root }];
		for (const env of cases) {
			const r = sh(["--version"], env);
			assert.equal(r.code, 3, `${JSON.stringify(env)}: ${r.out}${r.err}`);
			assert.match(r.out, /OTHER args=\[--version\]/);
		}
	});

	it("skips every shim folder of any root, and says pi is not installed when nothing else is there", () => {
		const alone = spawnSync(bash as string, [join(shims, "pi")], { env: { PATH: `${shims}:${join(base, "root2", "tools", "shims")}:/usr/bin:/bin`, HOME: base }, encoding: "utf8" });
		assert.equal(alone.status, 127);
		assert.match(alone.stderr, /pi is not installed/);
	});

	it("keeps PI_CODING_AGENT_DIR as it finds it", () => {
		writeFileSync(join(root, "tools", "npm", "pi"), '#!/bin/sh\necho "AGENT=$PI_CODING_AGENT_DIR"\n', { mode: 0o755 });
		const r = sh([], { STRAW_BOSS_DESK: "1", STRAW_BOSS_DESK_ROOT: root, PI_CODING_AGENT_DIR: join(base, "work", ".pi", "agent") });
		assert.equal(r.out.trim(), `AGENT=${join(base, "work", ".pi", "agent")}`);
	});

	it("says it is not set up in a desk pane whose pinned pi is missing", () => {
		const empty = join(base, "root3");
		mkdirSync(join(empty, "tools", "shims"), { recursive: true });
		mkdirSync(join(empty, "tools", "bin"), { recursive: true });
		writeFileSync(join(empty, "tools", "shims", "pi"), shPi(), { mode: 0o755 });
		const r = spawnSync(bash as string, [join(empty, "tools", "shims", "pi")], { env: { PATH: "/usr/bin:/bin", STRAW_BOSS_DESK: "1", STRAW_BOSS_DESK_ROOT: empty }, encoding: "utf8" });
		assert.equal(r.status, 127);
		assert.match(r.stderr, /not set up in this Straw Boss Desk/);
	});
});

// ---- the batch files ---------------------------------------------------------------------------------------------------

/** A batch stand-in for a pinned program: it says it ran, with its arguments, and whether the app's bin folder is first on the PATH; exit code 7. */
const marker = (who: string): string => `@echo off\r\necho ${who} args=[%*]\r\nfor /f "delims=;" %%A in ("%PATH%") do if exist "%%A\\paths.cmd" echo BIN_FIRST\r\nexit /b 7\r\n`;
/** What a console shows for a path: a character outside the OEM code page comes out as `?`. */
const asConsole = (text: string): string => text.replace(/[^\x00-\x7f]/g, "?");
const BATCH_ROOTS = ["a^b!c%d&e 測試", "plain 測試", "100%", "x!y!", "^^", "a&b", "(1) b"];

describe("the batch shims under a root with cmd's special characters (T5-F007 pattern), Windows only", { skip: isWindows ? false : "Windows only: cmd.exe's own parsing" }, () => {
	let base = "";
	const roots: Array<{ name: string; layout: Layout; other: string }> = [];
	const comspec = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe");

	before(() => {
		base = realpathSync.native(mkdtempSync(join(tmpdir(), "sbd-shim-")));
		scratch.push(base);
		const enabled = { clis: [] as ("gh" | "glab")[], optional: ["bun"] };
		const versions = { node: "24.0.0", git: "2.56.0.3", herdr: "0.9.5", optional: { bun: "1.2.23" } };
		let copied: string | null = null;
		for (const name of BATCH_ROOTS) {
			const root = join(base, name);
			const layout = computeLayout({ root, home: base, platform: "win32" });
			for (const dir of [layout.tools.shims, layout.tools.bin, layout.tools.npm]) mkdirSync(dir, { recursive: true });
			for (const [file, text] of Object.entries(shimFiles(["bun"]))) writeFileSync(join(layout.tools.shims, file), text);
			for (const [file, text] of Object.entries(pathFiles("win32", layout, versions, enabled))) writeFileSync(join(layout.tools.bin, file), text);
			// The pinned pi and the launcher of bun are batch stand-ins that say they ran, with their arguments, and whether the app's bin folder is first on the PATH.
			writeFileSync(join(layout.tools.npm, "pi.cmd"), marker("PINNED"));
			writeFileSync(join(layout.tools.bin, "bun.cmd"), marker("LAUNCHER"));
			// PortableGit's bash.exe is a copy of node.exe here: `bash.cmd -p "..."` prints what it is asked.
			const exe = join(toolDir(layout, "git", "2.56.0.3"), "bin", "bash.exe");
			mkdirSync(dirname(exe), { recursive: true });
			if (copied === null) {
				copyFileSync(process.execPath, exe);
				copied = exe;
			} else {
				try {
					linkSync(copied, exe);
				} catch {
					copyFileSync(process.execPath, exe);
				}
			}
			const other = join(base, `other ${roots.length}`);
			mkdirSync(other, { recursive: true });
			writeFileSync(join(other, "pi.cmd"), "@echo off\r\necho OTHER args=[%*]\r\nexit /b 3\r\n");
			writeFileSync(join(other, "bash.cmd"), "@echo off\r\necho OTHERBASH args=[%*]\r\nexit /b 4\r\n");
			writeFileSync(join(other, "bun.cmd"), "@echo off\r\necho OTHERBUN args=[%*]\r\nexit /b 5\r\n");
			roots.push({ name, layout, other });
		}
	});

	const sys32 = join(process.env.SystemRoot ?? "C:\\Windows", "System32");
	const ask = async (layout: Layout, other: string, command: string, args: string[], env: Record<string, string>, options: { delayed?: boolean; cwd?: string } = {}) =>
		run(comspec, ["/d", ...(options.delayed ? ["/v:on"] : []), "/c", `${command}.cmd`, ...args], {
			env: { ...systemEnv("win32", process.env), PATH: `${sys32};${layout.tools.shims};${other}`, ...env },
			cwd: options.cwd ?? layout.tools.shims,
		});

	for (const delayed of [false, true]) {
		const suffix = delayed ? " with delayed expansion switched on (cmd /v:on)" : "";
		it(`runs the pinned pi in a desk pane, with the app's folders first, the arguments once expanded, and the exit code${suffix}`, async () => {
			for (const { layout, other } of roots) {
				const r = await ask(layout, other, "pi", ["--session", "x y", "50%"], { STRAW_BOSS_DESK: "1", STRAW_BOSS_DESK_ROOT: layout.root }, { delayed });
				assert.equal(r.code, 7, `${layout.root}: ${r.stdout}${r.stderr}`);
				// node quotes the argument with a space; the `%` reaches the program once, not expanded twice.
				assert.match(r.stdout, /PINNED args=\[--session "x y" 50%\]/, layout.root);
				assert.match(r.stdout, /BIN_FIRST/, layout.root);
			}
		});

		it(`runs PortableGit's bash from bash.cmd in a desk pane${suffix}`, async () => {
			for (const { layout, other } of roots) {
				const r = await ask(layout, other, "bash", ["-p", "String(process.env.PATH.split(';')[0].toLowerCase().endsWith('\\\\tools\\\\bin'))"], { STRAW_BOSS_DESK: "1", STRAW_BOSS_DESK_ROOT: layout.root }, { delayed });
				assert.equal(r.code, 0, `${layout.root}: ${r.stdout}${r.stderr}`);
				assert.equal(r.stdout.trim(), "true", `${layout.root}: the app's bin folder is first on the PATH of PortableGit's bash`);
			}
		});

		it(`runs the launcher of bun from bun.cmd in a desk pane${suffix}`, async () => {
			for (const { layout, other } of roots) {
				const r = await ask(layout, other, "bun", ["install", "--frozen-lockfile"], { STRAW_BOSS_DESK: "1", STRAW_BOSS_DESK_ROOT: layout.root }, { delayed });
				assert.equal(r.code, 7, `${layout.root}: ${r.stdout}${r.stderr}`);
				assert.match(r.stdout, /LAUNCHER args=\[install --frozen-lockfile\]/, layout.root);
			}
		});

		it(`passes through to the next program on the PATH without the desk variables, or with another root's${suffix}`, async () => {
			for (const { layout, other } of roots) {
				const cases: Array<Record<string, string>> = [{}, { STRAW_BOSS_DESK: "1", STRAW_BOSS_DESK_ROOT: join(base, "elsewhere") }, { STRAW_BOSS_DESK: "1" }, { STRAW_BOSS_DESK_ROOT: layout.root }];
				for (const env of cases) {
					const pi = await ask(layout, other, "pi", ["--version"], env, { delayed });
					assert.equal(pi.code, 3, `${layout.root} ${JSON.stringify(env)}: ${pi.stdout}${pi.stderr}`);
					assert.match(pi.stdout, /OTHER args=\[--version\]/);
					const bash = await ask(layout, other, "bash", ["-c", "x"], env, { delayed });
					assert.equal(bash.code, 4, `${layout.root}: ${bash.stdout}${bash.stderr}`);
					const bun = await ask(layout, other, "bun", ["--version"], env, { delayed });
					assert.equal(bun.code, 5, `${layout.root}: ${bun.stdout}${bun.stderr}`);
				}
			}
		});
	}

	// What npm writes for a global package: `pi.cmd` looks for `node` on the PATH when no node.exe lies beside it, then runs the package's script.
	const NPM_WRAPPER = [
		"@ECHO off", "GOTO start", ":find_dp0", "SET dp0=%~dp0", "EXIT /b", ":start", "SETLOCAL", "CALL :find_dp0", "",
		'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ") ELSE (", '  SET "_prog=node"', "  SET PATHEXT=%PATHEXT:;.JS;=;%", ")", "",
		'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\fakepi\\cli.js" %*', "",
	].join("\r\n");

	it("starts the wrapper npm writes for the pinned pi, which finds node on the PATH the shim built", async () => {
		// npm's own wrapper breaks on a root with `&` (its `%dp0%` lines), so it is tried under the root without cmd's special characters.
		for (const { layout, other, name } of roots.filter((r) => r.name === "plain 測試")) {
			const nodeDir = toolDir(layout, "node", "24.0.0");
			mkdirSync(nodeDir, { recursive: true });
			copyFileSync(process.execPath, join(nodeDir, "node.exe"));
			mkdirSync(join(layout.tools.npm, "node_modules", "fakepi"), { recursive: true });
			writeFileSync(join(layout.tools.npm, "node_modules", "fakepi", "cli.js"), "console.log('FAKEPI ' + process.argv.slice(2).join(' '));\n");
			writeFileSync(join(layout.tools.npm, "pi.cmd"), NPM_WRAPPER);
			try {
				const r = await ask(layout, other, "pi", ["--version"], { STRAW_BOSS_DESK: "1", STRAW_BOSS_DESK_ROOT: layout.root, PATH: sys32 });
				assert.equal(r.code, 0, `${name}: ${r.stdout}${r.stderr}`);
				assert.equal(r.stdout.trim(), "FAKEPI --version", name);
			} finally {
				writeFileSync(join(layout.tools.npm, "pi.cmd"), marker("PINNED"));
			}
		}
	});

	it("compares the root without regard to case or a trailing backslash", async () => {
		const { layout, other } = roots.find((r) => r.name === "plain 測試") as (typeof roots)[number];
		for (const written of [`${layout.root}\\`, layout.root.toUpperCase(), layout.root.toLowerCase()]) {
			const r = await ask(layout, other, "pi", [], { STRAW_BOSS_DESK: "1", STRAW_BOSS_DESK_ROOT: written });
			assert.equal(r.code, 7, `${written}: ${r.stdout}${r.stderr}`);
		}
	});

	it("keeps PI_CODING_AGENT_DIR as it finds it, and does not change the caller's working folder", async () => {
		const { layout, other } = roots.find((r) => r.name === "plain 測試") as (typeof roots)[number];
		writeFileSync(join(layout.tools.npm, "pi.cmd"), "@echo off\r\necho AGENT=%PI_CODING_AGENT_DIR%\r\necho CWD=%CD%\r\n");
		try {
			const work = join(base, "work 測試");
			mkdirSync(work, { recursive: true });
			const agent = join(work, ".pi", "agent");
			const r = await ask(layout, other, "pi", [], { STRAW_BOSS_DESK: "1", STRAW_BOSS_DESK_ROOT: layout.root, PI_CODING_AGENT_DIR: agent }, { cwd: work });
			// A console prints a path's CJK characters as `?`, so the comparison is on that form.
			assert.match(r.stdout, new RegExp(`AGENT=${asConsole(agent).replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")}`));
			assert.equal(/CWD=(.*)\r?\n/.exec(r.stdout)?.[1]?.trim().toLowerCase(), asConsole(work).toLowerCase());
		} finally {
			writeFileSync(join(layout.tools.npm, "pi.cmd"), marker("PINNED"));
		}
	});

	it("works with NoDefaultCurrentDirectoryInExePath set (R5-F007) and a PATH that has no shims folder in it", async () => {
		const { layout, other } = roots.find((r) => r.name === "plain 測試") as (typeof roots)[number];
		const pinned = await run(comspec, ["/d", "/c", join(layout.tools.shims, "pi.cmd"), "--x"], {
			env: { ...systemEnv("win32", process.env), PATH: sys32, NoDefaultCurrentDirectoryInExePath: "1", STRAW_BOSS_DESK: "1", STRAW_BOSS_DESK_ROOT: layout.root },
			cwd: other,
		});
		assert.equal(pinned.code, 7, `${pinned.stdout}${pinned.stderr}`);
		const passed = await run(comspec, ["/d", "/c", "pi.cmd", "--x"], { env: { ...systemEnv("win32", process.env), PATH: `${layout.tools.shims};${other}`, NoDefaultCurrentDirectoryInExePath: "1" }, cwd: sys32 });
		assert.equal(passed.code, 3, `${passed.stdout}${passed.stderr}`);
	});

	it("says what is missing, and exits 9009, when nothing else is on the PATH or the pinned program is not installed", async () => {
		const { layout } = roots.find((r) => r.name === "plain 測試") as (typeof roots)[number];
		const alone = await run(comspec, ["/d", "/c", "pi.cmd"], { env: { ...systemEnv("win32", process.env), PATH: `${sys32};${layout.tools.shims}` }, cwd: layout.tools.shims });
		assert.equal(alone.code, 9009);
		assert.match(alone.stderr, /pi is not installed/);
		const none = join(base, "no-pi");
		mkdirSync(join(none, "tools", "shims"), { recursive: true });
		mkdirSync(join(none, "tools", "bin"), { recursive: true });
		writeFileSync(join(none, "tools", "shims", "pi.cmd"), cmdShim(SHIM_SPECS.pi as never));
		const desk = await run(comspec, ["/d", "/c", "pi.cmd"], { env: { ...systemEnv("win32", process.env), PATH: sys32, STRAW_BOSS_DESK: "1", STRAW_BOSS_DESK_ROOT: none }, cwd: join(none, "tools", "shims") });
		assert.equal(desk.code, 9009);
		assert.match(desk.stderr, /not set up in this Straw Boss Desk/);
	});

	it("leaves the caller's variables and PATH alone after a pass-through and after a desk run (a wrapper batch checks both)", async () => {
		const { layout, other } = roots.find((r) => r.name === "plain 測試") as (typeof roots)[number];
		writeFileSync(join(layout.tools.npm, "pi.cmd"), "@echo off\r\nexit /b 0\r\n");
		const wrapper = join(base, "wrapper.cmd");
		writeFileSync(wrapper, '@echo off\r\nset "BEFORE=%PATH%"\r\ncall pi.cmd --x >nul\r\nif "%PATH%"=="%BEFORE%" (echo PATH_SAME) else echo PATH_CHANGED\r\nset SBD_ 2>nul\r\necho DONE\r\n');
		const env = { ...systemEnv("win32", process.env), PATH: `${layout.tools.shims};${other}` };
		const passed = await run(comspec, ["/d", "/c", wrapper], { env, cwd: base });
		assert.equal(passed.stdout.replace(/\r/g, "").trim(), "PATH_SAME\nDONE", passed.stdout + passed.stderr);
		const desk = await run(comspec, ["/d", "/c", wrapper], { env: { ...env, STRAW_BOSS_DESK: "1", STRAW_BOSS_DESK_ROOT: layout.root }, cwd: base });
		assert.equal(desk.stdout.replace(/\r/g, "").trim(), "PATH_SAME\nDONE", desk.stdout + desk.stderr);
		writeFileSync(join(layout.tools.npm, "pi.cmd"), marker("PINNED"));
	});
});

