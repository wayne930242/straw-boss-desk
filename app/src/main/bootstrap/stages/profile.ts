import { join } from "node:path";
import type { AppPlatform } from "../../paths.ts";
import { install, isPackageListed, loadProfile, markSkillsOnly, packageListing, unlistPackages, type InstallResult, type Notice } from "../../profile/team-profile.ts";
import { packageMayLoadSentence, StageError } from "../errors.ts";
import { assertRegistryIntegrity, type NpmRun } from "../npm.ts";
import { agentPackageDir, assertLockedIntegrity, checkLockedIntegrity, installedVersion, piInstall, piRemove, piSource } from "../pi-cli.ts";
import type { EngineRecipe } from "../recipe-config.ts";
import { StackError, type NpmPin, type Stack } from "../stack.ts";
import { detectFromRecord, fileKey, type Evidence, type Stage, type StageContext } from "../stage.ts";
import type { StageWarning } from "../state.ts";
import { CLAUDE_SDK, claudeStage } from "./claude.ts";
import { piSettingsStage } from "./pi-settings.ts";

// The profile and package stages (spec: Stages `profile`, `pkg:<name>`, `team-pkg:<name>`; team-profile section 7). All of them go through pi's package
// manager (`pi install npm:<name>@<version>`, registry integrity first, the integrity npm recorded checked after), so they run one at a time on the npm
// lane, and none has a staging folder to rename: pi and the installer write in place, each by its own atomic steps, and a failed run leaves what it was.

/** The pin of the official profile package: the stack's, or the recipe's version and integrity under the stack's package name (team-profile section 5, `profile`). */
export function profilePin(stack: Stack, recipe: EngineRecipe): NpmPin {
	const override = recipe.team?.profile;
	return { name: stack.profile.name, version: override?.version ?? stack.profile.version, integrity: override?.integrity ?? stack.profile.integrity };
}

/** What the installer kept for the PM, as warnings the settings screen shows (`state/bootstrap.json`); the catalog says the same in zh-TW from `kind` and `path`. */
export function warningsOf(notices: readonly Notice[]): StageWarning[] {
	return notices.map((n): StageWarning => {
		if (n.kind === "file-kept") {
			const why = n.reason === "edited" ? "you changed it" : "it was there before the app wrote its own";
			return { kind: "profile-file-kept", path: n.file, sentence: `Your copy of ${n.file} was kept because ${why}. The team's new version is in ${n.pending}.` };
		}
		if (n.kind === "key-kept") return { kind: "profile-key-kept", path: n.file, sentence: `Your setting ${n.key} in ${n.file} was kept; the team's value was not applied.` };
		return { kind: "profile-dropped-file-kept", path: n.file, sentence: `${n.file} is no longer part of the team profile, but you changed it, so it was left in place.` };
	});
}

const describeChanges = (result: InstallResult): string => result.changes.map((c) => `${c.kind} ${c.file}${"key" in c ? ` ${c.key}` : ""}`).join(", ");

/**
 * Whether npm's lock file still records the pin's integrity for the package on disk. `detect` reads it on every run (T7-F003): a record and the hash of
 * `package.json` say nothing about the tarball npm recorded, which a failed same-version reinstall or a later run of npm can change.
 */
function lockStillMatches(ctx: StageContext, pin: NpmPin): boolean {
	const check = checkLockedIntegrity(ctx.layout, pin);
	if (check.kind === "match") return true;
	ctx.log.event({ event: "detect-failed", reason: check.kind === "mismatch" ? `npm's lock records another integrity for ${pin.name}@${pin.version} than the pin` : `npm's lock records no integrity for ${pin.name}@${pin.version}` });
	return false;
}

/** Looks the installer up for `ctx`: the installed profile package's files, the recipe, and the agent folder. `dryRun` reads and plans only. */
function runInstaller(ctx: StageContext, pin: NpmPin, dryRun: boolean): InstallResult {
	const profile = loadProfile(agentPackageDir(ctx.layout, pin.name));
	return install({ profile, agentDir: ctx.layout.agent, recipe: ctx.recipe.team ?? null, dryRun });
}

/** Options of the profile and package stages: extra environment for pi and npm, which tests use to point them at a local registry. The product passes none. */
export interface ProfileStageOptions {
	npm?: NpmRun;
}

