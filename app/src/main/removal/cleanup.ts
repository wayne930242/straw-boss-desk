import { spawn, type SpawnOptions } from "node:child_process";
import { tmpdir } from "node:os";
import { isAbsolute } from "node:path";
import type { Locate } from "../platform/types.ts";
import { PENDING_FILE } from "./pending.ts";

// The detached cleanup of **Remove all data** (spec: Uninstall and data). Chromium holds files in `<root>/electron` open while the app runs (on Windows `Local State`, cookies, caches), so the app
// deletes everything else, writes `<root>/remove-pending`, and starts this program, which waits up to 30 s for the app's pid to end and then deletes `<root>` and the fallback folder.
//
// Deviation from the spec's text, which says `cmd /c` on Windows: the Windows cleanup is PowerShell (`-EncodedCommand`, as every other Windows call of the app, started through `cmd /c start`), because `cmd /c` has no
// positional parameters, and a root written into its command text meets the quoting rules of `&`, `^` and `%` (the T6-F001 class of fault). The root, the fallback folder and the pid reach
// the program in its environment, as UTF-16 on Windows, never in a file and never in a command text. On macOS they are the positional parameters of `/bin/sh -c`, as the spec says.
//
// Links are never followed. POSIX `rm -rf` removes a symlink itself. Windows PowerShell 5.1's `Remove-Item -Recurse` is reported to enter directory junctions and symlinks and delete the target's files, so the
// PowerShell script walks the tree itself with .NET calls: a reparse point (junction, symlink) is deleted as the link it is, a plain folder is emptied and then deleted. In the root the marker
// `remove-pending` goes last, and only when nothing else is left: a half-deleted root keeps its marker, so the next launch finishes it.
//
// A relaunch can start while the cleanup still retries (T14R-F002): it finishes the pending removal itself and creates a new root in the same place. The marker is what tells the two apart, so the
// root is retried only while `remove-pending` is in it; a root without it belongs to the new launch and is left alone. When the marker could not be written at all (`marked` false) there is nothing to tell
// them apart by, and the root is retried while it exists, as before.
//
// The program kills nothing: it only waits for the app's pid to end (by looking, not by signalling), and deletes only the two folders it is given. A pid that is still alive after 30 s makes it
// leave: the marker stays, and the next launch finishes the deletion (`finishPending`).

export const WAIT_SECONDS = 30;
const RETRIES = 20;

/** `/bin/sh -c` script. `$1` root, `$2` fallback folder (may be empty), `$3` the app's pid, `$4` "1" when the marker `remove-pending` was written (the root is then retried only while it is there). `waitSeconds` is the app's 30 s and `retries` the 20 rounds of the delete; a test passes less. */
export const posixScript = (waitSeconds: number = WAIT_SECONDS, retries: number = RETRIES): string => [
	'root=$1; fallback=$2; pid=$3; marked=$4',
	'case $root in /?*) ;; *) exit 1;; esac',
	'case $pid in ""|*[!0-9]*) exit 1;; esac',
	// Whether `$1` still has work: the root while its marker is there (when one was written), the fallback folder while it exists.
	`more() { if [ "$1" = "$root" ] && [ -n "$marked" ]; then [ -e "$1/${PENDING_FILE}" ]; else [ -e "$1" ]; fi; }`,
	'i=0',
	`while kill -0 "$pid" 2>/dev/null; do i=$((i+1)); [ "$i" -gt ${waitSeconds} ] && exit 2; sleep 1; done`,
	'for target in "$root" "$fallback"; do',
	'  [ -n "$target" ] || continue',
	'  case $target in /?*) ;; *) continue;; esac',
	'  n=0',
	`  while more "$target" && [ "$n" -lt ${retries} ]; do`,
	'    if [ "$target" = "$root" ]; then',
	// The root: everything but the marker first, then the marker, and the folder, only when nothing else is left (a symlink inside is removed as the link it is).
	`      find "$target" -mindepth 1 -maxdepth 1 ! -name '${PENDING_FILE}' -exec rm -rf -- {} + 2>/dev/null`,
	`      if [ -z "$(find "$target" -mindepth 1 -maxdepth 1 ! -name '${PENDING_FILE}' 2>/dev/null)" ]; then rm -f -- "$target/${PENDING_FILE}"; rmdir -- "$target" 2>/dev/null; fi`,
	'    else',
	'      rm -rf -- "$target" 2>/dev/null',
	'    fi',
	'    [ -e "$target" ] && sleep 1',
	'    n=$((n+1))',
	'  done',
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
	// A process that has exited can stay in the process list while some other program still holds a handle to it (the parent that started the app, a debugger): it counts as gone once `HasExited` says so.
	"function Alive { $p = Get-Process -Id $waitPid; return ($null -ne $p -and -not $p.HasExited) }",
	`for ($i = 0; $i -lt ${WAIT_SECONDS}; $i++) { if (-not (Alive)) { break }; Start-Sleep -Seconds 1 }`,
	"if (Alive) { exit 2 }",
	// Deletes `$path` without entering a reparse point: a junction or symlink goes as the link it is (`Directory.Delete` without `recursive` removes the link and leaves its target), a folder is emptied
	// child by child and then deleted. `$keepLast` is a name in `$path` that goes only when nothing else is left in it. Every call that fails is caught, so one locked file leaves the rest to go.
	"function Remove-Tree([string]$path, [string]$keepLast) {",
	"  try { $attr = [IO.File]::GetAttributes($path) } catch { return }",
	"  $isDir = ($attr -band [IO.FileAttributes]::Directory) -ne 0",
	"  $isLink = ($attr -band [IO.FileAttributes]::ReparsePoint) -ne 0",
	"  try {",
	"    if (-not $isDir) { [IO.File]::SetAttributes($path, [IO.FileAttributes]::Normal); [IO.File]::Delete($path); return }",
	"    if ($isLink) { [IO.Directory]::Delete($path); return }",
	"  } catch { return }",
	"  $rest = 0",
	"  foreach ($child in @([IO.Directory]::GetFileSystemEntries($path))) {",
	"    if ($keepLast -and ([IO.Path]::GetFileName($child) -ieq $keepLast)) { continue }",
	"    Remove-Tree $child ''",
	"    if ([IO.File]::Exists($child) -or [IO.Directory]::Exists($child)) { $rest++ }",
	"  }",
	"  if ($rest -gt 0) { return }",
	"  if ($keepLast) { Remove-Tree (Join-Path $path $keepLast) '' }",
	"  try { [IO.File]::SetAttributes($path, [IO.FileAttributes]::Directory); [IO.Directory]::Delete($path) } catch { }",
	"}",
	// The same rule as the POSIX script's `more`: the root is retried only while its marker is there, when one was written (`SBD_RM_MARKED`).
	"function Test-Work([string]$target) {",
	"  if (($target -eq $env:SBD_RM_ROOT) -and $env:SBD_RM_MARKED) { return (Test-Path -LiteralPath (Join-Path $target '" + PENDING_FILE + "')) }",
	"  return (Test-Path -LiteralPath $target)",
	"}",
	"foreach ($target in @($env:SBD_RM_ROOT, $env:SBD_RM_FALLBACK)) {",
	"  if ([string]::IsNullOrEmpty($target) -or -not [IO.Path]::IsPathRooted($target)) { continue }",
	`  $keep = if ($target -eq $env:SBD_RM_ROOT) { '${PENDING_FILE}' } else { '' }`,
	`  for ($n = 0; $n -lt ${RETRIES}; $n++) {`,
	"    if (-not (Test-Work $target)) { break }",
	"    Remove-Tree $target $keep",
	"    if (Test-Work $target) { Start-Sleep -Seconds 1 }",
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
	/** `remove-pending` was written in the root: the cleanup retries the root only while it is there (T14R-F002). */
	marked: boolean;
}

