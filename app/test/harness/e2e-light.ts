// Test code for the e2e-light anchors (task 5): a scratch "world" (home, data root, constructed environment), the real engine against the real
// stack.json with real downloads, and a Herdr server of the world's own. Nothing here touches the author's machine: every path is under a scratch folder,
// the Herdr socket is the world's own, and the app environment the children get is built from nothing but the world.
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildEnv, systemEnv, type EnvMap } from "../../src/main/env.ts";
import { loadLayout, type AppPlatform, type CurrentTools, type Layout } from "../../src/main/paths.ts";
import { createEngine, type EngineEvent } from "../../src/main/bootstrap/engine.ts";
import type { Fetch } from "../../src/main/bootstrap/download.ts";
import { removeTree } from "../../src/main/bootstrap/fsutil.ts";
import { toolStages, type StageOptions } from "../../src/main/bootstrap/stages/index.ts";
import type { StageOutcome } from "../../src/main/bootstrap/stage.ts";
import type { RunResult, UserPath, UserPathValue } from "../../src/main/platform/types.ts";
import { planEnsureFirst, planRemove } from "../../src/main/platform/win.ts";
import { hostedCase } from "./hosted.ts";
import { platformKey } from "../../src/main/bootstrap/stack.ts";
import { ALT_BUN, ALT_GH } from "./alt-pins.ts";
import { tarGz } from "./archives.ts";
import { testPlatform, secretPatterns } from "./engine-fixture.ts";
import { createPlatform } from "../../src/main/platform/index.ts";

export const platformOfHost: AppPlatform = process.platform === "win32" ? "win32" : "darwin";
export const isWindows = process.platform === "win32";

export const realStack = JSON.parse(readFileSync(new URL("../../../stack.json", import.meta.url), "utf8")) as { tools: Record<string, any>; optionalTools: Record<string, any> } & Record<string, unknown>;

export interface World {
	/** The scratch folder everything lives under. */
	base: string;
	/** The home the children get: `$HOME` / `%USERPROFILE%`. Scratch, never the machine's. */
	home: string;
	root: string;
	layout: Layout;
	/** What the app's own environment is, for the constructed environment: system essentials and a home that is the world's. */
	appEnv: Record<string, string>;
	/** URLs fetched by the engine, in order. */
	requests: string[];
	/** The folder the CI cache holds downloads in, when the workflow sets one. */
	cache: string | null;
	/**
	 * The user PATH the `pi-shim` stage writes to (Windows). On a GitHub-hosted runner it is the real one (`HKCU\Environment`, a guarded fixture: all six
	 * signals of the guard); anywhere else it is an in-memory stand-in, so a run on a developer's Windows machine never writes the registry.
	 */
	userPath: UserPath;
	/** True when `userPath` is the real one. */
	realUserPath: boolean;
	/** The real user PATH as it was when the world was made (hosted Windows only), for the byte-for-byte check at the end. */
	userPathBefore: UserPathValue | null | undefined;
}

/** A user PATH that lives in memory: the rules of `UserPath` (type kept, only the exact entry changed) without a registry. */
export function memoryUserPath(initial: UserPathValue | null = null): UserPath & { value: UserPathValue | null } {
	const self: UserPath & { value: UserPathValue | null } = {
		supported: true,
		value: initial,
		async read() {
			return self.value;
		},
		async ensureFirst(entry) {
			const plan = planEnsureFirst(self.value, entry);
			self.value = plan.next;
			return { changed: plan.changed };
		},
		async remove(entry) {
			const plan = planRemove(self.value, entry);
			self.value = plan.next;
			return { changed: plan.changed };
		},
	};
	return self;
}

/** A short scratch folder: the macOS socket path of Herdr is limited to 100 bytes, so the base is under /tmp there. */
function scratchBase(prefix: string): string {
	const parent = isWindows ? tmpdir() : "/tmp";
	return realpathSync.native(mkdtempSync(join(parent, prefix)));
}

