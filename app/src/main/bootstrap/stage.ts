import { existsSync, mkdirSync } from "node:fs";
import { join, posix, win32 } from "node:path";
import { isInside, type Layout } from "../paths.ts";
import type { CommandRunner, Platform, RunOptions, RunResult } from "../platform/index.ts";
import { classifyError, RETRIED_ONCE, StageError, type FailureCategory, type FailureParams } from "./errors.ts";
import { downloadVerified, type Downloaded, type Fetch } from "./download.ts";
import { extractArchive, type Extracted } from "./extract.ts";
import { removeTree, renameRetry, sha256File } from "./fsutil.ts";
import type { StageLog } from "./log.ts";
import type { Asset, PlatformKey, Stack } from "./stack.ts";
import type { StageRecord, StateStore } from "./state.ts";

// The stage contract and the one function that runs a stage through it (spec: Bootstrap engine, Stage contract).
//
//   detect    reads only; returns evidence when the stage's pinned version is active and its recorded file hashes still match.
//   install   writes only into a staging folder.
//   verify    runs the staged result and returns evidence.
//   activate  makes the result the active one: a rename of the staging folder, then a write of `state/current.json` by rename.

export type Lane = "download" | "npm";

/** What a stage found or produced. `files` are the executables whose SHA-256 the engine records at activation and `detect` checks later. */
export interface Evidence {
	/** One line for the log and the UI: a `--version` line, a registry integrity, the versions a file names. */
	text: string;
	version: string;
	/** Versions of other tools this output names (`tools/<tool>/<version>` folders): a change of one fails `detect`. */
	dependsOn?: Record<string, string>;
	/** Installed files to hash, as `fileKey` writes them: relative to the data root with `/` separators, or `agent:` and a path relative to the agent folder. */
	files?: string[];
}

export interface Stage {
	name: string;
	needs: readonly string[];
	/** `download` stages run three at a time, `npm` stages one at a time; the rest are unlimited. */
	lane?: Lane;
	/** The version this stage is about to install, for the record that marks it running. */
	plannedVersion?(ctx: StageContext): string;
	detect(ctx: StageContext): Promise<Evidence | null>;
	install(ctx: StageContext): Promise<void>;
	verify(ctx: StageContext): Promise<Evidence>;
	activate(ctx: StageContext, evidence: Evidence): Promise<void>;
}

export interface StageContext {
	readonly stage: string;
	readonly layout: Layout;
	readonly stack: Stack;
	readonly key: PlatformKey;
	readonly state: StateStore;
	readonly platform: Platform;
	readonly signal: AbortSignal;
	/** The stage's record when it began; null on a first install. */
	readonly record: StageRecord | null;
	readonly log: StageLog;
	/** Non-fatal file system trouble (a locked old folder that stayed behind), reported in the result line as `fsErrors`. */
	readonly fsErrors: string[];
	/** Runs a program by absolute path; the command and its output go to the stage's log. */
	exec(file: string, args: readonly string[], options?: RunOptions): Promise<RunResult>;
	/** Downloads and verifies a pinned asset into `tools/downloads`. */
	download(tool: string, asset: Asset): Promise<Downloaded>;
	extract(archive: string, dest: string, stripComponents?: number): Promise<Extracted>;
	/** An empty folder at `path`: whatever was there is deleted first. It is removed again if the stage fails. */
	freshStaging(path: string): string;
	/** The active versions of `tools`, or throws when one is not active. */
	versionsOf(tools: readonly string[]): Record<string, string>;
}

export type StageStatusResult = "installed" | "skipped-verified" | "failed" | "blocked";

export interface StageFailure {
	category: FailureCategory;
	/** The plain sentence for the PM (English; the catalog carries zh-TW from `category` and `params`). */
	sentence: string;
	params: FailureParams;
	/** The technical detail, redacted when it is logged. */
	detail: string;
}

export interface StageOutcome {
	stage: string;
	status: StageStatusResult;
	ms: number;
	evidence?: string;
	version?: string;
	attempts: number;
	fsErrors: string[];
	failure?: StageFailure;
	/** For `blocked`: the stage that did not complete. */
	blockedBy?: string;
}

