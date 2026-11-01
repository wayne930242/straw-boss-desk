import { posix, win32 } from "node:path";
import { toolDir, toolExecutable, toolPathEntries, type AppPlatform, type CurrentTools, type Layout } from "../../paths.ts";

// `tools/bin/paths.sh` and `paths.cmd` (spec: Tool paths): which tool folders are active, in a form every consumer reads and joins to the data root.
// They hold only ASCII (tool names, version strings, fixed folder names) and no byte of the root's path: the root comes from `SBD_APP_ROOT`, which the
// launchers, the shims, and the macOS `ZDOTDIR` files each find from their own place or from `STRAW_BOSS_DESK_ROOT` (cmd reads a batch file in the
// OEM code page, so a user folder with CJK characters written into one would be decoded wrongly).

// Format 2 (task 5b): on Windows `tools/bin-exe` follows `tools/bin` in the PATH list (T5-F001).
export const PATHS_FORMAT = 2;

/** What a paths file lists beyond Node, Git, and Herdr. */
export interface EnabledTools {
	/** `gh` and `glab`, for the forges the recipe names. */
	clis: readonly ("gh" | "glab")[];
	/** Optional tools the recipe names (`bun`). */
	optional: readonly string[];
}

/** The tool versions the files name: `current` plus the enabled optional tools. A dropped tool's version stays in `current.json` and never gets here. */
export interface PathVersions extends CurrentTools {
	optional: Readonly<Record<string, string>>;
}

const variableOf = (tool: string): string => `SBD_${tool.toUpperCase()}`;

/** The executables the files name, as `[variable, path relative to the root, with / separators]`. */
export function pathVariables(layout: Layout, versions: PathVersions, enabled: EnabledTools): Array<[string, string]> {
	const rel = (tool: string, version: string): string => relative(layout, toolDir(layout, tool, version), toolExecutable(layout.platform, tool));
	const out: Array<[string, string]> = [];
	for (const cli of enabled.clis) {
		const version = versions[cli];
		if (version === undefined) throw new Error(`${cli} is enabled but has no active version`);
		out.push([variableOf(cli), rel(cli, version)]);
	}
	for (const tool of enabled.optional) {
		const version = versions.optional[tool];
		if (version === undefined) throw new Error(`${tool} is enabled but has no active version`);
		out.push([variableOf(tool), rel(tool, version)]);
	}
	if (layout.platform === "win32") {
		out.push(["SBD_GIT_BASH", relative(layout, toolDir(layout, "git", versions.git), "bin/bash.exe")]);
	}
	return out;
}

function relative(layout: Layout, folder: string, inside: string): string {
	const P = layout.platform === "win32" ? win32 : posix;
	return P.relative(layout.root, P.join(folder, ...inside.split("/"))).split(P.sep).join("/");
}

/** The PATH folders in order, relative to the root with `/` separators. */
export function pathEntries(layout: Layout, versions: PathVersions): string[] {
	const P = layout.platform === "win32" ? win32 : posix;
	return toolPathEntries(layout, versions).map((entry) => P.relative(layout.root, entry).split(P.sep).join("/"));
}

/** `paths.sh`: sourced by sh, bash, and zsh. On Windows `SBD_PATH` uses `;` and the `C:/` form `pwd -W` gives; `SBD_REL_PATH` is the same list for a consumer that builds its own. */
export function pathsSh(layout: Layout, versions: PathVersions, enabled: EnabledTools): string {
	const entries = pathEntries(layout, versions);
	const sep = layout.platform === "win32" ? ";" : ":";
	const lines = [
		"# straw-boss-desk: written by the app (the tool-paths stage). Set SBD_APP_ROOT to the data root, then source this file.",
		`SBD_REL_PATH='${entries.join(" ")}'`,
		`SBD_PATH="${entries.map((e) => `$SBD_APP_ROOT/${e}`).join(sep)}"`,
		...pathVariables(layout, versions, enabled).map(([name, path]) => `${name}="$SBD_APP_ROOT/${path}"`),
	];
	return `${lines.join("\n")}\n`;
}

/** `paths.cmd` (Windows only): called by cmd with `SBD_APP_ROOT` set. */
export function pathsCmd(layout: Layout, versions: PathVersions, enabled: EnabledTools): string {
	const win = (path: string): string => path.split("/").join("\\");
	const entries = pathEntries(layout, versions);
	const lines = [
		"@rem straw-boss-desk: written by the app (the tool-paths stage). Set SBD_APP_ROOT to the data root, then call this file.",
		`set "SBD_PATH=${entries.map((e) => `%SBD_APP_ROOT%\\${win(e)}`).join(";")}"`,
		...pathVariables(layout, versions, enabled).map(([name, path]) => `set "${name}=%SBD_APP_ROOT%\\${win(path)}"`),
	];
	return `${lines.join("\r\n")}\r\n`;
}

/** The files `tool-paths` writes into `tools/bin`, by name. */
export function pathFiles(platform: AppPlatform, layout: Layout, versions: PathVersions, enabled: EnabledTools): Record<string, string> {
	const files: Record<string, string> = { "paths.sh": pathsSh(layout, versions, enabled) };
	if (platform === "win32") files["paths.cmd"] = pathsCmd(layout, versions, enabled);
	return files;
}
