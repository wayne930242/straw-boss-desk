import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { Layout } from "../paths.ts";
import { removeTree } from "./fsutil.ts";
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

const LEFTOVER = /\.(staging|replaced)$/;

/**
 * Deletes what a run that was killed mid-stage leaves: `tools/<tool>/<version>.staging`, a `.replaced` folder that was moved aside, and unfinished
 * `.part` downloads. Called when an engine run starts, under the engine lock, so no other run can own them. Returns the paths it removed.
 */
export function sweepLeftovers(layout: Layout): string[] {
	const removed: string[] = [];
	const sweep = (dir: string, match: (name: string) => boolean): void => {
		let names: string[];
		try {
			names = readdirSync(dir);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
		for (const name of names) {
			if (!match(name)) continue;
			const path = join(dir, name);
			removeTree(path);
			removed.push(path);
		}
	};
	const tools = layout.tools.root;
	sweep(tools, (n) => LEFTOVER.test(n));
	let toolDirs: string[] = [];
	try {
		toolDirs = readdirSync(tools);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	for (const name of toolDirs) {
		if (name === "downloads") continue;
		sweep(join(tools, name), (n) => LEFTOVER.test(n));
	}
	sweep(layout.tools.downloads, (n) => n.endsWith(".part"));
	return removed;
}
