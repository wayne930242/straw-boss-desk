import { packageListing, unlistPackages } from "../../profile/team-profile.ts";
import { packageDroppedSentence, StageError } from "../errors.ts";
import type { NpmRun } from "../npm.ts";
import type { RunResult } from "../../platform/index.ts";
import { agentPackageDir, piRemove, piSource } from "../pi-cli.ts";
import { isPackageName } from "../stack.ts";
import type { Stage, StageContext } from "../stage.ts";

// The `pkg-prune` stage (spec: Stages; Build note: generation 15). A stack can stop listing a pi package (generation 15 swaps pi-herdr-doc-review for pi-better-show), and nothing else
// takes such a package out: its `pkg:<name>` stage is no longer planned, so the package would stay in `settings.json` beside its replacement and pi would load both.
//
// What the desk installed is what its own records say: a `pkg:<name>` record in `state/bootstrap.json` is written only by that stage, with the version it installed or was installing.
// A record whose name no stage of this run installs (not a package of the stack, not the profile, not a recipe package) is a dropped package. The stage removes exactly the listing
// the record names, `npm:<name>@<version>`, and then forgets the record. A recipe package (`team-pkg:<name>`), the profile, and anything a PM or another tool listed have no `pkg:` record
// and are never looked at; a PM who moved the package to another version has replaced the desk's listing, so the desk's is absent and their copy stays.

export const PRUNE_STAGE = "pkg-prune";
/** Bumped when what the stage's record means changes. */
export const PRUNE_FORMAT = "format 1";
const PKG_PREFIX = "pkg:";

export interface DroppedPackage {
	/** The record's stage name, `pkg:<name>`. */
	stage: string;
	name: string;
	/** The version the record names: the one the desk installed, or was installing when the run was cut. */
	version: string;
}

/** The names a stage of this run installs under `<agent>/npm`: the stack's packages, the profile, and the recipe's packages. None of them is ever pruned. */
function plannedNames(ctx: StageContext): Set<string> {
	return new Set([...ctx.stack.piPackages.map((p) => p.name), ctx.stack.profile.name, ...(ctx.recipe.team?.packages ?? []).map((p) => p.name)]);
}

/** The `pkg:<name>` records whose package no stage of this run installs, in the order the state file holds them. */
export function droppedPackages(ctx: StageContext): DroppedPackage[] {
	const planned = plannedNames(ctx);
	const dropped: DroppedPackage[] = [];
	for (const [stage, record] of Object.entries(ctx.state.records())) {
		if (!stage.startsWith(PKG_PREFIX)) continue;
		const name = stage.slice(PKG_PREFIX.length);
		if (planned.has(name)) continue;
		dropped.push({ stage, name, version: record.version });
	}
	return dropped;
}

const firstLine = (text: string): string => text.trim().split(/\r?\n/)[0] ?? "";

/**
 * Takes one dropped package out. `removed`: `pi remove` did it. `unlisted`: `pi remove` failed and the listing was taken out of `settings.json` directly, so pi loads none of it and its
 * files stay. `absent`: the desk's listing was not there (the PM removed it, or lists another version), so nothing was touched. `listed`: both ways failed and pi may still load it.
 */
async function removeDropped(ctx: StageContext, pkg: DroppedPackage, npm?: NpmRun): Promise<{ how: "removed" | "unlisted" | "absent" } | { how: "listed"; detail: string }> {
	// A record whose name or version could not have come from a pin names nothing pi can be asked about; it is forgotten.
	if (!isPackageName(pkg.name) || pkg.version === "") return { how: "absent" };
	if (packageListing(ctx.layout.agent, pkg.name, pkg.version) === "absent") return { how: "absent" };
	// `pi remove` may not even run (the wait for the tools of an earlier run gives up as `locked`): that is a failed removal like any other, and the unlisting below still applies,
	// because it edits only `settings.json` (pbsswap-F001).
	let removed: RunResult & { threw?: string };
	try {
		removed = await piRemove(ctx, pkg, npm);
	} catch (error) {
		removed = { code: null, timedOut: false, stderr: "", stdout: "", threw: (error as Error).message };
	}
	if (removed.threw === undefined && !removed.timedOut && removed.code === 0 && packageListing(ctx.layout.agent, pkg.name, pkg.version) === "absent") return { how: "removed" };
	const why = removed.threw !== undefined ? `pi remove did not run: ${firstLine(removed.threw)}` : `pi remove exit ${removed.code}${removed.timedOut ? " (time limit)" : ""}: ${firstLine(`${removed.stderr}\n${removed.stdout}`)}`;
	ctx.log.event({ event: "prune-remove-failed", package: pkg.name, detail: why });
	let unlistError: string | null = null;
	try {
		unlistPackages({ agentDir: ctx.layout.agent, packages: [pkg] });
	} catch (error) {
		unlistError = (error as Error).message;
	}
	const listing = packageListing(ctx.layout.agent, pkg.name, pkg.version);
	ctx.log.event({ event: "unlisted", package: pkg.name, listing, ...(unlistError === null ? {} : { error: unlistError }) });
	if (listing === "absent") return { how: "unlisted" };
	const still = listing === "skills-only" ? "still listed with its extensions off, so its skills, prompts, and themes still load" : listing === "listed" ? "still listed, so pi loads it with its extensions" : "not readable, so what pi loads is unknown";
	return { how: "listed", detail: `${removed.threw !== undefined ? "pi remove did not run" : `pi remove failed (exit ${removed.code})`}, and its listing in settings.json is ${still}${unlistError === null ? "" : ` (${unlistError})`}` };
}