export function createWorld(label: string, appEnvExtra: Record<string, string> = {}): World {
	const base = scratchBase(`sbde-${label}-`);
	const home = join(base, "home");
	mkdirSync(home, { recursive: true });
	// The root has a space on both platforms; on Windows it also has CJK characters and lies under the home, where the agent folder must be.
	const root = isWindows ? join(home, "AppData", "Local", "sbd 測試") : join(home, "Library", "Application Support", "straw-boss-desk");
	mkdirSync(root, { recursive: true });
	const layout = loadLayout({ root, home, platform: platformOfHost });
	const appEnv: Record<string, string> = isWindows
		? { ...pick(process.env, ["SystemRoot", "SystemDrive", "windir", "ComSpec", "PATHEXT", "ProgramData", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "OS"]), USERPROFILE: home, HOME: home, APPDATA: join(home, "AppData", "Roaming"), LOCALAPPDATA: join(home, "AppData", "Local"), TEMP: join(base, "tmp"), TMP: join(base, "tmp"), USERNAME: "runner", PATH: process.env.PATH ?? process.env.Path ?? "" }
		: { HOME: home, USER: "runner", LOGNAME: "runner", SHELL: "/bin/bash", TMPDIR: join(base, "tmp"), LANG: "en_US.UTF-8" };
	mkdirSync(join(base, "tmp"), { recursive: true });
	// The user PATH entry is a registry write: the real one only where the guard says this is a GitHub-hosted runner.
	const real = platformOfHost === "win32" && hostedCase("pi-shim user PATH entry").run;
	const userPath = real ? createPlatform().userPath : platformOfHost === "win32" ? memoryUserPath() : createPlatform().userPath;
	return { base, home, root, layout, appEnv: { ...appEnv, ...appEnvExtra }, requests: [], cache: process.env.SBD_E2E_DOWNLOADS || null, userPath, realUserPath: real, userPathBefore: undefined };
}

/** Reads the real user PATH before the first run, so the end of the suite can compare it. Hosted Windows only; otherwise a no-op. */
export async function noteUserPath(world: World): Promise<void> {
	if (world.realUserPath) world.userPathBefore = await world.userPath.read();
}

function pick(env: NodeJS.ProcessEnv, names: string[]): Record<string, string> {
	const out: Record<string, string> = {};
	for (const name of names) {
		const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase());
		if (key !== undefined && env[key] !== undefined) out[name] = env[key] as string;
	}
	return out;
}

/** Takes the world's entry off the user PATH (the real one on a hosted runner) and deletes the scratch folder. */
export async function disposeWorld(world: World): Promise<void> {
	try {
		if (world.realUserPath) await world.userPath.remove(world.layout.tools.shims);
	} finally {
		removeTree(world.base);
	}
}

// ---- downloads ---------------------------------------------------------------------------------------------------------

/**
 * The file names the e2e downloads on this machine: every pin of stack.json for its platform key (required and optional tools) and the alternative gh and
 * bun pins. The CI cache holds these and nothing else (T5-F011 b): `restore-keys` brings back the files of older pins, and without this they would be saved
 * again forever.
 */
export function wantedDownloads(): Set<string> {
	const key = platformKey(process.platform, process.arch);
	const names = new Set<string>();
	for (const entry of [...Object.values(realStack.tools), ...Object.values(realStack.optionalTools)]) {
		const file = (entry.assets as Record<string, { file?: string }>)[key]?.file;
		if (file !== undefined) names.add(file);
	}
	names.add(ALT_GH[key].file);
	names.add(ALT_BUN[key].file);
	return names;
}

/** Puts the CI cache's wanted files into the world's download folder and deletes the others from the cache; the engine hashes every file it finds there, so a stale or bad file is replaced, not trusted. */
export function seedDownloads(world: World): void {
	if (world.cache === null || !existsSync(world.cache)) return;
	mkdirSync(world.layout.tools.downloads, { recursive: true });
	const wanted = wantedDownloads();
	for (const name of readdirSync(world.cache)) {
		if (!wanted.has(name)) rmSync(join(world.cache, name), { recursive: true, force: true });
		else copyFileSync(join(world.cache, name), join(world.layout.tools.downloads, name));
	}
}

