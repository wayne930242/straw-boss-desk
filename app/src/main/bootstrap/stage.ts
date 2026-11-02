import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, posix, win32 } from "node:path";
import { buildEnv, systemEnv, type EnvLike, type EnvMap, type OsProxy } from "../env.ts";
import { isInside, type CurrentTools, type Layout } from "../paths.ts";
import type { CommandRunner, Platform, RunOptions, RunResult } from "../platform/index.ts";
import { classifyError, RETRIED_ONCE, StageError, type FailureCategory, type FailureParams } from "./errors.ts";
import { downloadVerified, type Downloaded, type Fetch } from "./download.ts";
import { extractArchive, extractSelfExtractor, type Extracted } from "./extract.ts";
import { asideName, dropAside, freeAside, REAL_FS, removeTree, sha256File, type FsOps } from "./fsutil.ts";
import type { StageLog } from "./log.ts";
import type { EngineRecipe } from "./recipe-config.ts";
import type { Asset, PlatformKey, Stack } from "./stack.ts";
import type { StageRecord, StateStore, StageWarning } from "./state.ts";

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
	/**
	 * Where each of `files` is now, when it is not yet at its final place: the final key mapped to the absolute path of the staged copy. The engine
	 * hashes the staged copy before `activate` renames anything and records the hash under the final key (T4-F010 b), so a file that cannot be read
	 * fails the stage while the old version is still the active one. A key without an entry is hashed where it is.
	 */
	stagedFiles?: Record<string, string>;
	/** Things the PM should know that do not fail the stage (an unreachable recipe forge host); kept in the stage's record in `state/bootstrap.json`. */
	warnings?: StageWarning[];
}