export interface RunDeps {
	layout: Layout;
	stack: Stack;
	key: PlatformKey;
	state: StateStore;
	platform: Platform;
	run: CommandRunner;
	fetch: Fetch;
	signal: AbortSignal;
	/** The log of a stage, by name. */
	logFor(stage: string): StageLog;
	/** The redactor of the log: failure details and evidence kept in `state/bootstrap.json` or sent to the UI pass through it too. */
	redact(text: string): string;
	/** Delay before the one automatic retry of network, registry, and locked failures (spec: 5 s). */
	retryDelayMs: number;
	/** A download that receives no bytes for this long fails as a network failure (default 60 s). */
	downloadIdleMs?: number;
	now?: () => Date;
	/** Ignore `detect` and install everything (a repair). */
	force?: boolean;
}

/** `tools/<tool>/<version>`, the folder a binary stage activates. */
export const installDir = (layout: Layout, tool: string, version: string): string => join(layout.tools.root, tool, version);

/** A path that should lie under the data root or the agent folder does not. Raised before anything is renamed into place. */
export class OutsideRootError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "OutsideRootError";
	}
}

const pathModule = (layout: Layout): typeof posix => (layout.platform === "win32" ? win32 : posix);
const AGENT_BASE = "agent:";

const relativeUnder = (base: string, absolute: string, P: typeof posix): string | null => {
	if (!isInside(base, absolute, P)) return null;
	const rel = P.relative(base, absolute);
	return rel === "" ? null : rel.split(P.sep).join("/");
};

/** A path relative to the data root with `/` separators. Throws `OutsideRootError` for a path that is not under the root: `relative()` would give a `..` or absolute path there. */
export function relativeToRoot(layout: Layout, absolute: string): string {
	const key = relativeUnder(layout.root, absolute, pathModule(layout));
	if (key === null) throw new OutsideRootError(`${absolute} is not a file under the data root ${layout.root}`);
	return key;
}

/**
 * How hashes and evidence name an installed file: relative to the data root (`tools/node/24.1.0/node.exe`), or, for a file in the agent folder (fd and
 * rg install into `<agent>/bin`, and on Windows the agent folder can lie outside the root), `agent:bin/fd.exe`. Any other path throws `OutsideRootError`.
 */
export function fileKey(layout: Layout, absolute: string): string {
	const P = pathModule(layout);
	const inRoot = relativeUnder(layout.root, absolute, P);
	if (inRoot !== null) return inRoot;
	const inAgent = relativeUnder(layout.agent, absolute, P);
	if (inAgent !== null) return `${AGENT_BASE}${inAgent}`;
	throw new OutsideRootError(`${absolute} is under neither the data root ${layout.root} nor the agent folder ${layout.agent}`);
}

/** The absolute path of a key. A key that is absolute, has a `..` or empty segment, a backslash, a drive letter, or a NUL byte throws `OutsideRootError`. */
export function pathOfKey(layout: Layout, key: string): string {
	const agent = key.startsWith(AGENT_BASE);
	const rel = agent ? key.slice(AGENT_BASE.length) : key;
	const segments = rel.split("/");
	if (rel === "" || /[\\\0:]/.test(rel) || posix.isAbsolute(rel) || segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
		throw new OutsideRootError(`evidence names a file outside the data root: ${key}`);
	}
	return pathModule(layout).join(agent ? layout.agent : layout.root, ...segments);
}

async function hashFiles(layout: Layout, files: readonly string[]): Promise<Record<string, string>> {
	const hashes: Record<string, string> = {};
	for (const key of files) hashes[key] = await sha256File(pathOfKey(layout, key));
	return hashes;
}

/**
 * The shared part of every stage's `detect` (followup R-F009): the stage's record says it finished at `version`, the tool is active at that
 * version, every other tool version the output names is unchanged, and each recorded file still has the SHA-256 it had at activation. Returns the
 * recorded evidence, or null with the reason logged.
 */
