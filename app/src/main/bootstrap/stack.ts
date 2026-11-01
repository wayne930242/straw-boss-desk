// The part of `stack.json` the engine reads (spec: Decisions, `stack.json` channel integrity; task 2). The full schema and the signature are checked
// where the file enters the app (task 13); here the engine only refuses a shape it cannot act on, so a bad pin fails before any download.

export type PlatformKey = "win32-x64" | "darwin-arm64" | "darwin-x64";

export interface Asset {
	version: string;
	url: string;
	sha256: string;
	file: string;
}

export interface NpmPin {
	name: string;
	version: string;
	integrity: string;
	bin?: string;
	optional?: boolean;
}

export interface ToolEntry {
	assets: Partial<Record<PlatformKey, Asset>>;
}

export interface Stack {
	schema: 1;
	generation: number;
	minShell: string;
	tools: Record<string, ToolEntry>;
	/** Tools a recipe's `tools` list turns on (spec: Decisions, Optional tools). Empty when the stack names none. */
	optionalTools: Record<string, ToolEntry>;
	npmGlobal: NpmPin[];
	profile: { name: string; version: string; integrity: string };
	piPackages: NpmPin[];
}

export class StackError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "StackError";
	}
}

/** The asset key for this machine. Windows is x64 everywhere, also on ARM, where it runs under emulation (spec: Decisions). */
export function platformKey(platform: NodeJS.Platform, arch: string): PlatformKey {
	if (platform === "win32") return "win32-x64";
	if (platform === "darwin" && arch === "arm64") return "darwin-arm64";
	if (platform === "darwin" && arch === "x64") return "darwin-x64";
	throw new StackError(`no stack assets for ${platform}/${arch}`);
}

const SHA256 = /^[0-9a-f]{64}$/;
/** The same rule as `recipe/validate.mjs` (a name becomes an `SBD_<TOOL>` variable) and `scripts/lib/stack.mjs`. */
const OPTIONAL_TOOL_NAME = /^[a-z][a-z0-9]{0,31}$/;
/** Folders under `tools/` that are not tools: an optional tool of that name would share their folder (FE2R-F008). */
const RESERVED_TOOL_FOLDERS = ["bin", "shims", "downloads", "bun-home", "staging"];
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:[.-][0-9A-Za-z.-]+)?$/;
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Why `url` may not be a pinned download, or null. A download is HTTPS; plain HTTP is allowed only for the loopback fixture server of a test. */
export function downloadUrlProblem(url: string): string | null {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return "is not a URL";
	}
	const loopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "[::1]";
	if (parsed.protocol === "https:" || (parsed.protocol === "http:" && loopback)) return null;
	return "must be https";
}

function parseAsset(where: string, value: unknown): Asset {
	if (!isObject(value)) throw new StackError(`${where} is not an object`);
	const { version, url, sha256, file } = value;
	if (typeof version !== "string" || !EXACT_VERSION.test(version)) throw new StackError(`${where}.version must be an exact version`);
	if (typeof sha256 !== "string" || !SHA256.test(sha256)) throw new StackError(`${where}.sha256 must be 64 lowercase hex digits`);
	if (typeof file !== "string" || file === "" || /[\\/]/.test(file) || file === "." || file === "..") throw new StackError(`${where}.file must be a plain file name`);
	// `-` is stdin to tar (it would wait for input), and a leading `-` can read as an option.
	if (file.startsWith("-")) throw new StackError(`${where}.file must not start with \`-\``);
	if (typeof url !== "string") throw new StackError(`${where}.url must be a string`);
	const problem = downloadUrlProblem(url);
	if (problem !== null) throw new StackError(`${where}.url ${problem}`);
	return { version, url, sha256, file };
}