/** Copies the world's verified downloads that this run wants to the CI cache folder. */
export function harvestDownloads(world: World): void {
	if (world.cache === null || !existsSync(world.layout.tools.downloads)) return;
	mkdirSync(world.cache, { recursive: true });
	const wanted = wantedDownloads();
	for (const name of readdirSync(world.layout.tools.downloads)) {
		if (name.endsWith(".part") || !wanted.has(name)) continue;
		const target = join(world.cache, name);
		if (!existsSync(target)) copyFileSync(join(world.layout.tools.downloads, name), target);
	}
}

// ---- the engine --------------------------------------------------------------------------------------------------------

export interface RunSummary {
	ok: boolean;
	outcomes: Record<string, StageOutcome>;
	order: string[];
	error: Extract<EngineEvent, { type: "error" }> | null;
	ms: number;
	/** The requests this run made. */
	requests: string[];
}

export interface RunOptions {
	stack?: unknown;
	recipe?: unknown;
	force?: boolean;
	preflight?: StageOptions["preflight"];
	/** The OS proxy setting as main resolved it (`resolveOsProxy`'s `env`): handed to every child the engine starts. */
	proxyEnv?: Record<string, string>;
	/** Run only these stages (they must lead to each other: `["preflight", "node", "git", "herdr", "pi"]`). */
	only?: readonly string[];
}

const countingFetch = (world: World, sink: string[]): Fetch => (url, init) => {
	world.requests.push(url);
	sink.push(url);
	return fetch(url, init as RequestInit);
};

/** One real engine run against the world: real downloads, the stack and recipe given, the stages of `toolStages`. */
export async function runWorld(world: World, options: RunOptions = {}): Promise<RunSummary> {
	seedDownloads(world);
	const events: EngineEvent[] = [];
	const requests: string[] = [];
	const engine = createEngine({
		emit: (event) => events.push(event),
		fetch: countingFetch(world, requests),
		layout: world.layout,
		// The process table is the stand-in of `testPlatform` (no PowerShell for the engine lock), except `listUnder`: the self-extractor's "nothing still runs
		// from the staging folder" check (T5-F005) is the real one, so a PortableGit whose post-install outlived the installer would fail the run.
		platform: { ...testPlatform(), processes: { ...testPlatform().processes, listUnder: createPlatform().processes.listUnder }, userPath: world.userPath },
		appEnv: world.appEnv,
		retryDelayMs: 1000,
		stages: (stack, recipe, platform) => toolStages(stack, recipe, platform, options.preflight ? { preflight: options.preflight } : {}).filter((stage) => options.only === undefined || options.only.includes(stage.name)),
	});
	const started = Date.now();
	await engine.handle({ type: "run", config: { root: world.root, home: world.home, platform: platformOfHost, stack: options.stack ?? realStack, secretPatterns, ...(options.recipe !== undefined ? { recipe: options.recipe } : {}), ...(options.force ? { force: true } : {}), ...(options.proxyEnv ? { proxyEnv: options.proxyEnv } : {}) } });
	const ms = Date.now() - started;
	harvestDownloads(world);
	const done = events.find((e) => e.type === "done");
	const order = events.filter((e): e is Extract<EngineEvent, { type: "stage" }> => e.type === "stage").map((e) => e.outcome.stage);
	return {
		ok: done?.type === "done" && done.ok,
		outcomes: Object.fromEntries((done?.type === "done" ? done.outcomes : []).map((o) => [o.stage, o])),
		order,
		error: events.find((e): e is Extract<EngineEvent, { type: "error" }> => e.type === "error") ?? null,
		ms,
		requests,
	};
}

export const stateOf = (world: World, name: "bootstrap" | "current"): Record<string, any> => JSON.parse(readFileSync(join(world.root, "state", `${name}.json`), "utf8")) as Record<string, any>;

/** The active versions of `state/current.json` as the constructed environment takes them. */
export function currentTools(world: World): CurrentTools {
	const versions = stateOf(world, "current").versions as Record<string, string>;
	const need = (tool: string): string => {
		const v = versions[tool];
		if (v === undefined) throw new Error(`${tool} is not active`);
		return v;
	};
	return { node: need("node"), git: need("git"), herdr: need("herdr"), ...(versions.gh ? { gh: versions.gh } : {}), ...(versions.glab ? { glab: versions.glab } : {}) };
}