export async function detectFromRecord(
	ctx: StageContext,
	expected: { version: string; tool?: string; dependsOn?: Record<string, string> },
): Promise<Evidence | null> {
	const why = (reason: string): null => {
		ctx.log.event({ event: "detect-failed", reason });
		return null;
	};
	const rec = ctx.record;
	if (rec === null) return why("no record");
	if (rec.status !== "ok") return why(`record is ${rec.status}`);
	if (rec.version !== expected.version) return why(`record is for ${rec.version}, the pin is ${expected.version}`);
	if (expected.tool !== undefined && ctx.state.version(expected.tool) !== expected.version) {
		return why(`${expected.tool} is ${ctx.state.version(expected.tool) ?? "not active"}, the pin is ${expected.version}`);
	}
	const want = expected.dependsOn ?? {};
	const keys = new Set([...Object.keys(want), ...Object.keys(rec.dependsOn)]);
	for (const tool of keys) {
		if (want[tool] !== rec.dependsOn[tool] || ctx.state.version(tool) !== want[tool]) {
			return why(`${tool} changed: recorded ${rec.dependsOn[tool] ?? "none"}, now ${ctx.state.version(tool) ?? "none"}`);
		}
	}
	for (const [key, hash] of Object.entries(rec.hashes)) {
		let got: string;
		try {
			got = await sha256File(pathOfKey(ctx.layout, key));
		} catch (error) {
			return why(`${key} cannot be read: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`);
		}
		if (got !== hash) return why(`${key} no longer has its recorded SHA-256`);
	}
	return { text: rec.evidence, version: rec.version, dependsOn: rec.dependsOn, files: Object.keys(rec.hashes) };
}

/**
 * `activate` for a stage whose output is the folder `tools/<tool>/<version>`: renames the staging folder into place (an older folder of the same
 * version, such as a corrupted one, is moved aside first and deleted after), then makes the version the active one in `current.json`.
 */
export async function activateDir(ctx: StageContext, spec: { tool: string; version: string; staging: string }): Promise<void> {
	const final = installDir(ctx.layout, spec.tool, spec.version);
	const aside = `${final}.replaced`;
	removeTree(aside);
	const hadOld = existsSync(final);
	if (hadOld) renameRetry(final, aside);
	try {
		renameRetry(spec.staging, final);
	} catch (error) {
		if (hadOld) renameRetry(aside, final);
		throw error;
	}
	await ctx.state.setVersion(spec.tool, spec.version);
	if (hadOld) {
		try {
			removeTree(aside);
		} catch (error) {
			ctx.fsErrors.push(`${aside}: ${(error as Error).message}`);
		}
	}
}

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
	new Promise((resolve) => {
		if (signal.aborted) return resolve();
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = (): void => {
			clearTimeout(timer);
			resolve();
		};
		signal.addEventListener("abort", onAbort, { once: true });
	});

function makeContext(stage: Stage, deps: RunDeps, record: StageRecord | null, staging: Set<string>, fsErrors: string[]): StageContext {
	const log = deps.logFor(stage.name);
	return {
		stage: stage.name,
		layout: deps.layout,
		stack: deps.stack,
		key: deps.key,
		state: deps.state,
		platform: deps.platform,
		signal: deps.signal,
		record,
		log,
		fsErrors,
		async exec(file, args, options) {
			const started = Date.now();
			log.event({ event: "exec", file, args: [...args] });
			const result = await deps.run(file, args, options);
			log.raw(`$ ${file} ${args.join(" ")}\n${result.stdout}${result.stdout.endsWith("\n") || result.stdout === "" ? "" : "\n"}${result.stderr}\n`);
			log.flush();
			log.event({ event: "exec-result", file, code: result.code, timedOut: result.timedOut === true, ms: Date.now() - started });
			return result;
		},
		download(tool, asset) {
			return downloadVerified({
				fetch: deps.fetch,
				asset,
				tool,
				dir: deps.layout.tools.downloads,
				signal: deps.signal,
				...(deps.downloadIdleMs !== undefined ? { idleTimeoutMs: deps.downloadIdleMs } : {}),
				log: (event) => log.event(event),
			});
		},
		extract(archive, dest, stripComponents) {
			return extractArchive({
				archive,
				dest,
				locate: deps.platform.locate,
				run: deps.run,
				...(stripComponents ? { stripComponents } : {}),
			});
		},
		freshStaging(path) {
			staging.add(path);
			removeTree(path);
			mkdirSync(path, { recursive: true });
			return path;
		},
		versionsOf(tools) {
			const out: Record<string, string> = {};
			for (const tool of tools) {
				const version = deps.state.version(tool);
				if (version === null) throw new StageError("other", { stage: stage.name }, `${tool} is not active, and ${stage.name} needs it`);
				out[tool] = version;
			}
			return out;
		},
	};
}

function cleanup(staging: Set<string>, fsErrors: string[]): void {
	for (const path of staging) {
		try {
			removeTree(path);
		} catch (error) {
			fsErrors.push(`${path}: ${(error as Error).message}`);
		}
	}
	staging.clear();
}