export interface Stage {
	name: string;
	needs: readonly string[];
	/** `download` stages run three at a time, `npm` stages one at a time; the rest are unlimited. */
	lane?: Lane;
	/** Write the stage's record (status `ok`, with its evidence and warnings) when `detect` finds evidence too: for a stage that checks the machine on every run. */
	recordDetect?: boolean;
	/** No automatic retry of a network, registry, or locked failure: the check itself waited long enough (the preflight's reachability). */
	noRetry?: boolean;
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
	/** The active recipe's forges and optional tool names (empty lists when there is no recipe yet). */
	readonly recipe: EngineRecipe;
	/** The engine's `fetch` (Electron's `net.fetch`), for the preflight's reachability checks. */
	readonly fetch: Fetch;
	/** The environment children are built from, and the OS proxy variables main resolved for this run. */
	readonly appEnv: EnvLike;
	readonly proxy: OsProxy | undefined;
	readonly log: StageLog;
	/** Non-fatal file system trouble (a locked old folder that stayed behind), reported in the result line as `fsErrors`. */
	readonly fsErrors: string[];
	/**
	 * Called by a stage right before it changes a place that has no staging copy (npm's prefix under the agent folder). A failure after that cannot promise
	 * that the old install is still the active one, so the stage's record says `failed` instead of keeping the old `ok` (T7-F003).
	 */
	markInPlace(): void;
	/**
	 * Runs a program by absolute path; the command and its output go to the stage's log. The child gets `options.env` and nothing of the app's own
	 * environment; without it, only the system essentials (`systemEnv`).
	 */
	exec(file: string, args: readonly string[], options?: RunOptions): Promise<RunResult>;
	/** The constructed environment of the active tool versions (spec: Environment), for a stage that runs the app's tools as a PM's shell would. Throws when node, git, or herdr is not active. */
	childEnv(extra?: Readonly<Record<string, string>>): EnvMap;
	/** Downloads and verifies a pinned asset into `tools/downloads`. */
	download(tool: string, asset: Asset): Promise<Downloaded>;
	extract(archive: string, dest: string, stripComponents?: number): Promise<Extracted>;
	/** Runs a self-extracting installer (`.7z.exe`) on its verified bytes into `dest`; the same link and special-file walk as `extract` follows. */
	extractSelfExtractor(installer: string, sha256: string, dest: string): Promise<Extracted>;
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
	/** What the stage found that does not fail it (**Network**, **A private code host**). */
	warnings?: StageWarning[];
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
	/** The active recipe's forges and optional tools. */
	recipe: EngineRecipe;
	/** The environment the constructed child environment starts from (the engine process's own). */
	appEnv: EnvLike;
	/** The OS proxy variables main resolved before this run; they go to every child. */
	proxy?: OsProxy;
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

/**
 * SHA-256 of each file in `evidence.files`, keyed by the final key. A file that is still in a staging place (`evidence.stagedFiles`) is read there:
 * this runs before `activate`, so a file that cannot be read fails the stage while the old version is still the active one (T4-F010 b).
 */
async function hashFiles(layout: Layout, evidence: Evidence): Promise<Record<string, string>> {
	const hashes: Record<string, string> = {};
	for (const key of evidence.files ?? []) {
		const final = pathOfKey(layout, key);
		const staged = evidence.stagedFiles?.[key];
		if (staged !== undefined) {
			// The staged copy must lie under the data root or the agent folder, like every final file.
			fileKey(layout, staged);
			hashes[key] = await sha256File(staged);
		} else {
			hashes[key] = await sha256File(final);
		}
	}
	for (const key of Object.keys(evidence.stagedFiles ?? {})) {
		if (!(evidence.files ?? []).includes(key)) throw new OutsideRootError(`evidence stages ${key}, which it does not list in its files`);
	}
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
export async function activateDir(ctx: StageContext, spec: { tool: string; version: string; staging: string }, ops: FsOps = REAL_FS): Promise<void> {
	const final = installDir(ctx.layout, spec.tool, spec.version);
	const aside = freeAside(final, ops, (path, error) => ctx.fsErrors.push(`${path}: ${error.message}`));
	const hadOld = existsSync(final);
	if (hadOld) ops.renameRetry(final, aside);
	try {
		ops.renameRetry(spec.staging, final);
	} catch (error) {
		if (hadOld) ops.renameRetry(aside, final);
		throw error;
	}
	await ctx.state.setVersion(spec.tool, spec.version);
	if (hadOld) {
		try {
			dropAside(ops, aside);
		} catch (error) {
			ctx.fsErrors.push(`${aside}: ${(error as Error).message}`);
		}
	}
}

/**
 * `activate` for a stage whose output is a set of single files that replace files already in place (`fd-rg` into `<agent>/bin`, a launcher set into
 * `tools/bin`): each target that exists is moved aside to `<target>.replaced`, then the staged file is renamed to the target. If any step fails, the
 * files already replaced are put back, so the set is replaced whole or not at all; what a kill leaves behind, `sweepLeftovers` puts back or deletes.
 * `remove` lists targets that must be gone afterwards (a launcher for a tool the recipe dropped): they are moved aside with the rest and deleted last.
 */
export function activateFiles(ctx: StageContext, pairs: ReadonlyArray<{ from: string; to: string }>, remove: readonly string[] = [], ops: FsOps = REAL_FS): void {
	const done: Array<{ from: string; to: string; aside: string | null }> = [];
	const gone: Array<{ target: string; aside: string }> = [];
	const held = (path: string, error: Error): void => {
		ctx.fsErrors.push(`${path}: ${error.message}`);
	};
	try {
		for (const { from, to } of pairs) {
			mkdirSync(dirname(to), { recursive: true });
			const had = existsSync(to);
			// A leftover copy that a running program holds (Windows) stays, and the next free name is used (T5-F004).
			const aside = had ? freeAside(to, ops, held) : asideName(to, 1);
			if (had) ops.renameRetry(to, aside);
			try {
				ops.renameRetry(from, to);
			} catch (error) {
				if (had) ops.renameRetry(aside, to);
				throw error;
			}
			done.push({ from, to, aside: had ? aside : null });
		}
		for (const target of remove) {
			if (!existsSync(target)) continue;
			const aside = freeAside(target, ops, held);
			ops.renameRetry(target, aside);
			gone.push({ target, aside });
		}
	} catch (error) {
		for (const g of gone.toReversed()) ops.renameRetry(g.aside, g.target);
		for (const d of done.toReversed()) {
			ops.removeTree(d.to);
			if (d.aside !== null) ops.renameRetry(d.aside, d.to);
		}
		throw error;
	}
	for (const aside of [...done.map((d) => d.aside), ...gone.map((g) => g.aside)]) {
		if (aside === null) continue;
		try {
			dropAside(ops, aside);
		} catch (error) {
			held(aside, error as Error);
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

function makeContext(stage: Stage, deps: RunDeps, record: StageRecord | null, staging: Set<string>, fsErrors: string[], inPlace: { touched: boolean }): StageContext {
	const log = deps.logFor(stage.name);
	/** The scrubbed environment of the programs that unpack a download (`tar`, a self-extractor): the system essentials and nothing of the app's own (T5-F005). */
	const unpackEnv = systemEnv(deps.layout.platform, deps.appEnv);
	/**
	 * Runs `tar` and the self-extractor through the stage log: the command and its exit code, and the output of a failure or of anything but a listing
	 * (a listing of a Node archive is thousands of lines). The programs get no environment but `unpackEnv`.
	 */
	const unpackRun: CommandRunner = async (file, args, options) => {
		const started = Date.now();
		log.event({ event: "exec", file, args: [...args] });
		const result = await deps.run(file, args, { ...options, env: unpackEnv, replaceEnv: true });
		if (result.code !== 0 || args[0] !== "-tf") log.raw(`$ ${file} ${args.join(" ")}\n${result.stdout}${result.stdout.endsWith("\n") || result.stdout === "" ? "" : "\n"}${result.stderr}\n`);
		log.flush();
		log.event({ event: "exec-result", file, code: result.code, timedOut: result.timedOut === true, ms: Date.now() - started });
		return result;
	};
	return {
		stage: stage.name,
		layout: deps.layout,
		stack: deps.stack,
		key: deps.key,
		state: deps.state,
		platform: deps.platform,
		signal: deps.signal,
		record,
		recipe: deps.recipe,
		fetch: deps.fetch,
		appEnv: deps.appEnv,
		proxy: deps.proxy,
		log,
		fsErrors,
		markInPlace() {
			inPlace.touched = true;
		},
		async exec(file, args, options) {
			const started = Date.now();
			log.event({ event: "exec", file, args: [...args] });
			// The child never inherits the engine's own environment: what the stage gives it, or the system essentials.
			const result = await deps.run(file, args, { ...options, env: options?.env ?? systemEnv(deps.layout.platform, deps.appEnv), replaceEnv: true });
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
		childEnv(extra) {
			const need = (tool: string): string => {
				const version = deps.state.version(tool);
				if (version === null) throw new StageError("other", { stage: stage.name }, `${tool} is not active, and ${stage.name} needs it`);
				return version;
			};
			const current: CurrentTools = { node: need("node"), git: need("git"), herdr: need("herdr") };
			const gh = deps.state.version("gh");
			const glab = deps.state.version("glab");
			if (gh !== null) current.gh = gh;
			if (glab !== null) current.glab = glab;
			return {
				...buildEnv({ layout: deps.layout, current, appEnv: deps.appEnv, optionalTools: deps.recipe.tools, ...(deps.proxy ? { proxy: deps.proxy } : {}) }),
				...extra,
			};
		},
		extractSelfExtractor(installer, sha256, dest) {
			return extractSelfExtractor({ installer, sha256, dest, run: unpackRun, env: unpackEnv, processes: deps.platform.processes });
		},
		extract(archive, dest, stripComponents) {
			return extractArchive({
				archive,
				dest,
				locate: deps.platform.locate,
				run: unpackRun,
				env: unpackEnv,
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
	const inPlace = { touched: false };
	const ctx = makeContext(stage, deps, record, staging, fsErrors, inPlace);
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
		if (found !== null) {
			if (stage.recordDetect) {
				await deps.state.setRecord(stage.name, {
					status: "ok",
					version: found.version,
					evidence: deps.redact(found.text),
					at: now().toISOString(),
					hashes: record?.hashes ?? {},
					dependsOn: found.dependsOn ?? {},
					...(found.warnings !== undefined && found.warnings.length > 0 ? { warnings: found.warnings } : {}),
				});
			}
			return done({ status: "skipped-verified", attempts: 0, evidence: found.text, version: found.version, ...(found.warnings ? { warnings: found.warnings } : {}) });
		}
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
		// A block from the last failure stays until a run of this stage succeeds: a kill in the middle of this attempt must not lift it.
		...(record?.startBlock ? { startBlock: record.startBlock } : {}),
	});

	for (let attempt = 1; ; attempt++) {
		try {
			log.event({ event: "install-begin", attempt });
			await stage.install(ctx);
			if (deps.signal.aborted) throw new StageError("other", { stage: stage.name }, "cancelled");
			const evidence = await stage.verify(ctx);
			log.event({ event: "verified", evidence: evidence.text });
			// A key outside the data root is refused here, and the files are hashed where they are now (the staged copies), before anything is renamed
			// into place: a file that cannot be read fails the stage while the old version is still the active one (T4-F010 b).
			const hashes = await hashFiles(deps.layout, evidence);
			await stage.activate(ctx, evidence);
			cleanup(staging, fsErrors);
			await deps.state.setRecord(stage.name, {
				status: "ok",
				version: evidence.version,
				evidence: deps.redact(evidence.text),
				at: now().toISOString(),
				hashes,
				dependsOn: evidence.dependsOn ?? {},
				...(evidence.warnings !== undefined && evidence.warnings.length > 0 ? { warnings: evidence.warnings } : {}),
			});
			return done({ status: "installed", attempts: attempt, evidence: evidence.text, version: evidence.version, ...(evidence.warnings ? { warnings: evidence.warnings } : {}) });
		} catch (thrown) {
			cleanup(staging, fsErrors);
			const error = deps.signal.aborted ? new StageError("other", { stage: stage.name }, "cancelled") : classifyError(thrown, stage.name);
			if (!deps.signal.aborted && attempt === 1 && !stage.noRetry && RETRIED_ONCE[error.category]) {
				log.event({ event: "retry", category: error.category, detail: error.message, afterMs: deps.retryDelayMs });
				await sleep(deps.retryDelayMs, deps.signal);
				continue;
			}
			const detail = deps.redact(error.message);
			const note = { category: error.category, version: planned, message: detail, at: now().toISOString() };
			// A record that finished before keeps its version, hashes, and evidence: the old version is still the active one. Not so for a stage that had
			// already changed a place without a staging copy (npm's prefix): the old install may be gone or altered, so the record says `failed` (T7-F003).
			const keep = record !== null && record.status === "ok" && !inPlace.touched;
			// A package left loadable by this failure, or by an earlier one that no run has cleared yet, keeps the start blocked.
			const startBlock = error.startBlock ?? record?.startBlock;
			await deps.state.setRecord(
				stage.name,
				keep
					? { ...record, lastFailure: note, ...(startBlock ? { startBlock } : {}) }
					: { status: "failed", version: planned ?? "", evidence: "", at: note.at, hashes: {}, dependsOn: {}, lastFailure: note, ...(startBlock ? { startBlock } : {}) },
			);
			return done({
				status: "failed",
				attempts: attempt,
				failure: { category: error.category, sentence: error.sentence, params: error.params, detail },
			});
		}
	}
}
