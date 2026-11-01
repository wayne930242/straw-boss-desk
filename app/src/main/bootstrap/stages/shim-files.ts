// The files of `tools\shims` on Windows (spec: Panes on Windows). Herdr rebuilds a pane's `PATH` from the registry, so the one user PATH entry
// `<root>\tools\shims` is how a pane finds `pi` and `bash` by name (and `bun`, when the recipe names it). A shim holds no path and no version: it finds
// the root from its own place, tests whether it runs in a desk pane (`STRAW_BOSS_DESK=1` and `STRAW_BOSS_DESK_ROOT` naming that root), and then either
// runs the pinned program with the app's tool folders first on the `PATH`, or passes through to the next program of that name on the `PATH`, so a
// user's own terminal is unchanged.
//
// The batch files follow the T5-F007 pattern (`setlocal DisableDelayedExpansion`, `pushd` to the paths file's folder, `call ".\paths.cmd"`, R5-F007).
// How each hands over to its program was settled on `windows-2025` (the experiments are in the Build notes):
// - `bash.cmd`, `bun.cmd`, and a pass-through run the program inside the `setlocal`, then `exit /b %ERRORLEVEL%`. Delayed expansion is applied to each
//   command when it runs, so a command after an `endlocal` of a cmd started with `/v:on` (the per-user DelayedExpansion setting) loses the `!` of a root
//   or an argument; inside the `setlocal` it does not. Without a `call` the program gets the caller's arguments exactly once expanded (`call` doubles
//   carets and expands `%` a second time). A program that is not a batch file returns, so the `exit` line stops the shim from running into the next label.
// - `pi.cmd` ends with `endlocal & set "PATH=..." & "<pinned pi.cmd>" %*`. npm's wrapper ends with `endLocal & goto #_undefined_# 2>NUL || ...`, and that
//   `goto` aborts the batch context, which ends every `setlocal` still pending, so a `PATH` set inside the shim's `setlocal` is gone before the wrapper's
//   `"node"` runs. Set after the `endlocal`, the `PATH` is part of the environment the wrapper starts with. The price is npm's own: a cmd with delayed
//   expansion on strips a `!` from this line, as it does from the wrapper's. (In an interactive cmd the `PATH` then keeps the app's folders; a pane is
//   PowerShell, which runs a batch file in a child cmd.)

/** The shim files a Windows install writes, by name. `bun.cmd` and `bunx.cmd` only for a recipe that names bun. */
export interface ShimSpec {
	/** The command a pane types. */
	name: string;
	/** What it runs in a desk pane. */
	desk: "pi" | "bash" | "launcher";
}

export const SHIM_SPECS: Readonly<Record<string, ShimSpec>> = {
	pi: { name: "pi", desk: "pi" },
	bash: { name: "bash", desk: "bash" },
	bun: { name: "bun", desk: "launcher" },
	bunx: { name: "bunx", desk: "launcher" },
};

const SIGNATURE = "straw-boss-desk shim";

const crlf = (lines: readonly string[]): string => `${lines.join("\r\n")}\r\n`;

/**
 * The batch shim for one command. The desk test compares the root of the shim's own place with `STRAW_BOSS_DESK_ROOT`, case-insensitively and
 * with a trailing backslash dropped; both are runtime strings, never bytes of the file.
 */
export function cmdShim(spec: ShimSpec): string {
	const { name } = spec;
	const deskLines: string[] =
		spec.desk === "launcher"
			? [
					`if not exist "%SBD_APP_ROOT%\\tools\\bin\\${name}.cmd" goto :missing_desk`,
					`"%SBD_APP_ROOT%\\tools\\bin\\${name}.cmd" %*`,
					"exit /b %ERRORLEVEL%",
				]
			: [
					spec.desk === "pi" ? 'if not exist "%SBD_APP_ROOT%\\tools\\npm\\pi.cmd" goto :missing_desk' : "rem the bash path is checked once paths.cmd has named it",
					'if not exist "%~dp0..\\bin\\paths.cmd" goto :missing_desk',
					'pushd "%~dp0..\\bin"',
					'call ".\\paths.cmd"',
					"popd",
					...(spec.desk === "bash" ? ['if not exist "%SBD_GIT_BASH%" goto :missing_desk'] : []),
					...(spec.desk === "pi"
						? ['endlocal & set "PATH=%SBD_PATH%;%PATH%" & "%SBD_APP_ROOT%\\tools\\npm\\pi.cmd" %*']
						: ['set "PATH=%SBD_PATH%;%PATH%"', '"%SBD_GIT_BASH%" %*']),
					"exit /b %ERRORLEVEL%",
				];
	return crlf([
		"@echo off",
		`rem ${SIGNATURE} for ${name}: written by the app; no path and no version in it.`,
		`rem In a desk pane it runs the pinned program; anywhere else it runs the next ${name} on the PATH.`,
		"setlocal DisableDelayedExpansion",
		'for %%I in ("%~dp0..\\..") do set "SBD_APP_ROOT=%%~fI"',
		'set "SBD_SHIMS=%~dp0"',
		'if not "%STRAW_BOSS_DESK%"=="1" goto :pass',
		"if not defined STRAW_BOSS_DESK_ROOT goto :pass",
		'set "SBD_WANT=%STRAW_BOSS_DESK_ROOT%"',
		'if "%SBD_WANT:~-1%"=="\\" set "SBD_WANT=%SBD_WANT:~0,-1%"',
		'set "SBD_HAVE=%SBD_APP_ROOT%"',
		'if "%SBD_HAVE:~-1%"=="\\" set "SBD_HAVE=%SBD_HAVE:~0,-1%"',
		'if /i not "%SBD_WANT%"=="%SBD_HAVE%" goto :pass',
		...deskLines,
		"",
		":pass",
		// The entries after this folder in the PATH: what a lookup would find next. `%~$VAR:F` searches the folders listed in VAR, in order, with
		// no code page in between, so a folder with CJK characters is found. The folder itself is skipped, and so is any other root's shim folder
		// (the text up to the first `\tools\shims;` goes, whichever root it names, and a shim of a second root is never run twice in a row).
		'set "SBD_REST=%PATH%;"',
		'set "SBD_REST=%SBD_REST:*\\tools\\shims;=%"',
		'set "SBD_NEXT="',
		`for %%F in (${name}.com ${name}.exe ${name}.bat ${name}.cmd) do if not defined SBD_NEXT if /i not "%%~dp$SBD_REST:F"=="%SBD_SHIMS%" set "SBD_NEXT=%%~$SBD_REST:F"`,
		"if not defined SBD_NEXT goto :missing_pass",
		// The copy of the PATH in SBD_REST would double the environment the program inherits.
		'set "SBD_REST="',
		'"%SBD_NEXT%" %*',
		"exit /b %ERRORLEVEL%",
		"",
		":missing_pass",
		`>&2 echo ${name} is not installed on this computer (Straw Boss Desk passes ${name} through to the next one on the PATH, and there is none).`,
		"exit /b 9009",
		"",
		":missing_desk",
		`>&2 echo ${name} is not set up in this Straw Boss Desk yet. Open Straw Boss Desk and run Repair.`,
		"exit /b 9009",
	]);
}

