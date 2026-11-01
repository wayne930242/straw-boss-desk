import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, posix, win32 } from "node:path";

// The app data root and its layout (spec: App data layout). `dataRoot` picks the root; `computeLayout` applies the layout's constraints once
// and `loadLayout` records the answer in `state/layout.json`, so a later start never computes another place.

export interface RootInput {
	env: Readonly<Record<string, string | undefined>>;
	argv: readonly string[];
	platform: NodeJS.Platform;
	home: string;
}

/** `--root=<dir>` wins over `STRAW_BOSS_DESK_ROOT`, which wins over the platform default. Honored in every build. */
export function dataRoot({ env, argv, platform, home }: RootInput): string {
	const fromArg = argv.find((a) => a.startsWith("--root="))?.slice("--root=".length);
	const override = fromArg || env.STRAW_BOSS_DESK_ROOT;
	if (override) return override;
	if (platform === "win32") {
		const local = env.LOCALAPPDATA || join(home, "AppData", "Local");
		return join(local, "straw-boss-desk");
	}
	if (platform === "darwin") return join(home, "Library", "Application Support", "straw-boss-desk");
	throw new Error(`unsupported platform ${platform}; set STRAW_BOSS_DESK_ROOT to run a development build`);
}

/** Chromium's profile and caches (`app.setPath("userData")`); nothing lands in the roaming %APPDATA%. */
export const electronDir = (root: string): string => join(root, "electron");

// ---- the layout ----------------------------------------------------------------------------------------------------

export type AppPlatform = "win32" | "darwin";

/** `sun_path` holds 104 bytes on macOS; Herdr's sockets stay at most this long (spec: App data layout). */
export const MAX_SOCKET_BYTES = 100;
/** Herdr also binds `herdr-client.sock` in the socket's folder, 7 bytes longer than `herdr.sock`; the rule measures the longer one (found by task 5's e2e: Herdr 0.9.5 exits with "local socket name length exceeds capacity" at a 99-byte main socket). */
export const HERDR_CLIENT_SOCKET_NAME = "herdr-client.sock";

/** Raised when the layout cannot satisfy a constraint even through its fallback. The wizard shows it; nothing is written. */
export class LayoutError extends Error {
	readonly code: "root-not-absolute" | "socket-too-long" | "fallback-outside-home" | "unsupported-platform";
	constructor(code: LayoutError["code"], message: string) {
		super(message);
		this.name = "LayoutError";
		this.code = code;
	}
}

export interface LayoutInput {
	/** The data root as `dataRoot` returned it. */
	root: string;
	/** The user's home: `%USERPROFILE%` or `$HOME`. */
	home: string;
	platform: AppPlatform;
	/** Real path of an existing path (default `fs.realpathSync.native`). Tests pass a table. */
	realpath?: (path: string) => string;
}

/**
 * The version of the rules `computeLayout` applies. A record written under another version is computed again on load (T5-F010): task 3's socket rule
 * measured `herdr.sock`, task 5's measures `herdr-client.sock`, so a record from task 3 can name a config home Herdr cannot bind in.
 */
export const LAYOUT_RULE = 2;

/** What `state/layout.json` holds: the decisions, each with the reason it was taken. Paths only; no secrets. */
export interface LayoutRecord {
	schema: 1;
	/** `LAYOUT_RULE` at the time of writing. */
	rule: number;
	platform: AppPlatform;
	root: string;
	realRoot: string;
	home: string;
	/** First 8 hex digits of the SHA-256 of `realRoot`: names the fallback folder, so two roots never share one. */
	id: string;
	agentDir: string;
	/** XDG_CONFIG_HOME: Herdr's folder (config, socket) and the macOS ZDOTDIR files. */
	configHome: string;
	/** `~/.straw-boss-desk/<id>` when anything fell back, else null. **Remove all data** deletes it with the root. */
	fallbackDir: string | null;
	herdrSocket: string;
	herdrSocketBytes: number;
	/** `<agent>/straw-boss/agents/<16 hex>.sock` on macOS (seam U11 has no short-path fallback yet); null on Windows. */
	sidecarSocketBytes: number | null;
	reasons: string[];
}

