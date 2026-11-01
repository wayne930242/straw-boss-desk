import { homedir } from "node:os";
import { loadLayout, type AppPlatform, type Layout } from "../paths.ts";
import { execRunner } from "../platform/exec.ts";
import { createPlatform, type CommandRunner, type Platform } from "../platform/index.ts";
import { netFetch, type Fetch } from "./download.ts";
import { runGraph, sweepLeftovers, type GraphResult } from "./graph.ts";
import { Logger, Redactor, loadSecretPatterns, type RotationOptions } from "./log.ts";
import { parseStack, platformKey, type Stack } from "./stack.ts";
import { runStage, type Stage, type StageOutcome } from "./stage.ts";
import { acquireEngineLock, StateStore } from "./state.ts";
import { allStages } from "./stages/index.ts";

// The bootstrap engine (spec: Decisions, Where the engine runs). It runs as an Electron `utilityProcess`, so a long install never blocks the window
// and an engine crash is a resumable event, not an app crash. Everything it does lives in plain modules (`graph.ts`, `stage.ts`, `state.ts`,
// `download.ts`, `extract.ts`, `log.ts`) that Node tests drive without Electron; this file wires them to the messages main sends and receives.

// ---- the messages ----------------------------------------------------------------------------------------------------

/** Main to engine. `secret` may arrive before `run`; it is held and registered with the redactor once that exists. */
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
}

/** Engine to main. */
export type EngineEvent =
	| { type: "ready" }
	| { type: "stage-start"; stage: string }
	| { type: "stage"; outcome: StageOutcome }
	| { type: "done"; ok: boolean; outcomes: StageOutcome[] }
	| { type: "error"; message: string; details: string[] };

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
	stages?: (stack: Stack) => Stage[];
	/** Default: the layout recorded in `state/layout.json`, computed once. */
	layout?: Layout;
	retryDelayMs?: number;
	log?: RotationOptions;
}

export interface Engine {
	handle(request: EngineRequest): Promise<void>;
}

export function createEngine(deps: EngineDeps): Engine {
	const heldSecrets: { op: "add" | "remove"; value: string }[] = [];
	let redactor: Redactor | null = null;
	let abort: AbortController | null = null;

	const applySecret = (op: "add" | "remove", value: string): void => {
		if (redactor === null) heldSecrets.push({ op, value });
		else if (op === "add") redactor.add(value);
		else redactor.remove(value);
	};

	async function run(config: EngineConfig): Promise<void> {
		const platformName: AppPlatform = config.platform ?? (process.platform === "win32" ? "win32" : "darwin");
		redactor = new Redactor(loadSecretPatterns(config.secretPatterns));
		for (const held of heldSecrets.splice(0)) applySecret(held.op, held.value);

		const layout = deps.layout ?? loadLayout({ root: config.root, home: config.home ?? homedir(), platform: platformName });
		const logger = new Logger({ dir: layout.logs, redactor, ...deps.log });
		const platform = deps.platform ?? createPlatform();
		const lock = await acquireEngineLock(layout, platform.processes);
		abort = new AbortController();
		const signal = abort.signal;
		try {
			const stack = parseStack(config.stack);
			const key = platformKey(process.platform, process.arch);
			const state = new StateStore(layout, { onQuarantine: (file, moved) => logger.event({ event: "state-quarantined", file, moved }) });
			const stages = (deps.stages ?? allStages)(stack);
			logger.event({ event: "run-begin", stages: stages.map((s) => s.name), generation: stack.generation, force: config.force === true });
			const removed = sweepLeftovers(layout);
			if (removed.length > 0) logger.event({ event: "swept", removed });

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
						run: deps.run ?? execRunner(),
						fetch: deps.fetch ?? netFetch(),
						signal,
						logFor: (name) => logger.stage(name),
						redact: (text) => logger.redactor.redact(text),
						retryDelayMs,
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
			deps.emit({ type: "error", message: (error as Error).message, details: logger.tail(40) });
		} finally {
			abort = null;
			lock.release();
		}
	}

	return {
		async handle(request) {
			switch (request.type) {
				case "secret":
					applySecret(request.op, request.value);
					return;
				case "cancel":
					abort?.abort();
					return;
				case "run":
					try {
						await run(request.config);
					} catch (error) {
						// Before the logger exists (a bad config, a held lock): the message is all main gets, and it holds no secret.
						deps.emit({ type: "error", message: (error as Error).message, details: [] });
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
		void engine.handle(event.data);
	});
	port.postMessage({ type: "ready" });
	return engine;
}

startEngine();
