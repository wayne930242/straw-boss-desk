import { homedir } from "node:os";
import { loadLayout, type AppPlatform, type Layout } from "../paths.ts";
import { execRunner } from "../platform/exec.ts";
import { createPlatform, type CommandRunner, type Platform } from "../platform/index.ts";
import { netFetch, type Fetch } from "./download.ts";
import { runGraph, sweepLeftovers, type GraphResult } from "./graph.ts";
import { Logger, Redactor, SecretRefusedError, loadSecretPatterns, MIN_SECRET_LENGTH, type RotationOptions } from "./log.ts";
import { parseStack, platformKey, type Stack } from "./stack.ts";
import { engineRecipeOf, type EngineRecipe } from "./recipe-config.ts";
import type { EnvLike } from "../env.ts";
import { runStage, type Stage, type StageOutcome } from "./stage.ts";
import { acquireEngineLock, StateStore } from "./state.ts";
import { allStages } from "./stages/index.ts";

// The bootstrap engine (spec: Decisions, Where the engine runs). It runs as an Electron `utilityProcess`, so a long install never blocks the window
// and an engine crash is a resumable event, not an app crash. Everything it does lives in plain modules (`graph.ts`, `stage.ts`, `state.ts`,
// `download.ts`, `extract.ts`, `log.ts`) that Node tests drive without Electron; this file wires them to the messages main sends and receives.

// ---- the messages ----------------------------------------------------------------------------------------------------

/**
 * Main to engine. `secret` may arrive at any time, before `run` included: the engine keeps every value it holds for the life of its process and
 * seeds the redactor of each run from them. One `run` at a time: a second one while a run is active is answered with an `EngineBusyError`.
 */
export type EngineRequest =
	| { type: "run"; config: EngineConfig }
	| { type: "secret"; op: "add" | "remove"; value: string }
	| { type: "cancel" };

export interface EngineConfig {
	root: string;
	home?: string;
	platform?: AppPlatform;
	/** The parsed `stack/active.json` (or a candidate while an update is tried). */
	stack: unknown;
	/** The parsed `recipe/secret-patterns.json`. */
	secretPatterns: unknown;
	/** Ignore `detect` and install everything (Repair). */
	force?: boolean;
	/**
	 * The active recipe, validated by main with `validateRecipe(text, recipeValidationOptions(stack))`: its forges decide which code-host CLIs are
	 * installed, its `tools` which optional tools (bun). Absent means no recipe yet (the welcome screen's preflight): no forge and no optional tool.
	 */
	recipe?: unknown;
	/** The variables main resolved from the OS proxy setting (`resolveOsProxy`), handed to every child the engine starts. */
	proxyEnv?: Record<string, string>;
}

/** Engine to main. */
export type EngineEvent =
	| { type: "ready" }
	| { type: "stage-start"; stage: string }
	| { type: "stage"; outcome: StageOutcome }
	| { type: "done"; ok: boolean; outcomes: StageOutcome[] }
	/** `name` is the error's class name (`EngineBusyError`, `EngineLockedError`, `SecretRefusedError`, `StackError`, ...), so main can tell a refused request from a failed run. */
	| { type: "error"; name: string; message: string; details: string[] };

export interface ParentPort {
	postMessage(message: EngineEvent): void;
	on(event: "message", listener: (event: { data: EngineRequest }) => void): void;
}

// ---- the engine ------------------------------------------------------------------------------------------------------

export interface EngineDeps {
	emit(event: EngineEvent): void;
	/** Default: Electron's `net.fetch`. */
	fetch?: Fetch;
	/** Default: the real processes of this OS. */
	platform?: Platform;
	run?: CommandRunner;
	/** Default: the stages of `./stages`. */
	stages?: (stack: Stack, recipe: EngineRecipe, platform: AppPlatform) => Stage[];
	/** The environment the constructed child environment starts from. Default: the engine process's own. */
	appEnv?: EnvLike;
	/** Default: the layout recorded in `state/layout.json`, computed once. */
	layout?: Layout;
	retryDelayMs?: number;
	/** A download that receives no bytes for this long fails as a network failure (default 60 s). */
	downloadIdleMs?: number;
	log?: RotationOptions;
}

/** A second `run` arrived while one was active. */
export class EngineBusyError extends Error {
	constructor() {
		super("a run is already active in this engine");
		this.name = "EngineBusyError";
	}
}

export interface Engine {
	handle(request: EngineRequest): Promise<void>;
}

