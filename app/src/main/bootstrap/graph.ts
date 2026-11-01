import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Layout } from "../paths.ts";
import { removeTree, renameRetry } from "./fsutil.ts";
import type { Lane, Stage, StageOutcome } from "./stage.ts";

// The stage graph (spec: Bootstrap engine): stages whose `needs` are done run; independent downloads three at a time, npm steps one at a time.

export class GraphError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "GraphError";
	}
}

export const DEFAULT_LIMITS: Readonly<Record<Lane, number>> = { download: 3, npm: 1 };

/** The stages in an order that respects `needs`, or throws `GraphError` for a duplicate name, an unknown need, or a cycle. Nothing has run yet. */
export function orderStages(stages: readonly Stage[]): Stage[] {
	const byName = new Map<string, Stage>();
	for (const stage of stages) {
		if (byName.has(stage.name)) throw new GraphError(`stage ${stage.name} is listed twice`);
		byName.set(stage.name, stage);
	}
	for (const stage of stages) {
		for (const need of stage.needs) if (!byName.has(need)) throw new GraphError(`stage ${stage.name} needs ${need}, which is not in the graph`);
	}
	const ordered: Stage[] = [];
	const state = new Map<string, "visiting" | "done">();
	const visit = (stage: Stage, trail: string[]): void => {
		const seen = state.get(stage.name);
		if (seen === "done") return;
		if (seen === "visiting") throw new GraphError(`the stages form a cycle: ${[...trail, stage.name].join(" -> ")}`);
		state.set(stage.name, "visiting");
		for (const need of stage.needs) visit(byName.get(need) as Stage, [...trail, stage.name]);
		state.set(stage.name, "done");
		ordered.push(stage);
	};
	for (const stage of stages) visit(stage, []);
	return ordered;
}

export interface GraphResult {
	/** True when every stage ended `installed` or `skipped-verified`. */
	ok: boolean;
	/** One outcome per stage, in the order the stages were given. */
	outcomes: StageOutcome[];
}

export interface GraphOptions {
	stages: readonly Stage[];
	/** Runs one stage and returns its outcome; it must not throw for a stage's own failure. */
	run(stage: Stage): Promise<StageOutcome>;
	limits?: Partial<Record<Lane, number>>;
	signal?: AbortSignal;
	onStart?(stage: Stage): void;
	onOutcome?(outcome: StageOutcome): void;
}

const completed = (o: StageOutcome | undefined): boolean => o?.status === "installed" || o?.status === "skipped-verified";

/** Runs the graph. A failed stage blocks the stages that need it (directly or through others); independent stages still run. */
export async function runGraph(options: GraphOptions): Promise<GraphResult> {
	const ordered = orderStages(options.stages);
	const limits = { ...DEFAULT_LIMITS, ...options.limits };
	const outcomes = new Map<string, StageOutcome>();
	const running = new Map<string, Promise<void>>();
	const inLane: Record<Lane, number> = { download: 0, npm: 0 };

	const settle = (outcome: StageOutcome): void => {
		outcomes.set(outcome.stage, outcome);
		options.onOutcome?.(outcome);
	};

	const start = (stage: Stage): void => {
		const lane = stage.lane;
		if (lane) inLane[lane]++;
		options.onStart?.(stage);
		const task = options
			.run(stage)
			.then(settle)
			.finally(() => {
				if (lane) inLane[lane]--;
				running.delete(stage.name);
			});
		running.set(stage.name, task);
	};

	for (;;) {
		let progressed = false;
		for (const stage of ordered) {
			if (outcomes.has(stage.name) || running.has(stage.name)) continue;
			const notDone = stage.needs.find((n) => outcomes.has(n) && !completed(outcomes.get(n)));
			if (notDone !== undefined || options.signal?.aborted) {
				const by = notDone ?? "cancelled";
				settle({ stage: stage.name, status: "blocked", ms: 0, attempts: 0, fsErrors: [], blockedBy: by });
				progressed = true;
				continue;
			}
			if (!stage.needs.every((n) => outcomes.has(n))) continue;
			if (stage.lane && inLane[stage.lane] >= limits[stage.lane]) continue;
			start(stage);
			progressed = true;
		}
		if (outcomes.size === ordered.length) break;
		if (running.size === 0 && !progressed) throw new GraphError("the graph stalled with stages left, which cannot happen after ordering");
		if (running.size > 0 && !progressed) await Promise.race(running.values());
	}

	const list = options.stages.map((s) => outcomes.get(s.name) as StageOutcome);
	return { ok: list.every(completed), outcomes: list };
}

// ---- leftovers of an interrupted run ---------------------------------------------------------------------------------

const STAGING = /\.staging$/;
const REPLACED = /\.replaced$/;

export interface SweepResult {
	/** Paths deleted: staging folders, files, and stale `.replaced` copies. */
	removed: string[];
	/** Paths put back: a `<v>.replaced` whose `<v>` was missing (T4-F010), so `current.json` names a folder that exists again. */
	restored: string[];
}

/**
 * Cleans up after a run that was killed mid-stage, under the engine lock (no other run can own what it finds):
 *
 * - `tools/<tool>/<version>.staging`, `tools/<name>.staging`, and the `.staging` files of `tools/bin` are deleted;
 * - `<x>.replaced` is the previous copy that `activateDir` and `activateFiles` move aside before the new one is renamed into place. When `<x>` is
 *   there, the new copy won and the old one is deleted; when `<x>` is missing the run was killed between the two renames, `current.json` still
 *   names `<x>`, and the old copy is moved back (T4-F010 a);
 * - unfinished `.part` downloads are deleted.
 *
 * It looks under `tools/`, one level down, and in the agent's `bin` folder (where `fd-rg` replaces files).
 */
export function sweepLeftovers(layout: Layout): SweepResult {
	const result: SweepResult = { removed: [], restored: [] };
	const sweep = (dir: string): void => {
		let names: string[];
		try {
			names = readdirSync(dir);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
		const present = new Set(names);
		for (const name of names) {
			const path = join(dir, name);
			if (STAGING.test(name)) {
				removeTree(path);
				result.removed.push(path);
			} else if (REPLACED.test(name)) {
				const original = name.replace(REPLACED, "");
				if (present.has(original)) {
					removeTree(path);
					result.removed.push(path);
				} else {
					renameRetry(path, join(dir, original));
					result.restored.push(path);
				}
			}
		}
	};
	const tools = layout.tools.root;
	sweep(tools);
	let toolDirs: string[] = [];
	try {
		toolDirs = readdirSync(tools);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	for (const name of toolDirs) {
		if (name === "downloads") continue;
		sweep(join(tools, name));
	}
	sweep(join(layout.agent, "bin"));
	// The private gitconfig is edited through a staging copy beside it.
	const gitconfigStaging = `${layout.gitconfig}.staging`;
	if (existsSync(gitconfigStaging)) {
		removeTree(gitconfigStaging);
		result.removed.push(gitconfigStaging);
	}
	try {
		for (const name of readdirSync(layout.tools.downloads)) {
			if (!name.endsWith(".part")) continue;
			const path = join(layout.tools.downloads, name);
			removeTree(path);
			result.removed.push(path);
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	return result;
}