/** The `profile` stage: the profile package from npm, then the installer's four file states and merged keys. */
export function profileStage(options: ProfileStageOptions = {}): Stage {
	const packageFile = (ctx: StageContext, pin: NpmPin): string => fileKey(ctx.layout, join(agentPackageDir(ctx.layout, pin.name), "package.json"));
	return {
		name: "profile",
		needs: ["pi"],
		lane: "npm",
		// The notices change with the PM's edits, so a run that finds nothing to do still refreshes the stage's record.
		recordDetect: true,
		plannedVersion: (ctx) => profilePin(ctx.stack, ctx.recipe).version,
		async detect(ctx) {
			const pin = profilePin(ctx.stack, ctx.recipe);
			const found = await detectFromRecord(ctx, { version: pin.version });
			if (found === null) return null;
			const why = (reason: string): null => {
				ctx.log.event({ event: "detect-failed", reason });
				return null;
			};
			if (installedVersion(ctx.layout, pin.name) !== pin.version) return why(`${pin.name} on disk is not ${pin.version}`);
			if (!isPackageListed(ctx.layout.agent, pin.name, pin.version, false)) return why(`settings.json does not list ${piSource(pin)}`);
			if (!lockStillMatches(ctx, pin)) return null;
			let plan: InstallResult;
			try {
				plan = runInstaller(ctx, pin, true);
			} catch (error) {
				return why(`the installer cannot plan: ${(error as Error).message}`);
			}
			if (plan.changes.length > 0 || plan.manifestChanged) return why(`the agent folder differs from the profile: ${plan.changes.length > 0 ? describeChanges(plan) : "its manifest"}`);
			return { ...found, warnings: warningsOf(plan.notices) };
		},
		async install(ctx) {
			const pin = profilePin(ctx.stack, ctx.recipe);
			await assertRegistryIntegrity(ctx, pin, options.npm);
			await piInstall(ctx, pin, options.npm);
			try {
				assertLockedIntegrity(ctx, pin);
			} catch (error) {
				// The profile's skill and rules are read by every agent: a tarball that is not the pinned one comes out again before anything is copied.
				await removeAfterFailure(ctx, pin, error as Error, options.npm);
			}
			const result = runInstaller(ctx, pin, false);
			for (const change of result.changes) ctx.log.event({ event: "profile-change", ...change });
			for (const notice of result.notices) ctx.log.event({ event: "profile-notice", ...notice });
		},
		async verify(ctx) {
			const pin = profilePin(ctx.stack, ctx.recipe);
			const version = installedVersion(ctx.layout, pin.name);
			if (version !== pin.version) throw new StageError("other", { stage: "profile" }, `${pin.name} on disk is ${version ?? "missing"}, the pin is ${pin.version}`);
			if (!isPackageListed(ctx.layout.agent, pin.name, pin.version, false)) throw new StageError("other", { stage: "profile" }, `settings.json does not list ${piSource(pin)} after pi install`);
			assertLockedIntegrity(ctx, pin);
			// The installer's own check, as the kit's `verify`: a dry run finds nothing left to write.
			const plan = runInstaller(ctx, pin, true);
			if (plan.changes.length > 0 || plan.manifestChanged) {
				throw new StageError("other", { stage: "profile" }, `verify failed: managed files or keys differ from the manifest after install: ${plan.changes.length > 0 ? describeChanges(plan) : "the manifest"}`);
			}
			const team = ctx.recipe.team;
			return {
				text: `${pin.name}@${pin.version}${team ? ` + recipe ${team.id} ${team.version}` : ""}; ${plan.notices.length} kept for the PM`,
				version: pin.version,
				files: [packageFile(ctx, pin)],
				warnings: warningsOf(plan.notices),
			};
		},
		async activate() {
			// pi and the installer wrote in place; the engine records the package.json hash after this.
		},
	};
}

/** Evidence of an installed package: the pin, and `package.json`'s hash so a package changed on disk fails `detect`. */
function packageEvidence(ctx: StageContext, pin: NpmPin, skillsOnly: boolean): Evidence {
	return {
		text: `${pin.name}@${pin.version}${skillsOnly ? " (skills only: extensions [])" : ""}`,
		version: pin.version,
		files: [fileKey(ctx.layout, join(agentPackageDir(ctx.layout, pin.name), "package.json"))],
	};
}

/**
 * Checks a package after `pi install`: the pinned version on disk, listed in settings.json (skills-only for a team package), the integrity npm recorded.
 * Throws a `StageError` that says which.
 */