export function createEngine(deps: EngineDeps): Engine {
	/** Every value main registered and has not dropped. It outlives each run; a run's redactor starts from it. */
	const secrets = new Set<string>();
	/** The redactor of the run in progress, or null between runs. */
	let redactor: Redactor | null = null;
	let abort: AbortController | null = null;
	let running = false;

	const applySecret = (op: "add" | "remove", value: string): void => {
		if (op === "add") {
			if (value.length < MIN_SECRET_LENGTH) throw new SecretRefusedError(value.length);
			secrets.add(value);
			redactor?.add(value);
		} else {
			secrets.delete(value);
			redactor?.remove(value);
		}
	};

	const seeded = (patterns: readonly RegExp[]): Redactor => {
		const fresh = new Redactor(patterns);
		for (const value of secrets) fresh.add(value);
		return fresh;
	};

	/** Text that main receives outside the logger's reach: the registered values and the GUI URL are masked even when no run has patterns yet. */
	const safe = (text: string): string => (redactor ?? seeded([])).redact(text);

	const emitError = (thrown: unknown, details: string[] = []): void => {
		const error = thrown instanceof Error ? thrown : new Error(String(thrown));
		deps.emit({ type: "error", name: error.name, message: safe(error.message), details });
	};

	async function run(config: EngineConfig): Promise<void> {
		const platformName: AppPlatform = config.platform ?? (process.platform === "win32" ? "win32" : "darwin");
		const live = seeded(loadSecretPatterns(config.secretPatterns));
		redactor = live;

		const layout = deps.layout ?? loadLayout({ root: config.root, home: config.home ?? homedir(), platform: platformName });
		const logger = new Logger({ dir: layout.logs, redactor: live, ...deps.log });
		const platform = deps.platform ?? createPlatform();
		const lock = await acquireEngineLock(layout, platform.processes);
		abort = new AbortController();
		const signal = abort.signal;
		try {
			const stack = parseStack(config.stack);
			const key = platformKey(process.platform, process.arch);
			const state = new StateStore(layout, { onQuarantine: (file, moved) => logger.event({ event: "state-quarantined", file, moved }) });
			const recipe = engineRecipeOf(config.recipe, stack);
			const stages = (deps.stages ?? allStages)(stack, recipe, layout.platform);
			logger.event({ event: "run-begin", stages: stages.map((s) => s.name), generation: stack.generation, force: config.force === true, forges: recipe.forges.map((f) => `${f.kind}:${f.host}`), tools: recipe.tools });
			const swept = sweepLeftovers(layout);
			if (swept.removed.length > 0 || swept.restored.length > 0 || swept.kept.length > 0) logger.event({ event: "swept", removed: swept.removed, restored: swept.restored, kept: swept.kept });

			const retryDelayMs = deps.retryDelayMs ?? 5000;
			const result: GraphResult = await runGraph({
				stages,
				signal,
				run: (stage) =>
					runStage(stage, {
						layout,
						stack,
						key,
						state,
						platform,
						run: deps.run ?? execRunner(process.env, signal),
						fetch: deps.fetch ?? netFetch(),
						signal,
						logFor: (name) => logger.stage(name),
						redact: (text) => logger.redactor.redact(text),
						retryDelayMs,
						recipe,
						appEnv: deps.appEnv ?? process.env,
						...(config.proxyEnv ? { proxy: { env: config.proxyEnv, log: [] } } : {}),
						...(deps.downloadIdleMs !== undefined ? { downloadIdleMs: deps.downloadIdleMs } : {}),
						...(config.force ? { force: true } : {}),
					}),
				onStart: (stage) => deps.emit({ type: "stage-start", stage: stage.name }),
				onOutcome: (outcome) => deps.emit({ type: "stage", outcome }),
			});
			logger.event({ event: "run-end", ok: result.ok });
			logger.flush();
			deps.emit({ type: "done", ok: result.ok, outcomes: result.outcomes });
		} catch (error) {
			logger.event({ event: "run-error", detail: (error as Error).message });
			logger.flush();
			emitError(error, logger.tail(40));
		} finally {
			abort = null;
			lock.release();
		}
	}

	return {
		async handle(request) {
			switch (request.type) {
				case "secret":
					try {
						applySecret(request.op, request.value);
					} catch (error) {
						emitError(error);
					}
					return;
				case "cancel":
					abort?.abort();
					return;
				case "run":
					// Checked and set before the first await: two requests in the same tick cannot both pass.
					if (running) {
						emitError(new EngineBusyError());
						return;
					}
					running = true;
					try {
						await run(request.config);
					} catch (error) {
						// Before the logger exists (a bad config, a held lock): the message is all main gets, with the registered values masked.
						emitError(error);
					} finally {
						redactor = null;
						running = false;
					}
					return;
			}
		},
	};
}

// ---- the utilityProcess entry ----------------------------------------------------------------------------------------

// SAFETY: `process.parentPort` exists only inside an Electron utilityProcess, and Node's types do not declare it.
const utilityParentPort = (): ParentPort | undefined => (process as unknown as { parentPort?: ParentPort }).parentPort;

/** Wires an engine to the parent port of a `utilityProcess`. Does nothing when this module is imported by a plain Node process. */
export function startEngine(port: ParentPort | undefined = utilityParentPort()): Engine | null {
	if (port === undefined) return null;
	const engine = createEngine({ emit: (event) => port.postMessage(event) });
	port.on("message", (event) => {
		// `handle` reports its own failures as `error` events; this is only the last guard against an unhandled rejection that would end the process.
		engine.handle(event.data).catch((error: unknown) => {
			port.postMessage({ type: "error", name: error instanceof Error ? error.name : "Error", message: error instanceof Error ? error.message : String(error), details: [] });
		});
	});
	port.postMessage({ type: "ready" });
	return engine;
}

startEngine();