export interface Layout {
	platform: AppPlatform;
	root: string;
	id: string;
	stack: string;
	tools: {
		root: string;
		npm: string;
		npmCache: string;
		downloads: string;
		bin: string;
		/** Windows only: the real `.exe` shims of the optional tools (`bun.exe`), on the PATH after `bin` so that a lookup through PATHEXT finds `bin`'s launchers first (T5-F001). */
		binExe: string;
		shims: string;
	};
	agent: string;
	configHome: string;
	/** gh and glab keep their folders beside the root's `config/`, where the launchers find them from their own place (`tools/bin/../..`). */
	ghConfig: string;
	glabConfig: string;
	herdrDir: string;
	herdrConfig: string;
	herdrSocket: string;
	zdotdir: string;
	claude: string;
	gitconfig: string;
	secrets: string;
	recipe: string;
	state: string;
	logs: string;
	electron: string;
	record: LayoutRecord;
}

export const SIDECAR_SOCKET_NAME = `${"0".repeat(16)}.sock`;

const pathModule = (platform: AppPlatform) => (platform === "win32" ? win32 : posix);
const byteLength = (text: string): number => Buffer.byteLength(text, "utf8");

/** Real path of the deepest part of `path` that exists, with the rest appended: the root is new on a first run. */
function realpathLoose(path: string, realpath: (p: string) => string, P: typeof posix): string {
	const missing: string[] = [];
	let current = path;
	for (;;) {
		try {
			const real = realpath(current);
			return missing.length === 0 ? real : P.join(real, ...missing.toReversed());
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
			const parent = P.dirname(current);
			if (parent === current) throw error;
			missing.push(P.basename(current));
			current = parent;
		}
	}
}

/** True when `child` is `parent` or lies below it. `win32.relative` compares without regard to case, as the file system does. */
export function isInside(parent: string, child: string, P: typeof posix = posix): boolean {
	const rel = P.relative(parent, child);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${P.sep}`) && !P.isAbsolute(rel));
}

/** The layout and the constraints of the spec's App data layout; pure apart from `realpath`. */
export function computeLayout(input: LayoutInput): Layout {
	const { root, home, platform } = input;
	if (platform !== "win32" && platform !== "darwin") throw new LayoutError("unsupported-platform", `unsupported platform ${String(platform)}`);
	const P = pathModule(platform);
	if (!P.isAbsolute(root)) throw new LayoutError("root-not-absolute", `the data root must be an absolute path: ${root}`);
	const realpath = input.realpath ?? ((p: string) => realpathSync.native(p));
	const realRoot = realpathLoose(root, realpath, P);
	const realHome = realpathLoose(home, realpath, P);
	const id = createHash("sha256").update(realRoot).digest("hex").slice(0, 8);
	const fallbackDir = P.join(home, ".straw-boss-desk", id);
	const reasons: string[] = [];
	let fellBack = false;

	let agentDir = P.join(root, "agent");
	if (platform === "win32") {
		// pi-straw-boss's trust relay accepts the agent folder only inside the user's home by realpath.native (src/trust/files.ts, ensureDir).
		const realAgent = realpathLoose(agentDir, realpath, P);
		if (!isInside(realHome, realAgent, P)) {
			agentDir = P.join(fallbackDir, "agent");
			const realFallback = realpathLoose(agentDir, realpath, P);
			if (!isInside(realHome, realFallback, P)) {
				throw new LayoutError("fallback-outside-home", `the agent folder ${agentDir} resolves to ${realFallback}, outside the home ${realHome}`);
			}
			fellBack = true;
			reasons.push(`the agent folder ${realAgent} lies outside the home ${realHome}, so it moved to ${agentDir}`);
		}
	}

	let configHome = P.join(root, "config");
	const socketOf = (config: string): string => P.join(config, "herdr", "herdr.sock");
	/** The longest socket Herdr binds under a config home. */
	const longestSocketBytes = (config: string): number => byteLength(P.join(config, "herdr", HERDR_CLIENT_SOCKET_NAME));
	let herdrSocket = socketOf(configHome);
	if (platform === "darwin" && longestSocketBytes(configHome) > MAX_SOCKET_BYTES) {
		const before = longestSocketBytes(configHome);
		configHome = P.join(fallbackDir, "config");
		herdrSocket = socketOf(configHome);
		if (longestSocketBytes(configHome) > MAX_SOCKET_BYTES) {
			throw new LayoutError("socket-too-long", `Herdr's socket path would be ${longestSocketBytes(configHome)} bytes even in ${configHome} (limit ${MAX_SOCKET_BYTES}); the home folder's path is too long`);
		}
		fellBack = true;
		reasons.push(`Herdr's socket path was ${before} bytes (limit ${MAX_SOCKET_BYTES}), so XDG_CONFIG_HOME moved to ${configHome}`);
	}

	const sidecarSocketBytes = platform === "darwin" ? byteLength(P.join(agentDir, "straw-boss", "agents", SIDECAR_SOCKET_NAME)) : null;
	const record: LayoutRecord = {
		schema: 1,
		rule: LAYOUT_RULE,
		platform,
		root,
		realRoot,
		home,
		id,
		agentDir,
		configHome,
		fallbackDir: fellBack ? fallbackDir : null,
		herdrSocket,
		herdrSocketBytes: byteLength(herdrSocket),
		sidecarSocketBytes,
		reasons,
	};
	return layoutFromRecord(record);
}

