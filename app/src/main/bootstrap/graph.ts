import { readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Layout } from "../paths.ts";
import { removeAside, removeTree, renameRetry } from "./fsutil.ts";
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
/** `<x>.replaced`, or `<x>.replaced-<n>` when an earlier leftover of the same name could not be deleted (`freeAside`). */
const ASIDE = /^(.*)\.replaced(?:-(\d+))?$/;

export interface SweepResult {
	/** Paths deleted: staging folders, files, and stale `.replaced` copies. */
	removed: string[];
	/** Paths put back: a `<v>.replaced` whose `<v>` was missing (T4-F010), so `current.json` names a folder that exists again. */
	restored: string[];
	/** Paths that could not be deleted (on Windows, a copy of a running executable): they stay, are logged, and the next sweep tries again (T5-F004). */
	kept: Array<{ path: string; error: string }>;
}

export interface SweepOptions {
	/** Deletes a file or folder tree; a test passes one that throws. Default: `removeTree`. */
	remove?: (path: string) => void;
	/** Deletes a leftover `.replaced` copy. Default: `remove` when given, else a single attempt without retries (R5-F002: a copy a running program holds will not go however long it waits). */
	removeAside?: (path: string) => void;
	/** Moves a leftover back into place; a test passes one that throws. Default: `renameRetry`. */
	rename?: (from: string, to: string) => void;
}

/**
 * Cleans up after a run that was killed mid-stage, under the engine lock (no other run can own what it finds):
 *
 * - `tools/<tool>/<version>.staging`, `tools/<name>.staging`, and the `.staging` files of `tools/bin` are deleted;
 * - `<x>.replaced` is the previous copy that `activateDir` and `activateFiles` move aside before the new one is renamed into place. When `<x>` is
 *   there, the new copy won and the old one is deleted; when `<x>` is missing the run was killed between the two renames, `current.json` still
 *   names `<x>`, and the old copy is moved back (T4-F010 a). When several asides exist for one `<x>` (`<x>.replaced-2`), the highest number is the newest
 *   (`freeAside` never reuses a lower number while a higher one is held, R5-F001) and is the one moved back; a move back that fails (a folder aside a
 *   running program holds) is kept and reported, never thrown, so one held copy cannot fail every run;
 * - a leftover copy is deleted with one attempt, a staging folder with the retrying removal (R5-F002);
 * - a deletion that fails (Windows: the old copy of a running `bun.exe` can be renamed but not deleted) never stops the sweep: the path is kept,
 *   reported in `kept`, and tried again by the next sweep (T5-F004);
 * - the same rules cover the private `gitconfig`, which sits in the root: `gitconfig.staging` is deleted, and `gitconfig.replaced` is moved back
 *   when `gitconfig` is missing (T5-F006);
 * - unfinished `.part` downloads are deleted.
 *
 * It looks under `tools/`, one level down, in the agent's `bin` folder (where `fd-rg` replaces files), and at the `gitconfig` files of the root.
 */
export function sweepLeftovers(layout: Layout, options: SweepOptions = {}): SweepResult {
	const remove = options.remove ?? removeTree;
	const removeLeftover = options.removeAside ?? options.remove ?? removeAside;
	const rename = options.rename ?? renameRetry;
	const result: SweepResult = { removed: [], restored: [], kept: [] };
	const drop = (path: string, how: (path: string) => void = remove): void => {
		try {
			how(path);
			result.removed.push(path);
		} catch (error) {
			result.kept.push({ path, error: (error as Error).message });
		}
	};
	const sweep = (dir: string, only: (name: string) => boolean = () => true): void => {
		let names: string[];
		try {
			names = readdirSync(dir);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
		const present = new Set(names);
		const asides = new Map<string, Array<{ name: string; n: number }>>();
		for (const name of names) {
			if (!only(name)) continue;
			if (STAGING.test(name)) {
				drop(join(dir, name));
				continue;
			}
			const m = ASIDE.exec(name);
			if (m === null) continue;
			const original = m[1] as string;
			asides.set(original, [...(asides.get(original) ?? []), { name, n: m[2] === undefined ? 1 : Number(m[2]) }]);
		}
		for (const [original, list] of asides) {
			list.sort((a, b) => b.n - a.n);
			let rest = list;
			if (!present.has(original)) {
				const newest = list[0] as { name: string };
				try {
					rename(join(dir, newest.name), join(dir, original));
					result.restored.push(join(dir, newest.name));
					rest = list.slice(1);
				} catch (error) {
					// A folder a running program holds cannot be moved back; it stays where it is, the older copies are not deleted either, and the next sweep tries again.
					result.kept.push({ path: join(dir, newest.name), error: (error as Error).message });
					rest = [];
				}
			}
			for (const { name } of rest) drop(join(dir, name), removeLeftover);
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
	// The private gitconfig is edited through a staging copy beside it, and replaced by moving the old file aside first.
	const gitconfigName = basename(layout.gitconfig);
	const ownsGitconfig = (name: string): boolean => name === `${gitconfigName}.staging` || ASIDE.exec(name)?.[1] === gitconfigName;
	sweep(dirname(layout.gitconfig), ownsGitconfig);
	try {
		for (const name of readdirSync(layout.tools.downloads)) {
			if (!name.endsWith(".part")) continue;
			drop(join(layout.tools.downloads, name));
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	return result;
}
