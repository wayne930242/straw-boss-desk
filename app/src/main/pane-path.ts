import { win32 } from "node:path";
import { createWinLocate } from "./platform/win.ts";
import type { CommandRunner, Locate } from "./platform/types.ts";

// What a Windows pane's shell finds by name (spec: Panes on Windows, the WSL check). Herdr rebuilds a pane's `PATH` from the registry: the machine
// `Path`, then the user `Path`. Windows puts the machine entries first, so a `bash.exe` on the machine PATH wins over the shim's `bash.cmd`, and
// WSL's `System32\bash.exe` would run a pi-herdr-agents script in Linux, where `pi` does not exist (seam U10). A `pi` on the machine PATH wins over
// the shim's `pi` as well, and so does a `bun` (or `bunx`) there over the shim's `bun.cmd`. This module reads the two registry values and walks them as a pane does: files only, nothing is run.
//
// Three inputs decide the walk, and the unit tests pass all three in: the machine value, the user value, and a file-exists check.

export const MACHINE_ENVIRONMENT_KEY = "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment";
export const USER_ENVIRONMENT_KEY = "HKCU\\Environment";

export interface RegistryPath {
	/** `REG_EXPAND_SZ` or `REG_SZ`. */
	type: string;
	/** As stored, `%VAR%` entries unexpanded. */
	value: string;
}

/**
 * The `Path` value in the output of `reg.exe query <key> /v Path`. The value name and the type are not translated (only the key header and the error
 * texts are), so the line is found by its shape. Null when there is no such line.
 */
export function parseRegPath(stdout: string): RegistryPath | null {
	for (const line of stdout.split(/\r?\n/)) {
		const m = /^\s+Path\s+(REG_EXPAND_SZ|REG_SZ)(?:\s{4}(.*)|\s*)$/i.exec(line);
		if (m?.[1] !== undefined) return { type: m[1].toUpperCase(), value: (m[2] ?? "").trim() };
	}
	return null;
}

/** `%NAME%` replaced from `env` (case-insensitive, as Windows reads it); a name `env` lacks stays as it is, which no file path will match. */
export function expandPercent(entry: string, env: Readonly<Record<string, string | undefined>>): string {
	const lookup = (name: string): string | undefined => {
		const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase());
		return key === undefined ? undefined : env[key];
	};
	return entry.replace(/%([^%;]+)%/g, (whole, name: string) => lookup(name) ?? whole);
}

/** The entries of a `Path` value, in order: split on `;`, quotes and blanks dropped, `%VAR%` expanded. */
export function pathEntries(value: string | null, env: Readonly<Record<string, string | undefined>>): string[] {
	if (value === null) return [];
	return value
		.split(";")
		.map((entry) => expandPercent(entry.trim().replace(/^"(.*)"$/, "$1"), env))
		.filter((entry) => entry !== "");
}

export interface PaneWalkInput {
	/** The machine `Path` as stored, or null when the value is missing. */
	machine: string | null;
	/** The user `Path` as stored, or null. */
	user: string | null;
	/** True when `path` is an existing file. */
	exists: (path: string) => boolean;
	/** For `%VAR%` entries; `SystemRoot` also names the folder WSL's `bash.exe` lives in. */
	env: Readonly<Record<string, string | undefined>>;
	pathExt?: string;
}

export interface PaneFindings {
	/** The first `bash.exe`, `bash.cmd`, ... a pane would run for `bash`, or null. */
	firstBash: string | null;
	/** True when that file is `%SystemRoot%\System32\bash.exe`, WSL's launcher. */
	wslBash: boolean;
	/** The first `pi` on the machine PATH, which wins over the shim, or null. */
	machinePi: string | null;
	/** The first `bun` on the machine PATH (winget or choco machine scope, say), which wins over the shim's `bun.cmd`, or null (T6-F009). */
	machineBun: string | null;
	/** The first `bunx` on the machine PATH, which wins over the shim's `bunx.cmd`, or null. */
	machineBunx: string | null;
}

const sameFile = (a: string, b: string): boolean => win32.normalize(a).toLowerCase() === win32.normalize(b).toLowerCase();

/** Walks the machine entries, then the user entries, as a pane's lookup does (PATHEXT order inside each folder). Pure apart from `exists`. */
export function walkPanePath(input: PaneWalkInput): PaneFindings {
	const systemRoot = input.env.SystemRoot ?? input.env.windir ?? "C:\\Windows";
	const locate: Locate = createWinLocate({ systemRoot, exists: input.exists, ...(input.pathExt !== undefined ? { pathExt: input.pathExt } : {}) });
	const machine = pathEntries(input.machine, input.env);
	const all = [...machine, ...pathEntries(input.user, input.env)];
	const firstBash = locate.onPath("bash", all.join(";"));
	const wslBash = firstBash !== null && sameFile(firstBash, win32.join(systemRoot, "System32", "bash.exe"));
	const machinePath = machine.join(";");
	return { firstBash, wslBash, machinePi: locate.onPath("pi", machinePath), machineBun: locate.onPath("bun", machinePath), machineBunx: locate.onPath("bunx", machinePath) };
}

/** Reads both `Path` values with `reg.exe` (two short processes, no PowerShell, so it never delays the window). A key or value that is missing reads as null. */
export async function readPaneRegistry(run: CommandRunner, locate: Locate): Promise<{ machine: string | null; user: string | null }> {
	const reg = locate.system("reg");
	const read = async (key: string): Promise<string | null> => {
		const result = await run(reg, ["query", key, "/v", "Path"], { timeoutMs: 15_000 });
		return result.code === 0 ? (parseRegPath(result.stdout)?.value ?? null) : null;
	};
	return { machine: await read(MACHINE_ENVIRONMENT_KEY), user: await read(USER_ENVIRONMENT_KEY) };
}

/** The whole check: both registry values, walked as a pane does. The preflight, **Repair**, and every start call this one function. */
export async function checkPaneLookups(input: { run: CommandRunner; locate: Locate; exists: (path: string) => boolean; env: Readonly<Record<string, string | undefined>> }): Promise<PaneFindings> {
	const { machine, user } = await readPaneRegistry(input.run, input.locate);
	return walkPanePath({ machine, user, exists: input.exists, env: input.env });
}

/** The sentence of the shell banner and the welcome screen (spec: Panes on Windows); the catalog carries zh-TW from the warning's `kind`. */
export const WSL_SENTENCE = "On this computer, agents cannot hand work to helper agents, because Windows Subsystem for Linux provides its own bash. Everything else works.";

/** The preflight's note for a `pi` on the machine PATH, which a pane finds before the shim. */
export const MACHINE_PI_SENTENCE = "Another pi is installed for every user of this computer, and a pane starts it instead of the one Straw Boss installed.";

/** The preflight's note for a `bun` or `bunx` on the machine PATH, which a pane finds before the shim, for a recipe that names bun (T6-F009). */
export const MACHINE_BUN_SENTENCE = "Another bun is installed for every user of this computer, and a pane starts it instead of the one Straw Boss installed, without the app's cache folder.";