/** The constructed environment of the world's active tools, as the supervisor builds it at a start. */
export function childEnvOf(world: World, optionalTools: readonly string[] = []): EnvMap {
	return buildEnv({ layout: world.layout, current: currentTools(world), appEnv: world.appEnv, optionalTools });
}

// ---- running programs --------------------------------------------------------------------------------------------------

export function run(file: string, args: readonly string[], options: { env: Readonly<Record<string, string>>; cwd?: string; stdin?: string; timeoutMs?: number }): Promise<RunResult> {
	return new Promise((resolve) => {
		const child = execFile(
			file,
			[...args],
			{ env: { ...options.env }, ...(options.cwd ? { cwd: options.cwd } : {}), timeout: options.timeoutMs ?? 120_000, windowsHide: true, maxBuffer: 64 * 1024 * 1024, encoding: "utf8" },
			(error, stdout, stderr) => {
				const e = error as (NodeJS.ErrnoException & { killed?: boolean }) | null;
				resolve({ code: e === null ? 0 : typeof e.code === "number" ? e.code : null, stdout, stderr: e !== null && typeof e.code !== "number" ? `${stderr}${e.message}` : stderr, ...(e?.killed ? { timedOut: true } : {}) });
			},
		);
		child.stdin?.on("error", () => {});
		child.stdin?.end(options.stdin);
	});
}

