import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { layoutFromRecord, type AppPlatform, type Layout } from "../../src/main/paths.ts";
import { createPlatform, type Platform } from "../../src/main/platform/index.ts";
import { archiveStage } from "../../src/main/bootstrap/archive-stage.ts";
import { createEngine, type EngineDeps, type EngineEvent } from "../../src/main/bootstrap/engine.ts";
import { StageError } from "../../src/main/bootstrap/errors.ts";
import { sha256Hex } from "./hash.ts";
import { platformKey, type PlatformKey, type Stack } from "../../src/main/bootstrap/stack.ts";
import type { Stage, StageOutcome } from "../../src/main/bootstrap/stage.ts";
import { tarGz, zip } from "./archives.ts";
import type { FixtureServer } from "./fixture-server.ts";

// Test code shared by the engine tests and the child process they kill: a layout under a scratch root, a stack whose assets point at the local
// fixture server, and stages built from `archiveStage` that count their installs in a file.

export const currentKey = (): PlatformKey => platformKey(process.platform, process.arch);

/** A scratch directory outside the repository and the real home; the root inside it has a space and CJK characters, as the spec's CI root does. */
export function scratchRoot(prefix = "sbd-eng-"): { base: string; root: string } {
	const base = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
	const root = join(base, "root 測試");
	mkdirSync(root, { recursive: true });
	return { base, root };
}

/** The layout of `root` without the socket-length rule, which depends on the runner's temporary folder and is task 3's to test. */
export function testLayout(root: string): Layout {
	const platform: AppPlatform = process.platform === "win32" ? "win32" : "darwin";
	return layoutFromRecord({
		schema: 1,
		platform,
		root,
		realRoot: root,
		home: root,
		id: "00000000",
		agentDir: join(root, "agent"),
		configHome: join(root, "config"),
		fallbackDir: null,
		herdrSocket: join(root, "config", "herdr", "herdr.sock"),
		herdrSocketBytes: 0,
		sidecarSocketBytes: null,
		reasons: [],
	});
}

/** The real platform, except that process inspection answers from a table, so a test does not start PowerShell for the engine lock. */
export function testPlatform(): Platform {
	return {
		...createPlatform(),
		processes: {
			inspect: async (pids) => pids.map((pid) => ({ pid, startTime: pid === process.pid ? "this-process" : null, executable: null })),
			listUnder: async () => [],
			kill: () => false,
		},
	};
}

export interface ToolPackage {
	version: string;
	/** The `VERSION` file inside the archive; a different value than `version` makes the stage's verify fail. */
	inside?: string;
	/** The executable's bytes. */
	binary?: string;
}

/** An archive for a tool: `<tool>-<version>/bin/<tool>` and `<tool>-<version>/VERSION`. zip on Windows, tar.gz on macOS, as the real pins are. */
export function toolArchive(tool: string, pkg: ToolPackage): { bytes: Buffer; file: string } {
	const top = `${tool}-${pkg.version}`;
	const binary = pkg.binary ?? `binary of ${tool} ${pkg.version}\n`;
	const version = pkg.inside ?? pkg.version;
	if (process.platform === "win32") {
		return { bytes: zip([{ name: `${top}/bin/${tool}.exe`, data: binary }, { name: `${top}/VERSION`, data: version }]), file: `${top}.zip` };
	}
	return {
		bytes: tarGz([
			{ name: `${top}/`, type: "dir" },
			{ name: `${top}/bin/`, type: "dir" },
			{ name: `${top}/bin/${tool}`, data: binary, mode: 0o755 },
			{ name: `${top}/VERSION`, data: version },
		]),
		file: `${top}.tar.gz`,
	};
}

export const exeName = (tool: string): string => (process.platform === "win32" ? `bin/${tool}.exe` : `bin/${tool}`);

/** Serves `tool`'s archive and returns the stack asset that pins it. `pinOf` overrides the SHA-256 (a wrong pin). */
export function publish(server: FixtureServer, tool: string, pkg: ToolPackage, pinOf?: string): { version: string; url: string; sha256: string; file: string; path: string } {
	const { bytes, file } = toolArchive(tool, pkg);
	const path = `/${file}`;
	return { version: pkg.version, url: server.serve(path, bytes), sha256: pinOf ?? sha256Hex(bytes), file, path };
}

