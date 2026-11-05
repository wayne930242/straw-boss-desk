import { spawn, type SpawnOptions } from "node:child_process";
import { tmpdir } from "node:os";
import { isAbsolute } from "node:path";
import type { Locate } from "../platform/types.ts";

// The detached cleanup of **Remove all data** (spec: Uninstall and data). Chromium holds files in `<root>/electron` open while the app runs (on Windows `Local State`, cookies, caches), so the app
// deletes everything else, writes `<root>/remove-pending`, and starts this program, which waits up to 30 s for the app's pid to end and then deletes `<root>` and the fallback folder.
//
// Deviation from the spec's text, which says `cmd /c` on Windows: the Windows cleanup is PowerShell (`-EncodedCommand`, as every other Windows call of the app), because `cmd /c` has no
// positional parameters, and a root written into its command text meets the quoting rules of `&`, `^` and `%` (the T6-F001 class of fault). The root, the fallback folder and the pid reach
// the program in its environment, as UTF-16 on Windows, never in a file and never in a command text. On macOS they are the positional parameters of `/bin/sh -c`, as the spec says.
//
// The program kills nothing: it only waits for the app's pid to end (by looking, not by signalling), and deletes only the two folders it is given. A pid that is still alive after 30 s makes it
// leave: the marker stays, and the next launch finishes the deletion (`finishPending`).

export const WAIT_SECONDS = 30;
const RETRIES = 20;

/** `/bin/sh -c` script. `$1` root, `$2` fallback folder (may be empty), `$3` the app's pid. `waitSeconds` is the app's 30 s; a test passes less. */
export const posixScript = (waitSeconds: number = WAIT_SECONDS): string => [
	'root=$1; fallback=$2; pid=$3',
	'case $root in /?*) ;; *) exit 1;; esac',
	'case $pid in ""|*[!0-9]*) exit 1;; esac',
	'i=0',
	`while kill -0 "$pid" 2>/dev/null; do i=$((i+1)); [ "$i" -gt ${waitSeconds} ] && exit 2; sleep 1; done`,
	'for target in "$root" "$fallback"; do',
	'  [ -n "$target" ] || continue',
	'  case $target in /?*) ;; *) continue;; esac',
	'  n=0',
	`  while [ -e "$target" ] && [ "$n" -lt ${RETRIES} ]; do rm -rf -- "$target" 2>/dev/null; [ -e "$target" ] && sleep 1; n=$((n+1)); done`,
	'done',
	// `~/.straw-boss-desk` goes when the fallback folder was the last thing in it; rmdir refuses a folder that holds anything.
	'[ -n "$fallback" ] && rmdir -- "$(dirname -- "$fallback")" 2>/dev/null',
	'exit 0',
].join('\n');

export const POSIX_SCRIPT = posixScript();

/** PowerShell script. The values are `$env:SBD_RM_ROOT`, `$env:SBD_RM_FALLBACK` and `$env:SBD_RM_PID`. */
export const POWERSHELL_SCRIPT = [
	"$ErrorActionPreference = 'SilentlyContinue'",
	"$waitPid = 0",
	"if (-not [int]::TryParse($env:SBD_RM_PID, [ref]$waitPid) -or $waitPid -le 0) { exit 1 }",
	`for ($i = 0; $i -lt ${WAIT_SECONDS}; $i++) { if (-not (Get-Process -Id $waitPid)) { break }; Start-Sleep -Seconds 1 }`,
	"if (Get-Process -Id $waitPid) { exit 2 }",
	"foreach ($target in @($env:SBD_RM_ROOT, $env:SBD_RM_FALLBACK)) {",
	"  if ([string]::IsNullOrEmpty($target) -or -not [IO.Path]::IsPathRooted($target)) { continue }",
	`  for ($n = 0; $n -lt ${RETRIES}; $n++) {`,
	"    if (-not (Test-Path -LiteralPath $target)) { break }",
	"    Remove-Item -LiteralPath $target -Recurse -Force",
	"    if (Test-Path -LiteralPath $target) { Start-Sleep -Seconds 1 }",
	"  }",
	"}",
	"if ($env:SBD_RM_FALLBACK) {",
	"  $parent = Split-Path -LiteralPath $env:SBD_RM_FALLBACK -Parent",
	"  if ((Test-Path -LiteralPath $parent) -and -not (Get-ChildItem -LiteralPath $parent -Force)) { Remove-Item -LiteralPath $parent -Force }",
	"}",
	"exit 0",
].join("\n");

export interface CleanupSpec {
	platform: NodeJS.Platform;
	/** The pid of the app, which the program waits for. */
	pid: number;
	root: string;
	/** The fallback folder to delete too, already checked by the caller (`fallbackIsOurs`); null when there is none. */
	fallbackDir: string | null;
}

export interface CleanupCommand {
	file: string;
	args: string[];
	env: Record<string, string>;
}

/** The command that deletes the data root after the app has gone. Pure: nothing runs here. */
export function cleanupCommand(spec: CleanupSpec, locate: Pick<Locate, "system">, baseEnv: Readonly<Record<string, string | undefined>> = process.env): CleanupCommand {
	if (!isAbsolute(spec.root) && !/^[A-Za-z]:[\\/]/.test(spec.root)) throw new Error(`the data root is not an absolute path: ${spec.root}`);
	if (!Number.isInteger(spec.pid) || spec.pid <= 0) throw new Error("the app's pid is not a pid");
	if (spec.platform === "win32") {
		const env: Record<string, string> = {};
		for (const [key, value] of Object.entries(baseEnv)) if (value !== undefined) env[key] = value;
		env.SBD_RM_ROOT = spec.root;
		env.SBD_RM_FALLBACK = spec.fallbackDir ?? "";
		env.SBD_RM_PID = String(spec.pid);
		const encoded = Buffer.from(POWERSHELL_SCRIPT, "utf16le").toString("base64");
		return { file: locate.system("powershell"), args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], env };
	}
	const env: Record<string, string> = {};
	for (const key of ["PATH", "LANG", "LC_ALL", "HOME"]) if (baseEnv[key] !== undefined) env[key] = baseEnv[key] as string;
	env.PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
	return { file: locate.system("sh"), args: ["-c", POSIX_SCRIPT, "sh", spec.root, spec.fallbackDir ?? "", String(spec.pid)], env };
}

export type SpawnDetached = (file: string, args: readonly string[], options: SpawnOptions) => { unref(): void; on(event: "error", listener: (error: Error) => void): unknown };

/** Starts the cleanup detached: no window, no inherited handles, its own working folder (the root itself must not be its cwd), and the app does not wait for it. */
export function spawnCleanup(command: CleanupCommand, spawnFn: SpawnDetached = spawn as unknown as SpawnDetached): void {
	const child = spawnFn(command.file, command.args, { detached: true, stdio: "ignore", windowsHide: true, env: command.env, cwd: tmpdir() });
	// A program that cannot start leaves the marker, and the next launch deletes the root; there is nothing else to do here.
	child.on("error", () => {});
	child.unref();
}
