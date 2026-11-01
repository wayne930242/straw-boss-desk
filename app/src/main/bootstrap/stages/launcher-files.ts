import type { AppPlatform } from "../../paths.ts";

// The launchers in `tools/bin` (port of the kit's `spike/win/lib/forge-cli.mjs`, spec: Tool paths, Stages `launchers`). A launcher holds no version and no
// path: it finds the data root from its own place (`tools/bin/../..`), reads `paths.sh` or `paths.cmd` for the executable, sets its tool's environment, and
// runs it. `gh` and `glab` additionally get a private configuration folder and lose the variables in `LAUNCHER_UNSET`.

/**
 * Removed from the environment of every launched code-host CLI. CI and GITLAB_CI: glab writes its token to plain text when either is set (spec,
 * Isolation), and gh behaves differently on CI as well. The rest are the variables that take the place of the stored login, of the configured host, of
 * the TLS check, or of the storage choice: an environment token wins over the keyring for every CLI call and for the Git credential helper, so the agent
 * would push with the user's own token. The list was checked against the pinned gh 2.103.3 (`gh help environment`) and glab 1.124.0 (`glab config --help`,
 * which names every environment variable of every setting, the unprefixed ones as well) and the strings of both binaries. gh: GH_HOST and the four token
 * variables are all there is. glab: host (GITLAB_HOST, GITLAB_URI, GL_HOST), API host and protocol (GITLAB_API_HOST, GLAB_API_PROTOCOL, API_PROTOCOL: an
 * http protocol would send the token in the clear), token (GITLAB_TOKEN, GITLAB_ACCESS_TOKEN, OAUTH_TOKEN), CI job token and its auto-login
 * (CI_JOB_TOKEN, GLAB_ENABLE_CI_AUTOLOGIN), the keyring switch (GLAB_USE_KEYRING, USE_KEYRING: false would store a login made in a pane as plain text), and
 * the switches that turn certificate checking off (GLAB_SKIP_TLS_VERIFY, SKIP_TLS_VERIFY; followup R3-F002). The proxy and CA variables (`HTTPS_PROXY`,
 * `NODE_EXTRA_CA_CERTS`, `GLAB_CA_CERT`, ...) stay: a company proxy or CA may need them.
 */
export const LAUNCHER_UNSET: readonly string[] = [
	"CI",
	"GITLAB_CI",
	"GH_TOKEN",
	"GITHUB_TOKEN",
	"GH_ENTERPRISE_TOKEN",
	"GITHUB_ENTERPRISE_TOKEN",
	"GITLAB_TOKEN",
	"GITLAB_ACCESS_TOKEN",
	"OAUTH_TOKEN",
	"CI_JOB_TOKEN",
	"GLAB_ENABLE_CI_AUTOLOGIN",
	"GH_HOST",
	"GITLAB_HOST",
	"GITLAB_URI",
	"GITLAB_API_HOST",
	"GL_HOST",
	"GLAB_API_PROTOCOL",
	"API_PROTOCOL",
	"GLAB_USE_KEYRING",
	"USE_KEYRING",
	"GLAB_SKIP_TLS_VERIFY",
	"SKIP_TLS_VERIFY",
];

type Pair = readonly [name: string, value: string];

/** What one launcher sets and runs. `root` is the data root (`SBD_APP_ROOT` at run time), for values that name a folder under it. */
export interface LauncherSpec {
	/** The file name without extension: `gh`, `glab`, `bun`, `bunx`. */
	name: string;
	/** The variable of `paths.sh` / `paths.cmd` that names the executable. */
	pathVar: string;
	/** Arguments put before the caller's (`bunx` is `bun x`). */
	prefixArgs: readonly string[];
	/** A private configuration folder under `<root>/config/`: its variable and folder name. */
	config?: { variable: string; folder: string };
	/** A variable set to a folder under the root: `[name, folder relative to the root with / separators]`. */
	rootFolders: readonly Pair[];
	/**
	 * The Windows launcher gives the `rootFolders` as their 8.3 short names (creating the folders first). bun 1.2.23 reads its environment as ANSI, so a
	 * folder with a character outside the code page (a root under `%LOCALAPPDATA%\sbd 測試`, or a user name in CJK) arrives as `??` and bun falls back to
	 * `<project>\node_modules\.cache` (found by task 5's e2e on `windows-2025`); gh's Go runtime reads the same variable correctly.
	 */
	shortPaths?: boolean;
	env: readonly Pair[];
	unset: readonly string[];
}

/** Telemetry switches (spec: Decisions, Telemetry). `DO_NOT_TRACK` is gh's and bun's opt-out; glab has its own switch (checked on 1.124.0: `glab config --help`, `telemetry`, `GLAB_SEND_TELEMETRY`, default on). */
const NO_TRACK: Pair = ["DO_NOT_TRACK", "1"];

export const FORGE_LAUNCHERS: Readonly<Record<"gh" | "glab", LauncherSpec>> = {
	gh: {
		name: "gh",
		pathVar: "SBD_GH",
		prefixArgs: [],
		config: { variable: "GH_CONFIG_DIR", folder: "gh" },
		rootFolders: [],
		env: [["GH_PROMPT_DISABLED", "1"], ["GH_NO_UPDATE_NOTIFIER", "1"], ["GH_TELEMETRY", "disabled"], NO_TRACK],
		unset: LAUNCHER_UNSET,
	},
	glab: {
		name: "glab",
		pathVar: "SBD_GLAB",
		prefixArgs: [],
		config: { variable: "GLAB_CONFIG_DIR", folder: "glab-cli" },
		rootFolders: [],
		env: [["GLAB_NO_PROMPT", "1"], ["GLAB_CHECK_UPDATE", "false"], ["GLAB_SEND_TELEMETRY", "0"], NO_TRACK],
		unset: LAUNCHER_UNSET,
	},
};

