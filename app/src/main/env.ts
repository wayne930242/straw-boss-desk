import { posix, win32 } from "node:path";
import { herdrBinary, toolDir, toolPathEntries, type CurrentTools, type Layout } from "./paths.ts";

// The constructed environment for every child (spec: Runtime supervisor, Environment). It starts from an allow-list of system essentials, never from
// the app's own environment, so a PI_SUBAGENT_ID, a HERDR_* pane id, an SSH_AUTH_SOCK, or a GH_TOKEN of the author's shell cannot reach a child.

export type EnvMap = Record<string, string>;
export type EnvLike = Readonly<Record<string, string | undefined>>;

const WIN_ESSENTIALS = [
	"SystemRoot", "SystemDrive", "windir", "ComSpec", "PATHEXT", "OS",
	"USERPROFILE", "HOMEDRIVE", "HOMEPATH", "HOME", "USERNAME", "USERDOMAIN", "COMPUTERNAME",
	"LOCALAPPDATA", "APPDATA", "ProgramData", "ALLUSERSPROFILE", "PUBLIC",
	"ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "CommonProgramFiles", "CommonProgramFiles(x86)", "CommonProgramW6432",
	"TEMP", "TMP", "LANG",
	"PROCESSOR_ARCHITECTURE", "PROCESSOR_ARCHITEW6432", "PROCESSOR_IDENTIFIER", "PROCESSOR_LEVEL", "PROCESSOR_REVISION", "NUMBER_OF_PROCESSORS",
];

const MAC_ESSENTIALS = [
	"HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TZ", "__CF_USER_TEXT_ENCODING",
	"LANG", "LC_ALL", "LC_COLLATE", "LC_CTYPE", "LC_MESSAGES", "LC_MONETARY", "LC_NUMERIC", "LC_TIME",
];

/** Passed through from the app's environment when set, in either case (spec: Environment). */
export const PASS_THROUGH = [
	"HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR", "GIT_SSL_CAINFO",
];

/**
 * Variables a child never inherits. The allow-list already excludes them; this list is the second gate, checked on the finished map, so a later
 * addition to an allow-list cannot let one through. The launchers' unset list (spike/win/lib/forge-cli.mjs `UNSET`) plus the variables that make a
 * pi a subagent, join a Herdr, or move Claude Code's Keychain item (`CLAUDE_SECURESTORAGE_CONFIG_DIR`, spec: Secrets).
 */
export const NEVER_CARRY = [
	"PI_SUBAGENT_ID", "PI_INTERCOM_SESSION_ID", "STRAW_BOSS_ROLE", "SSH_AUTH_SOCK", "CLAUDE_SECURESTORAGE_CONFIG_DIR",
	"HERDR_ENV", "HERDR_PANE_ID", "HERDR_WORKSPACE_ID", "HERDR_TAB_ID", "HERDR_SESSION",
	"CI", "GITLAB_CI", "GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "GITLAB_TOKEN", "GITLAB_ACCESS_TOKEN",
	"OAUTH_TOKEN", "CI_JOB_TOKEN", "GLAB_ENABLE_CI_AUTOLOGIN", "GH_HOST", "GITLAB_HOST", "GITLAB_URI", "GITLAB_API_HOST", "GL_HOST",
	"GLAB_API_PROTOCOL", "API_PROTOCOL", "GLAB_USE_KEYRING", "USE_KEYRING", "GLAB_SKIP_TLS_VERIFY", "SKIP_TLS_VERIFY",
];

/** The variables the app sets itself, which the NEVER_CARRY check lets through even when its pattern would match (the HERDR_* paths below). */
const OWN = new Set(["HERDR_CONFIG_PATH", "HERDR_SOCKET_PATH", "HERDR_BIN_PATH", "HERDR_DISABLE_SOUND"]);

export const LOOPBACK = "127.0.0.1,localhost,::1";

const MAC_BASE_PATH = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];

/**
 * The system essentials alone (`SystemRoot`, `HOME`, `TEMP`, ...), taken from `appEnv` by name: what a child needs to start and nothing of the
 * app's own variables. Stages that run a staged tool before it is active use it, since the constructed environment needs the active versions.
 */
export function systemEnv(platform: "win32" | "darwin", appEnv: EnvLike): EnvMap {
	const win = platform === "win32";
	const out: EnvMap = {};
	for (const name of win ? WIN_ESSENTIALS : MAC_ESSENTIALS) {
		const found = lookup(appEnv, name, win);
		if (found) out[found[0]] = found[1];
	}
	return out;
}