function assertPackage(ctx: StageContext, pin: NpmPin, skillsOnly: boolean): void {
	const version = installedVersion(ctx.layout, pin.name);
	if (version !== pin.version) throw new StageError("other", { stage: ctx.stage }, `installed version ${JSON.stringify(version)} (expected ${pin.version}); looked in ${agentPackageDir(ctx.layout, pin.name)}`);
	if (!isPackageListed(ctx.layout.agent, pin.name, pin.version, skillsOnly)) {
		throw new StageError("other", { stage: ctx.stage }, skillsOnly ? `${pin.name} is not listed in settings.json with extensions []` : `settings.json does not list ${piSource(pin)}`);
	}
	assertLockedIntegrity(ctx, pin);
}

/** A package stage's `detect`: its record, the package on disk at the pin and listed the way the stage lists it. */
async function detectPackage(ctx: StageContext, pin: NpmPin, skillsOnly: boolean): Promise<Evidence | null> {
	const found = await detectFromRecord(ctx, { version: pin.version });
	if (found === null) return null;
	if (installedVersion(ctx.layout, pin.name) !== pin.version || !isPackageListed(ctx.layout.agent, pin.name, pin.version, skillsOnly)) {
		ctx.log.event({ event: "detect-failed", reason: `${pin.name} on disk is not ${pin.version}, or settings.json does not list it${skillsOnly ? " with extensions []" : ""}` });
		return null;
	}
	if (!lockStillMatches(ctx, pin)) return null;
	return found;
}

/** `pkg:<name>`: one pi package of the stack, at its pin. */
export function piPackageStage(pin: NpmPin, needs: readonly string[], options: ProfileStageOptions = {}): Stage {
	return {
		name: `pkg:${pin.name}`,
		needs,
		lane: "npm",
		plannedVersion: () => pin.version,
		detect: (ctx) => detectPackage(ctx, pin, false),
		async install(ctx) {
			await assertRegistryIntegrity(ctx, pin, options.npm);
			await piInstall(ctx, pin, options.npm);
			try {
				assertLockedIntegrity(ctx, pin);
			} catch (error) {
				// A tarball that is not the pinned one is enabled code: take it out again before reporting.
				await removeAfterFailure(ctx, pin, error as Error, options.npm);
			}
		},
		async verify(ctx) {
			assertPackage(ctx, pin, false);
			return packageEvidence(ctx, pin, false);
		},
		async activate() {
			// pi wrote the package and its settings entry in place.
		},
	};
}

/**
 * `pi remove` after a failure that must not leave the package enabled. A removal that fails too is said plainly (RC-F001: the log never claims a rollback that
 * did not happen), and then the package's listing is taken out of settings.json directly, so pi does not load it (T7-F002). When even that does not take
 * (settings.json unwritable or unreadable), the failure carries a start block: the engine records it on the stage, and the supervisor does not start pi until a
 * later run of the stage removes the package. The message never asks the PM to edit a file.
 */
async function removeAfterFailure(ctx: StageContext, pin: NpmPin, why: Error, npm?: NpmRun): Promise<never> {
	const removed = await piRemove(ctx, pin, npm);
	if (!removed.timedOut && removed.code === 0) {
		ctx.log.event({ event: "rolled-back", package: pin.name, detail: "pi remove exit 0; not left enabled with its extensions" });
		if (why instanceof StageError) throw new StageError(why.category, why.params, `${why.message}\n(${pin.name} was removed again)`);
		throw new StageError("other", { stage: ctx.stage }, `${pin.name} could not be accepted, so it was removed again: ${why.message}`);
	}
	const line = `${removed.stderr}\n${removed.stdout}`.trim().split(/\r?\n/)[0] ?? "";
	ctx.log.event({ event: "rollback-failed", package: pin.name, detail: `pi remove exit ${removed.code}: ${line}` });
	let unlistError: string | null = null;
	try {
		unlistPackages({ agentDir: ctx.layout.agent, packages: [pin] });
	} catch (error) {
		unlistError = (error as Error).message;
	}
	const listing = packageListing(ctx.layout.agent, pin.name, pin.version);
	ctx.log.event({ event: "unlisted", package: pin.name, listing, ...(unlistError === null ? {} : { error: unlistError }) });
	if (listing === "absent") {
		const detail = `${why.message}\n(${pin.name} could not be removed with pi remove (exit ${removed.code}); it was taken off pi's package list instead, so pi loads none of it, and its files stay under ${agentPackageDir(ctx.layout, pin.name)})`;
		if (why instanceof StageError) throw new StageError(why.category, why.params, detail);
		throw new StageError("other", { stage: ctx.stage }, `${pin.name} could not be accepted: ${detail}`);
	}
	const startBlock = { kind: "package-may-load", package: pin.name, sentence: packageMayLoadSentence(pin.name) } as const;
	const still = listing === "skills-only" ? "still listed with its extensions off, so its skills, prompts, and themes still load" : listing === "listed" ? "still listed, so pi loads it with its extensions" : "not readable, so what pi loads is unknown";
	throw new StageError(
		"other",
		{ stage: ctx.stage, reason: "package-may-load", name: pin.name },
		`${pin.name} could not be accepted (${why.message}), pi remove failed (exit ${removed.code}), and its listing in settings.json is ${still}${unlistError === null ? "" : ` (${unlistError})`}; the app does not start pi until a later run of ${ctx.stage} has removed it`,
		{ startBlock },
	);
}