/** Every path of the layout, from a record's decisions. */
export function layoutFromRecord(record: LayoutRecord): Layout {
	const P = pathModule(record.platform);
	const { root } = record;
	const tools = P.join(root, "tools");
	const config = P.join(root, "config");
	return {
		platform: record.platform,
		root,
		id: record.id,
		stack: P.join(root, "stack"),
		tools: {
			root: tools,
			npm: P.join(tools, "npm"),
			npmCache: P.join(tools, "npm-cache"),
			downloads: P.join(tools, "downloads"),
			bin: P.join(tools, "bin"),
			binExe: P.join(tools, "bin-exe"),
			shims: P.join(tools, "shims"),
		},
		agent: record.agentDir,
		configHome: record.configHome,
		ghConfig: P.join(config, "gh"),
		glabConfig: P.join(config, "glab-cli"),
		herdrDir: P.join(record.configHome, "herdr"),
		herdrConfig: P.join(record.configHome, "herdr", "config.toml"),
		herdrSocket: record.herdrSocket,
		zdotdir: P.join(record.configHome, "zsh"),
		claude: P.join(root, "claude"),
		gitconfig: P.join(root, "gitconfig"),
		secrets: P.join(root, "secrets"),
		recipe: P.join(root, "recipe"),
		state: P.join(root, "state"),
		logs: P.join(root, "logs"),
		electron: P.join(root, "electron"),
		record,
	};
}

/**
 * True when the recorded decisions still satisfy the rules in force: the rule version is current and, on macOS, Herdr's longest socket under the
 * recorded config home fits `sun_path` (checked again, so a record edited by hand or written by a build with another measurement cannot pass).
 */
export function recordIsCurrent(record: LayoutRecord): boolean {
	if (record.rule !== LAYOUT_RULE) return false;
	if (record.platform !== "darwin") return true;
	return byteLength(posix.join(record.configHome, "herdr", HERDR_CLIENT_SOCKET_NAME)) <= MAX_SOCKET_BYTES;
}