/**
 * The variables a launched optional tool needs beyond the PATH: where bun keeps its cache and global packages, and its telemetry opt-out (spec: Tool
 * paths). A program that reaches bun without its launcher (a spawn without a shell finds the `bun.exe` shim) gets these from here; on Windows the paths
 * are long names, and bun reads them as ANSI, which only the launcher's short names survive (build notes: task 5b, T5-F001).
 */
export const optionalToolEnv = (layout: Layout, tool: string, shortNames?: ShortNames): EnvMap =>
	tool === "bun" ? { BUN_INSTALL: shortNames?.bunHome ?? bunHome(layout), BUN_INSTALL_CACHE_DIR: shortNames?.bunCache ?? bunCacheDir(layout), DO_NOT_TRACK: "1" } : {};

/**
 * The 8.3 short names of bun's two folders, resolved once by the supervisor (`runtime/short-names.ts`) and kept beside `state/layout.json`. bun 1.2.23 reads its
 * environment as ANSI on Windows, so in a root with characters outside the ANSI code page the long names reach it as `?` and its cache lands in the project
 * (task 5 build notes). A spawn without a shell reaches the `bun.exe` shim in `tools/bin-exe` with the constructed environment and nothing in between, so the
 * environment itself must carry the short names. Absent on macOS and wherever the volume has no short names.
 */
export interface ShortNames {
	bunHome: string;
	bunCache: string;
}

/** `<root>/tools/bun-home`: bun's `BUN_INSTALL`, so its cache and global packages stay under the app's `tools/` and not in the PM's `~/.bun`. */
export const bunHome = (layout: Layout): string => (layout.platform === "win32" ? win32 : posix).join(layout.tools.root, "bun-home");

/** bun's package cache, named outright: on `windows-2025` bun 1.2.23 with only `BUN_INSTALL` set put it in `<project>/node_modules/.cache`, not under `BUN_INSTALL` (task 5 e2e). */
export const bunCacheDir = (layout: Layout): string => (layout.platform === "win32" ? win32 : posix).join(bunHome(layout), "install", "cache");

export interface BuildEnvInput {
	layout: Layout;
	/** The active tool versions of `state/current.json`. */
	current: CurrentTools;
	/** The app's own environment: read for the allow-listed names only. */
	appEnv: EnvLike;
	/** The optional tools the active recipe names: each adds its own variables (bun: `BUN_INSTALL`). */
	optionalTools?: readonly string[];
	/** The OS proxy setting resolved by `resolveOsProxy`; variables the app's environment sets win over it. */
	proxy?: OsProxy;
	/** Decrypted from `secrets/linear.bin`. Pass it only for the Herdr server's environment, so panes and `ttt` see it and no file holds it. */
	linearApiKey?: string;
	/** Windows: bun's folders by their 8.3 names, for a recipe that names bun. */
	shortNames?: ShortNames;
}

/** The value of `name` in `env`, Windows-style (case-insensitive) when `fold` is set. */
function lookup(env: EnvLike, name: string, fold: boolean): [string, string] | undefined {
	for (const [key, value] of Object.entries(env)) {
		if (value === undefined || value === "") continue;
		if (key === name || (fold && key.toLowerCase() === name.toLowerCase())) return [key, value];
	}
	return undefined;
}

/**
 * Puts the resolved bypass list into `out`, joined with whatever list the PM's own environment set (T6-F003). The resolved list carries the loopback names and
 * the forge hosts the PAC file sends DIRECT; a lowercase `no_proxy` of the PM's would hide the upper-case one from clients that read the lowercase name first
 * (curl, so Git), and the PM's list alone would send the loopback calls and those hosts through the proxy. So both spellings hold the same union on macOS,
 * where names are case-sensitive; on Windows there is one variable, kept under the name the PM gave it. A PM's `*` (no proxy for any host) stays `*` alone:
 * curl reads `*` as every host only when it is the whole list, so joining it to other names would send Git through the proxy (R6-F002).
 */
function mergeNoProxy(out: EnvMap, resolved: string, win: boolean): void {
	const spellings = Object.keys(out).filter((k) => k.toLowerCase() === "no_proxy");
	const everyHost = spellings.some((k) => (out[k] as string).split(",").some((entry) => entry.trim() === "*"));
	if (everyHost) {
		if (win) out[spellings[0] ?? "NO_PROXY"] = "*";
		else {
			out.NO_PROXY = "*";
			out.no_proxy = "*";
		}
		return;
	}
	const seen = new Set<string>();
	const entries: string[] = [];
	for (const entry of [resolved, ...spellings.map((k) => out[k] as string)].flatMap((list) => list.split(","))) {
		const trimmed = entry.trim();
		if (trimmed !== "" && !seen.has(trimmed.toLowerCase())) {
			seen.add(trimmed.toLowerCase());
			entries.push(trimmed);
		}
	}
	const value = entries.join(",");
	if (win) {
		out[spellings[0] ?? "NO_PROXY"] = value;
		return;
	}
	out.NO_PROXY = value;
	out.no_proxy = value;
}

