import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { run } from "./harness/e2e-light.ts";

// TEMPORARY (task 6): what cmd.exe does with the last line of a shim. Windows only; prints, asserts nothing.
describe("shim experiments", { skip: process.platform === "win32" ? false : "Windows only" }, () => {
	it("prints the facts", async (t) => {
		const base = realpathSync.native(mkdtempSync(join(tmpdir(), "sbd-exp-")));
		const sys32 = join(process.env.SystemRoot ?? "C:\\Windows", "System32");
		const comspec = join(sys32, "cmd.exe");
		const root = join(base, "a^b!c%d&e 測試");
		const shims = join(root, "tools", "shims");
		const npm = join(root, "tools", "npm");
		mkdirSync(shims, { recursive: true });
		mkdirSync(npm, { recursive: true });
		// the pinned pi: prints its arguments and the first PATH entry
		const standIn = "@echo off\r\nsetlocal DisableDelayedExpansion\r\necho ARGS=[%*]\r\nfor /f \"delims=;\" %%A in (\"%PATH%\") do echo PATH1=%%A\r\necho LEAK=%SBD_LEAK%\r\n";
		writeFileSync(join(npm, "pi.cmd"), standIn);
		copyFileSync(process.execPath, join(npm, "bash.exe"));
		const pathLine = 'set "SBD_LEAK=leaked"\r\nset "SBD_PATH=%SBD_APP_ROOT%\\tools\\bin"\r\n';
		const head = "@echo off\r\nsetlocal DisableDelayedExpansion\r\nfor %%I in (\"%~dp0..\\..\") do set \"SBD_APP_ROOT=%%~fI\"\r\n" + pathLine;
		const variants: Record<string, string> = {
			// A: no endlocal; PATH set in the setlocal scope; transfer to the batch pinned pi
			"A-transfer-in-setlocal": `${head}set "PATH=%SBD_PATH%;%PATH%"\r\n"%SBD_APP_ROOT%\\tools\\npm\\pi.cmd" %*\r\nexit /b %ERRORLEVEL%\r\n`,
			// B: call in the setlocal scope
			"B-call-in-setlocal": `${head}set "PATH=%SBD_PATH%;%PATH%"\r\ncall "%SBD_APP_ROOT%\\tools\\npm\\pi.cmd" %*\r\nexit /b %ERRORLEVEL%\r\n`,
			// V1: the current shape: endlocal & set & program
			"V1-endlocal-line": `${head}endlocal & set "PATH=%SBD_PATH%;%PATH%" & "%SBD_APP_ROOT%\\tools\\npm\\pi.cmd" %*\r\nexit /b %ERRORLEVEL%\r\n`,
			// C: an exe target in the setlocal scope, with the guard line
			"C-exe-in-setlocal": `${head}set "PATH=%SBD_PATH%;%PATH%"\r\n"%SBD_APP_ROOT%\\tools\\npm\\bash.exe" -p "'ARGS=[' + process.argv.slice(1).join(' ') + ']'" %*\r\nexit /b %ERRORLEVEL%\r\n`,
			// D: the same exe target with the endlocal line and the guard
			"D-exe-endlocal-line": `${head}endlocal & set "PATH=%SBD_PATH%;%PATH%" & "%SBD_APP_ROOT%\\tools\\npm\\bash.exe" -p "'ARGS=[' + process.argv.slice(1).join(' ') + ']'" %*\r\nexit /b %ERRORLEVEL%\r\n`,
		};
		for (const [name, text] of Object.entries(variants)) writeFileSync(join(shims, `${name}.cmd`), text);
		for (const delayed of [false, true]) {
			for (const name of Object.keys(variants)) {
				const r = await run(comspec, ["/d", ...(delayed ? ["/v:on"] : []), "/c", `${name}.cmd`, "--session", "x y", "50%", "100% sure!", '"a^b"'], { env: { SystemRoot: process.env.SystemRoot ?? "C:\\Windows", PATH: sys32 }, cwd: shims });
				t.diagnostic(`EXP ${delayed ? "/v:on" : "plain"} ${name}: code ${r.code}; stdout ${JSON.stringify(r.stdout.replace(root, "<ROOT>").slice(0, 400))}; stderr ${JSON.stringify(r.stderr.slice(0, 200))}`);
			}
		}
	});
});