const comspec = (world: World): string => join(world.appEnv.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe");

/** Runs the launcher `name` of a `bin` folder as a PM's shell would find it: a script on macOS, `<name>.cmd` through cmd.exe on Windows (Node refuses to spawn a .cmd itself). */
export function launcherIn(world: World, bin: string, name: string, args: readonly string[], env: Readonly<Record<string, string>> = systemEnv(platformOfHost, world.appEnv), cwd?: string): Promise<RunResult> {
	if (!isWindows) return run(join(bin, name), args, { env, ...(cwd ? { cwd } : {}) });
	// cmd.exe takes only names the app chose, and the folder it works in reaches it as its working directory (UTF-16), so a root with CJK characters is fine.
	// With a working folder of the caller's, `bin` goes first on the PATH and cmd finds the launcher by name.
	if (cwd === undefined) return run(comspec(world), ["/d", "/c", `${name}.cmd`, ...args], { env, cwd: bin });
	const pathKey = Object.keys(env).find((k) => k.toLowerCase() === "path") ?? "PATH";
	return run(comspec(world), ["/d", "/c", `${name}.cmd`, ...args], { env: { ...env, [pathKey]: `${bin};${env[pathKey] ?? ""}` }, cwd });
}

/** Runs `tools/bin/<name>` of the world. With `cwd` on macOS the program runs there; on Windows it runs in `tools\bin`, and `args` name paths absolutely. */
export function viaLauncher(world: World, name: string, args: readonly string[], env: Readonly<Record<string, string>> = systemEnv(platformOfHost, world.appEnv), cwd?: string): Promise<RunResult> {
	return launcherIn(world, world.layout.tools.bin, name, args, env, cwd);
}

export const firstLine = (r: RunResult): string => `${r.stdout}\n${r.stderr}`.trim().split(/\r?\n/)[0] ?? "";

// ---- a Herdr server of the world's own --------------------------------------------------------------------------------

/**
 * `herdr server` of a world: its own root, config, and socket (the paths of the world's layout, all under the scratch base), started with the world's
 * constructed environment, and stopped by `herdr server stop` on that socket, then by the pid of the process this class started. It refuses to start
 * when the socket lies outside the scratch base.
 */
export class WorldHerdr {
	readonly world: World;
	readonly env: EnvMap;
	pid: number | null = null;
	#child: ChildProcess | null = null;

	constructor(world: World, optionalTools: readonly string[] = []) {
		if (!world.layout.herdrSocket.startsWith(world.base)) throw new Error(`refusing to start Herdr: ${world.layout.herdrSocket} is outside the scratch folder ${world.base}`);
		this.world = world;
		this.env = childEnvOf(world, optionalTools);
		for (const name of Object.keys(this.env)) if (/^(PI_SUBAGENT|HERDR_(ENV|PANE|WORKSPACE|TAB|SESSION))/.test(name)) throw new Error(`the world's environment carries ${name}`);
	}

	get binary(): string {
		return this.env.HERDR_BIN_PATH as string;
	}

	/** Runs a `herdr` CLI call against this server's socket. */
	cli(args: readonly string[], timeoutMs = 30_000): Promise<RunResult> {
		return run(this.binary, args, { env: this.env, timeoutMs });
	}

	async start(timeoutMs = 60_000): Promise<void> {
		const child = spawn(this.binary, ["server"], { env: this.env, stdio: "ignore", windowsHide: true });
		this.#child = child;
		this.pid = child.pid ?? null;
		child.on("error", () => {});
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			if (child.exitCode !== null) throw new Error(`herdr server exited with ${child.exitCode} before it answered`);
			const r = await this.cli(["workspace", "list"], 10_000);
			if (r.code === 0 && r.stdout.includes('"workspaces"')) return;
			await new Promise((resolve) => setTimeout(resolve, 500));
		}
		throw new Error(`herdr server did not answer within ${timeoutMs / 1000} s`);
	}

	/** Opens a workspace in `cwd` and returns its ids. */
	async open(cwd: string, label: string): Promise<{ workspace: string; pane: string }> {
		const r = await this.cli(["workspace", "create", "--cwd", cwd, "--label", label, "--no-focus"]);
		if (r.code !== 0) throw new Error(`workspace create failed: ${r.stderr || r.stdout}`);
		const parsed = JSON.parse(r.stdout) as { result: { workspace: { workspace_id: string }; root_pane: { pane_id: string } } };
		return { workspace: parsed.result.workspace.workspace_id, pane: parsed.result.root_pane.pane_id };
	}

	async close(workspace: string): Promise<void> {
		await this.cli(["workspace", "close", workspace]);
	}

	/** Types a line into a pane and presses Enter. */
	async type(pane: string, text: string): Promise<void> {
		const typed = await this.cli(["pane", "send-text", pane, text]);
		if (typed.code !== 0) throw new Error(`send-text failed: ${typed.stderr || typed.stdout}`);
		const entered = await this.cli(["pane", "send-keys", pane, "enter"]);
		if (entered.code !== 0) throw new Error(`send-keys failed: ${entered.stderr || entered.stdout}`);
	}

	/**
	 * Runs `command` in a fresh pane and returns the text it wrote to a file: the pane's shell is whatever Herdr starts. `command` must write to the
	 * file named by the first argument of `wrap`.
	 */
	async inPane(label: string, wrap: (outFile: string) => string, cwd: string, waitMs = 60_000): Promise<string> {
		const out = join(this.world.base, `pane-${label}-${Date.now()}.txt`);
		const { workspace, pane } = await this.open(cwd, label);
		try {
			// A shell needs a moment before it reads a typed line.
			await new Promise((resolve) => setTimeout(resolve, isWindows ? 4000 : 1500));
			await this.type(pane, wrap(out));
			const deadline = Date.now() + waitMs;
			while (Date.now() < deadline) {
				if (existsSync(out) && statSync(out).size > 0) {
					await new Promise((resolve) => setTimeout(resolve, 800));
					return readFileSync(out, "utf8");
				}
				await new Promise((resolve) => setTimeout(resolve, 400));
			}
			throw new Error(`the pane wrote nothing to ${out} within ${waitMs / 1000} s`);
		} finally {
			await this.close(workspace);
		}
	}

	async stop(): Promise<void> {
		await this.cli(["server", "stop"], 20_000).catch(() => {});
		const child = this.#child;
		if (child !== null && child.exitCode === null) {
			await new Promise<void>((resolve) => {
				const timer = setTimeout(() => {
					// Only the process this class started, by the handle it holds.
					child.kill();
					resolve();
				}, 10_000);
				child.once("exit", () => {
					clearTimeout(timer);
					resolve();
				});
			});
		}
		this.#child = null;
	}
}

/** Removes a file if it is there (a pane's output between uses). */
export const forget = (path: string): void => rmSync(path, { force: true });

/**
 * Plants the PM's startup file in the world's home: it puts a folder with a fake `gh` first on the PATH and exports a token. A pane that read it would run
 * the fake. The home is the world's scratch home, checked here; the author's real one is never written.
 */