export function buildEnv({ layout, current, appEnv, proxy, linearApiKey, optionalTools, shortNames }: BuildEnvInput): EnvMap {
	const win = layout.platform === "win32";
	const P = win ? win32 : posix;
	const out: EnvMap = {};
	const taken = (name: string): boolean => Object.keys(out).some((k) => (win ? k.toLowerCase() === name.toLowerCase() : k === name));

	for (const name of win ? WIN_ESSENTIALS : MAC_ESSENTIALS) {
		const found = lookup(appEnv, name, win);
		if (found) out[found[0]] = found[1];
	}

	for (const name of PASS_THROUGH) {
		// macOS names are case-sensitive: `https_proxy` and `HTTPS_PROXY` are both passed when both are set.
		for (const key of win ? [lookup(appEnv, name, true)?.[0]] : [name, name.toLowerCase()]) {
			const value = key === undefined ? undefined : appEnv[key];
			if (key !== undefined && value !== undefined && value !== "") out[key] = value;
		}
	}
	for (const [name, value] of Object.entries(proxy?.env ?? {})) if (name !== "NO_PROXY" && !taken(name)) out[name] = value;
	if (proxy?.env.NO_PROXY !== undefined) mergeNoProxy(out, proxy.env.NO_PROXY, win);

	const own = P.delimiter;
	const entries = toolPathEntries(layout, current);
	const base = win ? (lookup(appEnv, "PATH", true)?.[1] ?? "").split(own).filter((e) => e !== "") : MAC_BASE_PATH;
	const same = (a: string, b: string): boolean => (win ? a.toLowerCase() === b.toLowerCase() : a === b);
	const rest = base.filter((e) => !entries.some((own2) => same(own2, e)));
	out.PATH = [...entries, ...rest].join(own);

	Object.assign(out, {
		PI_CODING_AGENT_DIR: layout.agent,
		NPM_CONFIG_PREFIX: layout.tools.npm,
		NPM_CONFIG_CACHE: layout.tools.npmCache,
		// npm answers from its cached metadata for up to 5 minutes without asking the registry, so a pin published after the copy was made fails as "not found".
		NPM_CONFIG_PREFER_ONLINE: "true",
		NPM_CONFIG_UPDATE_NOTIFIER: "false",
		NPM_CONFIG_FUND: "false",
		NPM_CONFIG_AUDIT: "false",
		STRAW_BOSS_DESK: "1",
		STRAW_BOSS_DESK_ROOT: layout.root,
		XDG_CONFIG_HOME: layout.configHome,
		HERDR_CONFIG_PATH: layout.herdrConfig,
		HERDR_SOCKET_PATH: layout.herdrSocket,
		HERDR_BIN_PATH: herdrBinary(layout, current),
		HERDR_DISABLE_SOUND: "1",
		CLAUDE_CONFIG_DIR: layout.claude,
		GIT_CONFIG_GLOBAL: layout.gitconfig,
		PI_TELEMETRY: "0",
		PI_SKIP_VERSION_CHECK: "1",
		DISABLE_TELEMETRY: "1",
		DISABLE_ERROR_REPORTING: "1",
		// npm and pi trust the OS certificate store as well as Node's bundled one (supported by the pinned Node 24).
		NODE_USE_SYSTEM_CA: "1",
	});
	if (!win) {
		out.ZDOTDIR = layout.zdotdir;
		// dugite-native's git is not relocatable on macOS: without these it looks for its helpers in `//libexec/git-core` and its templates in
		// `//share/git-core/templates` ("remote-https is not a git command"). dugite's own JavaScript wrapper sets both (task 5 finding).
		out.GIT_EXEC_PATH = posix.join(toolDir(layout, "git", current.git), "libexec", "git-core");
		out.GIT_TEMPLATE_DIR = posix.join(toolDir(layout, "git", current.git), "share", "git-core", "templates");
	}
	for (const tool of optionalTools ?? []) Object.assign(out, optionalToolEnv(layout, tool, shortNames));
	if (linearApiKey !== undefined && linearApiKey !== "") out.LINEAR_API_KEY = linearApiKey;

	for (const name of Object.keys(out)) {
		if (OWN.has(name)) continue;
		if (NEVER_CARRY.some((n) => (win ? n.toLowerCase() === name.toLowerCase() : n === name)) || /^PI_SUBAGENT_/i.test(name)) {
			throw new Error(`the constructed environment would carry ${name}`);
		}
	}
	return out;
}