export function makeStack(tools: Record<string, { version: string; url: string; sha256: string; file: string }>): Stack {
	const key = currentKey();
	return {
		schema: 1,
		generation: 1,
		minShell: "0.0.1",
		tools: Object.fromEntries(Object.entries(tools).map(([tool, asset]) => [tool, { assets: { [key]: asset } }])),
		npmGlobal: [],
		profile: { name: "p", version: "0.0.1", integrity: "sha512-x" },
		piPackages: [],
	};
}

export interface TestStageOptions {
	name?: string;
	needs?: readonly string[];
	dependsOn?: readonly string[];
	/** Appended to once per `install`, so a test counts how often a stage ran. */
	installsLog?: string;
	/** Called inside `install` after the staging folder exists. */
	onInstall?: () => Promise<void> | void;
}

/** A stage that installs `tool` from the stack, checks the `VERSION` file inside the staged folder, and records its executable's hash. */
export function toolStage(tool: string, options: TestStageOptions = {}): Stage {
	const name = options.name ?? tool;
	const stage = archiveStage({
		name,
		needs: options.needs ?? [],
		tool,
		kind: "archive",
		stripComponents: 1,
		executables: [exeName(tool)],
		...(options.dependsOn ? { dependsOn: options.dependsOn } : {}),
		async check(_ctx, dir, asset) {
			const inside = readFileSync(join(dir, "VERSION"), "utf8").trim();
			if (inside !== asset.version) throw new StageError("other", { stage: name }, `${tool} says it is ${inside}, the pin is ${asset.version}`);
			return `${tool} ${inside}`;
		},
	});
	return {
		...stage,
		async install(ctx) {
			if (options.installsLog) appendFileSync(options.installsLog, `${name}\n`);
			await options.onInstall?.();
			await stage.install(ctx);
		},
	};
}

/** The stage names `installsLog` recorded, in order. */
export function installsOf(installsLog: string): string[] {
	try {
		return readFileSync(installsLog, "utf8").split("\n").filter(Boolean);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

// ---- running the engine ----------------------------------------------------------------------------------------------


export const secretPatterns: unknown = JSON.parse(readFileSync(new URL("../../../recipe/secret-patterns.json", import.meta.url), "utf8"));

export interface EngineRun {
	events: EngineEvent[];
	ok: boolean;
	outcomes: Record<string, StageOutcome>;
	/** The `error` event, when the run could not start or broke. */
	error: Extract<EngineEvent, { type: "error" }> | null;
}

/** One engine run against `root`, with the fixture server's `fetch`, no retry delay, and the process table of `testPlatform`. */
export async function runEngine(root: string, stack: Stack, stages: Stage[], extra: Partial<EngineDeps> = {}, secrets: string[] = []): Promise<EngineRun> {
	const events: EngineEvent[] = [];
	const engine = createEngine({
		emit: (event) => events.push(event),
		fetch: (url, init) => fetch(url, init),
		layout: testLayout(root),
		platform: testPlatform(),
		retryDelayMs: 0,
		stages: () => stages,
		...extra,
	});
	for (const value of secrets) await engine.handle({ type: "secret", op: "add", value });
	await engine.handle({ type: "run", config: { root, stack, secretPatterns } });
	const done = events.find((e) => e.type === "done");
	const error = events.find((e): e is Extract<EngineEvent, { type: "error" }> => e.type === "error") ?? null;
	return {
		events,
		ok: done?.type === "done" && done.ok,
		outcomes: Object.fromEntries((done?.type === "done" ? done.outcomes : []).map((o) => [o.stage, o])),
		error,
	};
}

/** Every path under `root` whose name marks unfinished work: a staging folder, a folder moved aside, an unfinished download, a temporary file. */
export function leftovers(root: string): string[] {
	const found: string[] = [];
	const walk = (dir: string): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			if (/\.(staging|replaced|part|tmp)$/.test(entry.name)) found.push(full);
			else if (entry.isDirectory()) walk(full);
		}
	};
	walk(root);
	return found;
}