/**
 * Runs one stage: `detect`, and when that finds nothing, `install`, `verify`, `activate`, with one automatic retry of the categories that
 * allow it. A failed attempt removes the stage's staging folders and leaves every active version as it was. Never throws for a stage's own failure.
 */
export async function runStage(stage: Stage, deps: RunDeps): Promise<StageOutcome> {
	const now = deps.now ?? (() => new Date());
	const started = Date.now();
	const record = deps.state.record(stage.name);
	const staging = new Set<string>();
	const fsErrors: string[] = [];
	const ctx = makeContext(stage, deps, record, staging, fsErrors);
	const log = ctx.log;
	const done = (outcome: Omit<StageOutcome, "stage" | "ms" | "fsErrors">): StageOutcome => {
		const full: StageOutcome = { stage: stage.name, ms: Date.now() - started, fsErrors, ...outcome };
		if (full.evidence !== undefined) full.evidence = deps.redact(full.evidence);
		log.event({
			event: "result",
			status: full.status,
			ms: full.ms,
			attempts: full.attempts,
			evidence: full.evidence ?? null,
			version: full.version ?? null,
			fsErrors,
			...(full.failure ? { category: full.failure.category, sentence: full.failure.sentence, detail: full.failure.detail } : {}),
		});
		log.flush();
		return full;
	};

	log.event({ event: "start" });
	if (!deps.force) {
		let found: Evidence | null = null;
		try {
			found = await stage.detect(ctx);
		} catch (error) {
			log.event({ event: "detect-error", detail: (error as Error).message });
		}
		if (found !== null) return done({ status: "skipped-verified", attempts: 0, evidence: found.text, version: found.version });
	}

	let planned: string | null = null;
	try {
		planned = stage.plannedVersion?.(ctx) ?? null;
	} catch {
		planned = null;
	}
	await deps.state.setRecord(stage.name, {
		status: "running",
		version: planned ?? record?.version ?? "",
		evidence: record?.evidence ?? "",
		at: now().toISOString(),
		hashes: record?.hashes ?? {},
		dependsOn: record?.dependsOn ?? {},
	});

	for (let attempt = 1; ; attempt++) {
		try {
			log.event({ event: "install-begin", attempt });
			await stage.install(ctx);
			if (deps.signal.aborted) throw new StageError("other", { stage: stage.name }, "cancelled");
			const evidence = await stage.verify(ctx);
			log.event({ event: "verified", evidence: evidence.text });
			// A key outside the data root is refused here, before anything is renamed into place.
			for (const key of evidence.files ?? []) pathOfKey(deps.layout, key);
			await stage.activate(ctx, evidence);
			const hashes = await hashFiles(deps.layout, evidence.files ?? []);
			cleanup(staging, fsErrors);
			await deps.state.setRecord(stage.name, {
				status: "ok",
				version: evidence.version,
				evidence: deps.redact(evidence.text),
				at: now().toISOString(),
				hashes,
				dependsOn: evidence.dependsOn ?? {},
			});
			return done({ status: "installed", attempts: attempt, evidence: evidence.text, version: evidence.version });
		} catch (thrown) {
			cleanup(staging, fsErrors);
			const error = deps.signal.aborted ? new StageError("other", { stage: stage.name }, "cancelled") : classifyError(thrown, stage.name);
			if (!deps.signal.aborted && attempt === 1 && RETRIED_ONCE[error.category]) {
				log.event({ event: "retry", category: error.category, detail: error.message, afterMs: deps.retryDelayMs });
				await sleep(deps.retryDelayMs, deps.signal);
				continue;
			}
			const detail = deps.redact(error.message);
			const note = { category: error.category, version: planned, message: detail, at: now().toISOString() };
			// A record that finished before keeps its version, hashes, and evidence: the old version is still the active one.
			const keep = record !== null && record.status === "ok";
			await deps.state.setRecord(stage.name, keep ? { ...record, lastFailure: note } : { status: "failed", version: planned ?? "", evidence: "", at: note.at, hashes: {}, dependsOn: {}, lastFailure: note });
			return done({
				status: "failed",
				attempts: attempt,
				failure: { category: error.category, sentence: error.sentence, params: error.params, detail },
			});
		}
	}
}