function parseToolEntries(where: string, value: unknown): Record<string, ToolEntry> {
	if (!isObject(value)) throw new StackError(`the stack's ${where} must be an object`);
	const out: Record<string, ToolEntry> = {};
	for (const [tool, entry] of Object.entries(value)) {
		if (!isObject(entry) || !isObject(entry.assets)) throw new StackError(`${where}.${tool}.assets must be an object`);
		const assets: Partial<Record<PlatformKey, Asset>> = {};
		for (const [key, asset] of Object.entries(entry.assets)) {
			if (key !== "win32-x64" && key !== "darwin-arm64" && key !== "darwin-x64") throw new StackError(`${where}.${tool}.assets has an unknown platform key ${key}`);
			assets[key] = parseAsset(`${where}.${tool}.assets.${key}`, asset);
		}
		out[tool] = { assets };
	}
	return out;
}

/** Checks the shape the engine uses and returns it typed. Throws `StackError` naming the first bad field. */
export function parseStack(value: unknown): Stack {
	if (!isObject(value)) throw new StackError("the stack is not an object");
	if (value.schema !== 1) throw new StackError("the stack's schema must be 1");
	if (typeof value.generation !== "number" || !Number.isInteger(value.generation) || value.generation < 1) throw new StackError("the stack's generation must be a positive integer");
	if (typeof value.minShell !== "string") throw new StackError("the stack's minShell must be a string");
	if (!isObject(value.tools)) throw new StackError("the stack's tools must be an object");
	const tools = parseToolEntries("tools", value.tools);
	const optionalTools = value.optionalTools === undefined ? {} : parseToolEntries("optionalTools", value.optionalTools);
	for (const name of Object.keys(optionalTools)) {
		if (!OPTIONAL_TOOL_NAME.test(name)) throw new StackError(`optionalTools.${name}: a tool name is lowercase letters and digits, starting with a letter, at most 32 characters`);
		if (name in tools) throw new StackError(`optionalTools.${name}: ${name} is also a required tool`);
		if (RESERVED_TOOL_FOLDERS.includes(name)) throw new StackError(`optionalTools.${name}: ${name} is a folder under tools/ that is not a tool`);
	}
	const pins = (where: string, list: unknown): NpmPin[] => {
		if (!Array.isArray(list)) throw new StackError(`${where} must be a list`);
		return list.map((p, i) => {
			if (!isObject(p) || typeof p.name !== "string" || typeof p.version !== "string" || typeof p.integrity !== "string") throw new StackError(`${where}[${i}] needs name, version, and integrity`);
			if (!EXACT_VERSION.test(p.version)) throw new StackError(`${where}[${i}].version must be an exact version`);
			return { name: p.name, version: p.version, integrity: p.integrity, ...(typeof p.bin === "string" ? { bin: p.bin } : {}), ...(p.optional === true ? { optional: true } : {}) };
		});
	};
	const profile = value.profile;
	if (!isObject(profile) || typeof profile.name !== "string" || typeof profile.version !== "string" || typeof profile.integrity !== "string") {
		throw new StackError("the stack's profile needs name, version, and integrity");
	}
	return {
		schema: 1,
		generation: value.generation,
		minShell: value.minShell,
		tools,
		optionalTools,
		npmGlobal: pins("npmGlobal", value.npmGlobal),
		profile: { name: profile.name, version: profile.version, integrity: profile.integrity },
		piPackages: pins("piPackages", value.piPackages),
	};
}

/** The pinned download of `tool` for this machine. Throws `StackError` when the stack has none, so a stage never guesses. */
export function assetFor(stack: Stack, tool: string, key: PlatformKey): Asset {
	const asset = (stack.tools[tool] ?? stack.optionalTools[tool])?.assets[key];
	if (asset === undefined) throw new StackError(`the stack has no ${tool} for ${key}`);
	return asset;
}

/** The names under `optionalTools`: what `validateRecipe` takes as `knownTools`, and the only tools a recipe may turn on. */
export const optionalToolNames = (stack: Stack): string[] => Object.keys(stack.optionalTools);