function readRecord(file: string): LayoutRecord | null {
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
	try {
		const parsed: unknown = JSON.parse(text);
		if (typeof parsed !== "object" || parsed === null) return null;
		const r = parsed as Partial<LayoutRecord>;
		const strings = [r.root, r.realRoot, r.home, r.id, r.agentDir, r.configHome, r.herdrSocket];
		if (r.schema !== 1 || typeof r.rule !== "number" || !strings.every((s) => typeof s === "string" && s.length > 0)) return null;
		if (r.platform !== "win32" && r.platform !== "darwin") return null;
		if (typeof r.herdrSocketBytes !== "number" || !Array.isArray(r.reasons)) return null;
		return r as LayoutRecord;
	} catch {
		return null;
	}
}

/**
 * The layout for a start: the recorded one when `state/layout.json` was written for this root, home, and platform, else a fresh computation that is
 * written (by rename) before it returns. A record for another root or home, such as a copied data folder, is replaced, never reused: the fallback
 * folder and Herdr's socket belong to one root.
 */
export function loadLayout(input: LayoutInput): Layout {
	const P = pathModule(input.platform);
	const file = P.join(input.root, "state", "layout.json");
	const recorded = readRecord(file);
	if (recorded && recorded.root === input.root && recorded.home === input.home && recorded.platform === input.platform && recordIsCurrent(recorded)) {
		return layoutFromRecord(recorded);
	}
	const layout = computeLayout(input);
	mkdirSync(P.dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	try {
		writeFileSync(tmp, `${JSON.stringify(layout.record, null, "\t")}\n`, "utf8");
		renameSync(tmp, file);
	} catch (error) {
		rmSync(tmp, { force: true });
		throw error;
	}
	return layout;
}

// ---- the tool folders ----------------------------------------------------------------------------------------------

/** The active versions of `state/current.json` the environment needs: one version string per versioned tool folder. */
export interface CurrentTools {
	node: string;
	git: string;
	herdr: string;
	gh?: string;
	glab?: string;
}

/** The executable of a versioned tool inside its folder, relative to it, with `/` separators: where the stages put it and the path files name it. */
export function toolExecutable(platform: AppPlatform, tool: string): string {
	const exe = platform === "win32" ? ".exe" : "";
	switch (tool) {
		case "node": return platform === "win32" ? "node.exe" : "bin/node";
		case "git": return `bin/git${exe}`;
		case "herdr": return `herdr${exe}`;
		case "gh":
		case "glab": return `bin/${tool}${exe}`;
		default: return `${tool}${exe}`;
	}
}

/** `tools/<tool>/<version>`; `tool` is one of the five required tools or an optional tool's name (`bun`). */
export const toolDir = (layout: Layout, tool: string, version: string): string =>
	pathModule(layout.platform).join(layout.tools.root, tool, version);

/**
 * The app's `PATH` folders in order (spec: Tool paths): `tools/bin`, on Windows `tools/bin-exe`, Node, the npm prefix, Git's folders, Herdr. The layout of each tool's folder is
 * fixed here and the stages extract to it: Windows has `node.exe` at the top of the Node folder and PortableGit's `cmd` and `bin`; macOS has
 * `bin/` in the Node and dugite-native folders and the npm prefix, and the bare `herdr` binary in its folder.
 */
export function toolPathEntries(layout: Layout, current: CurrentTools): string[] {
	const P = pathModule(layout.platform);
	const node = toolDir(layout, "node", current.node);
	const git = toolDir(layout, "git", current.git);
	const herdr = toolDir(layout, "herdr", current.herdr);
	if (layout.platform === "win32") return [layout.tools.bin, layout.tools.binExe, node, layout.tools.npm, P.join(git, "cmd"), P.join(git, "bin"), herdr];
	return [layout.tools.bin, P.join(node, "bin"), P.join(layout.tools.npm, "bin"), P.join(git, "bin"), herdr];
}

export const herdrBinary = (layout: Layout, current: CurrentTools): string =>
	pathModule(layout.platform).join(toolDir(layout, "herdr", current.herdr), layout.platform === "win32" ? "herdr.exe" : "herdr");