/** Launchers of the optional tools: `bun` also gets `bunx`, and bun's cache and global packages stay under `tools/bun-home`. */
export function optionalLaunchers(tool: string): LauncherSpec[] {
	if (tool !== "bun") return [];
	const base = { rootFolders: [["BUN_INSTALL", "tools/bun-home"], ["BUN_INSTALL_CACHE_DIR", "tools/bun-home/install/cache"]] as readonly Pair[], env: [NO_TRACK] as readonly Pair[], unset: [] as readonly string[], pathVar: "SBD_BUN", shortPaths: true };
	return [
		{ name: "bun", prefixArgs: [], ...base },
		{ name: "bunx", prefixArgs: ["x"], ...base },
	];
}

/**
 * Names of the real executables a Windows launcher set adds for a tool. A Node `spawn("bun")` without a shell finds only `bun.exe` (it never tries `.cmd`),
 * and FE2's scripts spawn `bun` that way, so the tool's executable is also linked into `tools/bin` under these names (build notes: FE2R-F009).
 */
export function windowsShims(tool: string): string[] {
	return tool === "bun" ? ["bun.exe", "bunx.exe"] : [];
}

const quoteSh = (value: string): string => `"${value}"`;

/** The batch launcher. The root comes from the launcher's own place, so no path with the user's name is baked into a file that cmd reads in the OEM code page. */
export function cmdLauncher(spec: LauncherSpec): string {
	const lines = [
		"@echo off",
		`rem straw-boss-desk launcher for ${spec.name}: reads paths.cmd, sets its environment${spec.unset.length > 0 ? ", removes CI and token variables" : ""}.`,
		"setlocal",
		'for %%I in ("%~dp0..\\..") do set "SBD_APP_ROOT=%%~fI"',
		'call "%~dp0paths.cmd"',
		...(spec.config ? [`set "${spec.config.variable}=%SBD_APP_ROOT%\\config\\${spec.config.folder}"`] : []),
		...spec.rootFolders.flatMap(([k, folder]) => {
			const path = `%SBD_APP_ROOT%\\${folder.split("/").join("\\")}`;
			return spec.shortPaths === true ? [`if not exist "${path}" mkdir "${path}"`, `for %%I in ("${path}") do set "${k}=%%~sI"`] : [`set "${k}=${path}"`];
		}),
		...spec.env.map(([k, v]) => `set "${k}=${v}"`),
		...spec.unset.map((k) => `set "${k}="`),
		`"%${spec.pathVar}%" ${[...spec.prefixArgs, "%*"].join(" ")}`,
		"exit /b %ERRORLEVEL%",
	];
	return `${lines.join("\r\n")}\r\n`;
}

/**
 * The POSIX launcher, for macOS and for Git Bash on Windows. It uses shell built-ins only: Git runs a helper through sh with whatever PATH it has, and
 * dirname or cygpath may not be on it. Under MSYS `pwd -W` gives the mixed Windows path (C:/Users/...), which is what the pinned native binary needs in
 * its environment variable; elsewhere `pwd -W` fails and plain `pwd` is used.
 */
export function shLauncher(spec: LauncherSpec): string {
	const exported = [spec.config?.variable, ...spec.rootFolders.map(([k]) => k), ...spec.env.map(([k]) => k)].filter((k): k is string => k !== undefined);
	const lines = [
		"#!/bin/sh",
		`# straw-boss-desk launcher for ${spec.name}: reads paths.sh, sets its environment${spec.unset.length > 0 ? ", removes CI and token variables" : ""}.`,
		'case $0 in */*) d=${0%/*} ;; *) d=. ;; esac',
		'd=$(CDPATH= cd -- "$d" && { pwd -W 2>/dev/null || pwd; }) || exit 1',
		'SBD_APP_ROOT=$(CDPATH= cd -- "$d/../.." && { pwd -W 2>/dev/null || pwd; }) || exit 1',
		'. "$d/paths.sh"',
		...(spec.config ? [`${spec.config.variable}=${quoteSh(`$SBD_APP_ROOT/config/${spec.config.folder}`)}`] : []),
		...spec.rootFolders.map(([k, folder]) => `${k}=${quoteSh(`$SBD_APP_ROOT/${folder}`)}`),
		...spec.env.map(([k, v]) => `${k}=${v}`),
		...(exported.length > 0 ? [`export ${exported.join(" ")}`] : []),
		...(spec.unset.length > 0 ? [`unset ${spec.unset.join(" ")}`] : []),
		`exec "$${spec.pathVar}" ${[...spec.prefixArgs, '"$@"'].join(" ")}`,
	];
	return `${lines.join("\n")}\n`;
}

/** Files of `tools/bin` for these launchers, by name. Windows gets both flavours of each: the extensionless one is for Git's `sh` and MSYS bash. */
export function launcherFiles(platform: AppPlatform, specs: readonly LauncherSpec[]): Record<string, string> {
	const out: Record<string, string> = {};
	for (const spec of specs) {
		out[spec.name] = shLauncher(spec);
		if (platform === "win32") out[`${spec.name}.cmd`] = cmdLauncher(spec);
	}
	return out;
}

/** Every launcher name the app may write, enabled or not: what a launcher set deletes again for a tool the recipe no longer names. */
export function everyLauncherName(platform: AppPlatform, optionalTools: readonly string[]): string[] {
	const specs = [...Object.values(FORGE_LAUNCHERS), ...optionalTools.flatMap(optionalLaunchers)];
	const names = specs.flatMap((s) => (platform === "win32" ? [s.name, `${s.name}.cmd`] : [s.name]));
	if (platform === "win32") names.push(...optionalTools.flatMap(windowsShims));
	return names;
}