export interface CleanupCommand {
	file: string;
	args: string[];
	env: Record<string, string>;
	/** Windows: `args` is one command line for `cmd.exe /s /c` and goes to it as it is (`windowsVerbatimArguments`). */
	verbatim?: boolean;
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
		env.SBD_RM_MARKED = spec.marked ? "1" : "";
		const encoded = Buffer.from(POWERSHELL_SCRIPT, "utf16le").toString("base64");
		// PowerShell is started by `cmd /c start /b`, which ends at once: the program's parent is then a process that has gone, and not the app. Started by the app directly it was gone with the app on the
		// hosted runner, however it was started (detached, or not), and nothing deleted the root. Every part of the command line is made of characters `cmd` leaves alone (the base64 has no `&^%`).
		const powershell = locate.system("powershell");
		return { file: locate.system("cmd"), args: ["/d", "/s", "/c", `"start "" /b "${powershell}" -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encoded}"`], env, verbatim: true };
	}
	const env: Record<string, string> = {};
	for (const key of ["PATH", "LANG", "LC_ALL", "HOME"]) if (baseEnv[key] !== undefined) env[key] = baseEnv[key] as string;
	env.PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
	return { file: locate.system("sh"), args: ["-c", POSIX_SCRIPT, "sh", spec.root, spec.fallbackDir ?? "", String(spec.pid), spec.marked ? "1" : ""], env };
}

export type SpawnDetached = (file: string, args: readonly string[], options: SpawnOptions) => { unref(): void; on(event: "error", listener: (error: Error) => void): unknown };

/**
 * Starts the cleanup apart from the app: no window, no inherited handles, its own working folder (the root itself must not be its cwd), and the app does not wait for it.
 *
 * `detached` is for POSIX only. On Windows it starts the program with no console at all (`DETACHED_PROCESS`), and Windows PowerShell started that way ends before it runs its first line (seen on the
 * hosted runner: the same command with `detached` left out deleted the folder, with it nothing happened). A Windows child does not end with its parent, so the app's exit leaves it running.
 */
export function spawnCleanup(command: CleanupCommand, spawnFn: SpawnDetached = spawn as unknown as SpawnDetached, platform: NodeJS.Platform = process.platform): void {
	const child = spawnFn(command.file, command.args, { detached: platform !== "win32", stdio: "ignore", windowsHide: true, env: command.env, cwd: tmpdir(), ...(command.verbatim ? { windowsVerbatimArguments: true } : {}) });
	// A program that cannot start leaves the marker, and the next launch deletes the root; there is nothing else to do here.
	child.on("error", () => {});
	child.unref();
}