export function plantShellStartupDecoy(world: World): string {
	if (!world.home.startsWith(world.base)) throw new Error(`refusing to write a startup file outside the scratch folder: ${world.home}`);
	const decoy = join(world.base, "decoy-bin");
	mkdirSync(decoy, { recursive: true });
	for (const name of ["gh", "git", "bun"]) writeFileSync(join(decoy, name), "#!/bin/sh\necho DECOY\n", { mode: 0o755 });
	writeFileSync(join(world.home, ".zshrc"), `export PATH="${decoy}:$PATH"\nexport GH_TOKEN=fake\n`);
	writeFileSync(join(world.home, ".zshenv"), `export PATH="${decoy}:$PATH"\n`);
	return decoy;
}

/** A tarball of a package with no dependencies, and a project that depends on it by path: what `bun install` takes without a registry. */
export function writeLocalProject(dir: string): void {
	mkdirSync(join(dir, "app"), { recursive: true });
	writeFileSync(join(dir, "tiny-1.0.0.tgz"), tarGz([{ name: "package/package.json", data: '{"name":"tiny","version":"1.0.0","main":"index.js"}\n' }, { name: "package/index.js", data: "module.exports = 1;\n" }]));
	writeFileSync(join(dir, "app", "package.json"), '{"name":"app","version":"1.0.0","dependencies":{"tiny":"file:../tiny-1.0.0.tgz"}}\n');
}

/** The two files a pane's zsh reads from the world's `ZDOTDIR` (the app writes both). */
export const zdotdirFiles = (world: World): string[] => [".zshenv", ".zshrc"].map((name) => join(world.layout.zdotdir, name));

// ---- a pi in RPC mode ----------------------------------------------------------------------------------------------------

export interface RpcProbe {
	/** The JSON lines pi wrote to stdout before it was stopped. */
	lines: string[];
	stderr: string;
	/** The pid of the process this probe started, which it has stopped again. */
	pid: number | null;
}

/**
 * Starts `file args` (a pi in `--mode rpc`), asks it for its state, waits for the answer, then closes its stdin and, when it has not exited within
 * `graceMs`, stops the process this call started by its pid (the whole tree on Windows). Nothing it started outlives the call.
 */
export async function rpcProbe(file: string, args: readonly string[], options: { env: Readonly<Record<string, string>>; cwd?: string; timeoutMs?: number; graceMs?: number }): Promise<RpcProbe> {
	const child = spawn(file, [...args], { env: { ...options.env }, ...(options.cwd ? { cwd: options.cwd } : {}), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
	const pid = child.pid ?? null;
	const lines: string[] = [];
	let stderr = "";
	let pending = "";
	let exited = false;
	child.on("exit", () => {
		exited = true;
	});
	child.on("error", () => {
		exited = true;
	});
	child.stdin?.on("error", () => {});
	child.stderr?.on("data", (chunk: Buffer) => {
		stderr += chunk.toString("utf8");
	});
	child.stdout?.on("data", (chunk: Buffer) => {
		pending += chunk.toString("utf8");
		const parts = pending.split(/\r?\n/);
		pending = parts.pop() ?? "";
		lines.push(...parts.filter((l) => l !== ""));
	});
	child.stdin?.write('{"id":"state","type":"get_state"}\n');
	const deadline = Date.now() + (options.timeoutMs ?? 90_000);
	while (Date.now() < deadline && !exited && !lines.some((l) => l.includes('"state"'))) await new Promise((resolve) => setTimeout(resolve, 200));
	child.stdin?.end();
	const grace = Date.now() + (options.graceMs ?? 15_000);
	while (Date.now() < grace && !exited) await new Promise((resolve) => setTimeout(resolve, 200));
	if (!exited && pid !== null) {
		if (isWindows) await run(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"), ["/T", "/F", "/PID", String(pid)], { env: {}, timeoutMs: 30_000 });
		else child.kill("SIGKILL");
		const end = Date.now() + 10_000;
		while (Date.now() < end && !exited) await new Promise((resolve) => setTimeout(resolve, 200));
	}
	return { lines, stderr, pid };
}