/** Lines of `text` as they are used by the POSIX shim: no CR. */
const lf = (lines: readonly string[]): string => `${lines.join("\n")}\n`;

/**
 * The POSIX `pi` for MSYS bash (Git's `sh`), which does not apply `PATHEXT` and so never finds `pi.cmd`: pi-herdr-agents writes a `#!/bin/bash` script
 * whose body runs `pi --session ...`. Shell built-ins only (the PATH inside may hold nothing but the pane's folders). `pwd -W` gives the Windows
 * form `C:/...` the desk test compares with `STRAW_BOSS_DESK_ROOT` (every `\` turned into `/` first); plain `pwd` gives the MSYS form `/c/...` that
 * the PATH entries use.
 */
export function shPi(): string {
	return lf([
		"#!/bin/sh",
		`# ${SIGNATURE} for pi (MSYS bash): written by the app; no path and no version in it.`,
		"case $0 in */*) d=${0%/*} ;; *) d=. ;; esac",
		'dp=$(CDPATH= cd -- "$d" && pwd) || exit 1',
		'root=$(CDPATH= cd -- "$d/../.." && pwd) || exit 1',
		'rootw=$(CDPATH= cd -- "$d/../.." && { pwd -W 2>/dev/null || pwd; }) || exit 1',
		'if [ "$STRAW_BOSS_DESK" = 1 ] && [ -n "$STRAW_BOSS_DESK_ROOT" ]; then',
		"\twant=${STRAW_BOSS_DESK_ROOT//\\\\//}",
		"\twant=${want%/}",
		"\thave=${rootw%/}",
		'\tif [ "${want,,}" = "${have,,}" ]; then',
		'\t\tif [ ! -f "$dp/../bin/paths.sh" ] || [ ! -f "$root/tools/npm/pi" ]; then',
		'\t\t\techo "pi is not set up in this Straw Boss Desk yet. Open Straw Boss Desk and run Repair." >&2',
		"\t\t\texit 127",
		"\t\tfi",
		'\t\tSBD_APP_ROOT=$rootw',
		'\t\t. "$dp/../bin/paths.sh"',
		"\t\tnew=",
		'\t\tfor e in $SBD_REL_PATH; do new=$new${new:+:}$root/$e; done',
		'\t\tPATH=$new:$PATH',
		"\t\texport PATH",
		'\t\texec "$root/tools/npm/pi" "$@"',
		"\tfi",
		"fi",
		"# Not a desk pane: the next pi on the PATH, skipping every Straw Boss Desk shim folder.",
		"IFS=:",
		"for dir in $PATH; do",
		'\t[ -n "$dir" ] || continue',
		'\tcase ${dir%/} in */tools/shims) continue ;; esac',
		"\tfor f in pi pi.exe; do",
		'\t\tif [ -f "$dir/$f" ]; then',
		"\t\t\tunset IFS",
		'\t\t\texec "$dir/$f" "$@"',
		"\t\tfi",
		"\tdone",
		"done",
		"unset IFS",
		'echo "pi is not installed on this computer (Straw Boss Desk passes pi through to the next one on the PATH, and there is none)." >&2',
		"exit 127",
	]);
}

/** The shim files for these optional tools, by name. */
export function shimFiles(optionalTools: readonly string[]): Record<string, string> {
	const files: Record<string, string> = {
		"pi.cmd": cmdShim(SHIM_SPECS.pi as ShimSpec),
		pi: shPi(),
		"bash.cmd": cmdShim(SHIM_SPECS.bash as ShimSpec),
	};
	if (optionalTools.includes("bun")) {
		files["bun.cmd"] = cmdShim(SHIM_SPECS.bun as ShimSpec);
		files["bunx.cmd"] = cmdShim(SHIM_SPECS.bunx as ShimSpec);
	}
	return files;
}

/** Every shim name the app may have written, for the optional tools the stack lists: what a shim set deletes again for a tool the recipe dropped. */
export function everyShimFile(allOptional: readonly string[]): string[] {
	return Object.keys(shimFiles(allOptional.includes("bun") ? ["bun"] : []));
}