/** `team-pkg:<name>`: one package of the recipe, listed skills-only; a package that cannot be listed that way is removed again. */
export function teamPackageStage(pin: NpmPin, needs: readonly string[], options: ProfileStageOptions = {}): Stage {
	return {
		name: `team-pkg:${pin.name}`,
		needs,
		lane: "npm",
		plannedVersion: () => pin.version,
		detect: (ctx) => detectPackage(ctx, pin, true),
		async install(ctx) {
			await assertRegistryIntegrity(ctx, pin, options.npm);
			await piInstall(ctx, pin, options.npm);
			// `pi install` lists the package with every resource type on, and its install scripts have run. A recipe package must never stay enabled with its
			// extensions (team-profile section 5), so it is narrowed to skills-only first, before anything that can fail: whatever fails next, the entry
			// that is left (a failed removal included) loads no extension. Then the lock check, and a package that cannot be accepted is taken out again.
			try {
				markSkillsOnly({ agentDir: ctx.layout.agent, packages: [pin] });
				assertLockedIntegrity(ctx, pin);
			} catch (error) {
				await removeAfterFailure(ctx, pin, error as Error, options.npm);
			}
		},
		async verify(ctx) {
			assertPackage(ctx, pin, true);
			return packageEvidence(ctx, pin, true);
		},
		async activate() {
			// pi wrote the package, and the installer listed it skills-only, in place.
		},
	};
}

/** The names the official stages take: a recipe package with one of them would collide with a `pkg:` stage and its folder. */
function reservedNames(stack: Stack): string[] {
	return [...stack.npmGlobal.map((p) => p.name), stack.profile.name, ...stack.piPackages.map((p) => p.name)];
}

/**
 * The profile and package stages in the order of the spec's table: `profile` (needs `pi`), `pi-settings` on Windows (needs `profile` and `git`), `pkg:<name>`
 * for each package of the stack (after `pi-settings` on Windows, after `profile` on macOS), `team-pkg:<name>` for each package of the recipe (after every
 * `pkg:`, and after the stage that wrote `settings.json`), and `claude` when the stack lists pi-claude-bridge, whose Agent SDK carries the executable.
 */
export function profileStages(stack: Stack, recipe: EngineRecipe, platform: AppPlatform, options: ProfileStageOptions = {}): Stage[] {
	const reserved = reservedNames(stack);
	for (const pkg of recipe.team?.packages ?? []) if (reserved.includes(pkg.name)) throw new StackError(`the recipe's package ${pkg.name} is one the stack installs itself`);
	const after = platform === "win32" ? "pi-settings" : "profile";
	// pi-claude-bridge waits for the Agent SDK pin when the stack lists one, so npm finds the pinned SDK in the tree and nests no newer copy.
	const packages = stack.piPackages.map((pin) => piPackageStage(pin, pin.name === "pi-claude-bridge" && stack.piPackages.some((p) => p.name === CLAUDE_SDK) ? [after, `pkg:${CLAUDE_SDK}`] : [after], options));
	// A team package needs the stage that wrote `settings.json` as well as the `pkg:` ones, so it never runs ahead of the profile when the stack lists no package.
	const team = (recipe.team?.packages ?? []).map((pin) => teamPackageStage(pin, [after, ...packages.map((s) => s.name)], options));
	return [
		profileStage(options),
		...(platform === "win32" ? [piSettingsStage()] : []),
		...packages,
		...team,
		...(stack.piPackages.some((p) => p.name === "pi-claude-bridge") ? [claudeStage(stack.piPackages.find((p) => p.name === CLAUDE_SDK)?.version)] : []),
	];
}