// ---- the OS proxy setting ------------------------------------------------------------------------------------------

/** Chromium's `session.resolveProxy(url)`: a list such as `PROXY a:8080; PROXY b:8080; DIRECT`. */
export type ProxyResolver = (url: string) => Promise<string>;

export interface OsProxy {
	/** Variables to add; empty when nothing is to be set. */
	env: EnvMap;
	/** Every answer and every decision, for `logs/` (the spec logs the answers it does not use). */
	log: string[];
}

export type ProxyAnswer = { kind: "direct" } | { kind: "proxy"; hostPort: string } | { kind: "other"; text: string };

/** The first entry of a resolver answer. `PROXY` and `HTTPS` name an HTTP proxy; `SOCKS*` and anything else cannot be given to npm. */
export function firstProxyEntry(answer: string): ProxyAnswer {
	const first = answer.split(";")[0]?.trim() ?? "";
	if (first === "" || /^DIRECT$/i.test(first)) return { kind: "direct" };
	const m = /^(PROXY|HTTPS)\s+(\S+)$/i.exec(first);
	return m?.[2] ? { kind: "proxy", hostPort: m[2] } : { kind: "other", text: first };
}

/** The name part of a forge host (`gitlab.example.com:8443` gives `gitlab.example.com`); a value that is no host fails here, before any lookup. */
function hostnameOf(host: string): string {
	try {
		return new URL(`https://${host}/`).hostname;
	} catch {
		throw new Error(`not a host name: ${JSON.stringify(host)}`);
	}
}

const hasProxyVariable = (env: EnvLike): boolean => Object.entries(env).some(([k, v]) => v !== undefined && v !== "" && (k.toUpperCase() === "HTTPS_PROXY" || k.toUpperCase() === "HTTP_PROXY"));

/**
 * Asks the OS proxy setting for the npm registry, github.com, and each forge host, and turns the answer into `HTTPS_PROXY`, `HTTP_PROXY`, and
 * `NO_PROXY` (spec: The OS proxy setting). Nothing is set when the app's environment already names a proxy, when the registry is `DIRECT`, when
 * the registry's answer is not an HTTP proxy, or when any host's proxy differs from the registry's: one variable cannot name two proxies.
 */
export async function resolveOsProxy({ resolve, forgeHosts, appEnv }: { resolve: ProxyResolver; forgeHosts: readonly string[]; appEnv: EnvLike }): Promise<OsProxy> {
	const log: string[] = [];
	const none = (why: string): OsProxy => {
		log.push(why);
		return { env: {}, log };
	};
	if (hasProxyVariable(appEnv)) return none("the app's environment names a proxy; the OS proxy setting is not used");

	const registry = "https://registry.npmjs.org/";
	const hosts = [...new Set(["github.com", ...forgeHosts.map((h) => h.toLowerCase())])];
	const hostnames = new Map(hosts.map((h) => [h, hostnameOf(h)]));
	const answers = new Map<string, string>();
	for (const [label, url] of [["registry.npmjs.org", registry], ...hosts.map((h): [string, string] => [h, `https://${h}/`])] as Array<[string, string]>) {
		try {
			const answer = await resolve(url);
			answers.set(label, answer);
			log.push(`${label}: ${answer}`);
		} catch (error) {
			return none(`${label}: the OS proxy setting could not be read (${(error as Error).message}); nothing is set`);
		}
	}

	const registryAnswer = firstProxyEntry(answers.get("registry.npmjs.org") ?? "");
	if (registryAnswer.kind === "direct") return none("the registry is DIRECT; nothing is set");
	if (registryAnswer.kind === "other") return none(`the registry's answer is ${registryAnswer.text}, which npm cannot use; nothing is set`);

	const direct: string[] = [];
	for (const host of hosts) {
		const answer = firstProxyEntry(answers.get(host) ?? "");
		if (answer.kind === "direct") direct.push(hostnames.get(host) ?? host);
		else if (answer.kind === "other" || answer.hostPort.toLowerCase() !== registryAnswer.hostPort.toLowerCase()) {
			return none(`${host} would use a different proxy than the registry; one variable cannot name two proxies, so nothing is set`);
		}
	}
	const url = `http://${registryAnswer.hostPort}`;
	log.push(`using ${url}; NO_PROXY adds ${direct.length === 0 ? "no host" : direct.join(", ")}`);
	return { env: { HTTPS_PROXY: url, HTTP_PROXY: url, NO_PROXY: [LOOPBACK, ...direct].join(",") }, log };
}