/**
 * `pkg-prune`: removes each pi package an earlier stack installed and this run's plan no longer lists. It runs after every `pkg:<name>` stage, so a new package is installed and checked
 * before the one it replaces goes, and a run that fails at a download leaves the old package as it was; it still runs inside the engine run, before anything starts pi.
 */
export function prunePackagesStage(needs: readonly string[], options: { npm?: NpmRun } = {}): Stage {
	/** What the last `install` of this run did, for `verify`'s evidence. */
	let done: string[] = [];
	return {
		name: PRUNE_STAGE,
		needs,
		lane: "npm",
		// A run that finds nothing to remove writes the record too: a start block of an earlier failure ends when the package is gone or a stack lists it again.
		recordDetect: true,
		plannedVersion: () => PRUNE_FORMAT,
		async detect(ctx) {
			const dropped = droppedPackages(ctx);
			if (dropped.length > 0) {
				ctx.log.event({ event: "detect-failed", reason: `installed for an earlier stack and no longer listed: ${dropped.map((d) => `${d.name}@${d.version}`).join(", ")}` });
				return null;
			}
			return { text: "nothing to remove", version: PRUNE_FORMAT };
		},
		async install(ctx) {
			done = [];
			const stuck: Array<{ name: string; detail: string }> = [];
			for (const pkg of droppedPackages(ctx)) {
				const result = await removeDropped(ctx, pkg, options.npm);
				if (result.how === "listed") {
					stuck.push({ name: pkg.name, detail: `${pkg.name}@${pkg.version}: ${result.detail}` });
					continue;
				}
				ctx.log.event({ event: "pruned", package: pkg.name, version: pkg.version, how: result.how });
				// The record goes only now: a run cut before this line finds the record again and finishes the removal.
				await ctx.state.dropRecord(pkg.stage);
				if (result.how === "removed") done.push(`${pkg.name}@${pkg.version}`);
				else if (result.how === "unlisted") done.push(`${pkg.name}@${pkg.version} (off pi's package list; its files stay under ${agentPackageDir(ctx.layout, pkg.name)})`);
			}
			const first = stuck[0];
			if (first === undefined) return;
			// pi would load a package the stack dropped beside its replacement: the start is held until a later run of this stage has taken it out (the pattern of `removeAfterFailure`).
			throw new StageError(
				"other",
				{ stage: ctx.stage, reason: "package-dropped", name: first.name },
				`${stuck.map((s) => s.detail).join("; ")}; the stack no longer lists ${stuck.map((s) => s.name).join(", ")}, and the app does not start pi until a later run of ${ctx.stage} has removed ${stuck.length === 1 ? "it" : "them"}`,
				{ startBlock: { kind: "package-may-load", package: first.name, sentence: packageDroppedSentence(first.name) } },
			);
		},
		async verify(ctx) {
			const left = droppedPackages(ctx).filter((d) => isPackageName(d.name) && d.version !== "" && packageListing(ctx.layout.agent, d.name, d.version) !== "absent");
			if (left.length > 0) throw new StageError("other", { stage: ctx.stage }, `still listed in settings.json after the removal: ${left.map((d) => piSource(d)).join(", ")}`);
			return { text: done.length > 0 ? `removed ${done.join(", ")}` : "nothing to remove", version: PRUNE_FORMAT };
		},
		async activate() {
			// pi and the direct edit changed settings.json and `<agent>/npm` in place.
		},
	};
}
