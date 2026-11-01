import { chmodSync, copyFileSync, existsSync, readdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { StageError } from "./errors.ts";
import { removeTree } from "./fsutil.ts";
import { activateDir, detectFromRecord, fileKey, installDir, type Evidence, type Lane, type Stage, type StageContext } from "./stage.ts";
import type { Asset } from "./stack.ts";

// The stage every binary tool is made from (spec: Stage contract, Rollback): a pinned asset is downloaded and verified, extracted (or, for a bare
// binary, copied) into `tools/<tool>/<version>.staging/`, verified by running or reading the staged result, and renamed to `tools/<tool>/<version>/`.
// The previous version's folder is untouched, so a failed install or verify leaves it active.

export interface ArchiveStageSpec {
	name: string;
	needs: readonly string[];
	/** The folder name under `tools/` and the key in `current.json`. */
	tool: string;
	/** The stack key of the pinned asset when it differs from `tool` (`fd`, `rg` are provisioned into pi's own folder, but their pins are named so). */
	stackTool?: string;
	/**
	 * A zip or tarball: extracted with the system `tar`. A `file` asset is a bare binary and is copied to `placeAs`. An `sfx` asset is a 7-Zip
	 * self-extracting executable (PortableGit), run on its verified bytes.
	 */
	kind: "archive" | "file" | "sfx";
	stripComponents?: number;
	/** For `kind: "file"`: the name the binary gets inside the folder. */
	placeAs?: string;
	/** Files to hash at activation, relative to the tool's folder: the executables a later `detect` must find unchanged. */
	executables: readonly string[];
	/** Other tools whose versions the output names; any change of one makes the stage run again. */
	dependsOn?: readonly string[];
	lane?: Lane;
	/** Runs the staged result and returns one line of evidence (a `--version` line). The default checks that every executable exists. */
	check?(ctx: StageContext, dir: string, asset: Asset): Promise<string>;
	/** Work on the extracted folder before `verify` (writing a config file, creating a folder). */
	afterExtract?(ctx: StageContext, dir: string, asset: Asset): Promise<void>;
}

export function archiveStage(spec: ArchiveStageSpec): Stage {
	const stackTool = spec.stackTool ?? spec.tool;
	const assetOf = (ctx: StageContext): Asset => {
		const asset = (ctx.stack.tools[stackTool] ?? ctx.stack.optionalTools[stackTool])?.assets[ctx.key];
		if (asset === undefined) throw new StageError("other", { stage: spec.name }, `the stack has no ${stackTool} for ${ctx.key}`);
		return asset;
	};
	const staging = (ctx: StageContext, asset: Asset): string => `${installDir(ctx.layout, spec.tool, asset.version)}.staging`;
	const dependsOn = (ctx: StageContext): Record<string, string> => ctx.versionsOf(spec.dependsOn ?? []);
	const files = (ctx: StageContext, asset: Asset): string[] =>
		spec.executables.map((e) => fileKey(ctx.layout, join(installDir(ctx.layout, spec.tool, asset.version), ...e.split("/"))));

	return {
		name: spec.name,
		needs: spec.needs,
		lane: spec.lane ?? "download",
		plannedVersion: (ctx) => assetOf(ctx).version,
		async detect(ctx) {
			const asset = assetOf(ctx);
			let deps: Record<string, string>;
			try {
				deps = dependsOn(ctx);
			} catch {
				return null;
			}
			return detectFromRecord(ctx, { version: asset.version, tool: spec.tool, dependsOn: deps });
		},
		async install(ctx) {
			const asset = assetOf(ctx);
			const dir = ctx.freshStaging(staging(ctx, asset));
			const downloaded = await ctx.download(stackTool, asset);
			if (spec.kind === "archive") {
				const extracted = await ctx.extract(downloaded.path, dir, spec.stripComponents);
				ctx.log.event({ event: "extracted", entries: extracted.entries, tar: extracted.tar });
			} else if (spec.kind === "sfx") {
				const extracted = await ctx.extractSelfExtractor(downloaded.path, asset.sha256, dir);
				ctx.log.event({ event: "extracted", entries: extracted.entries, sfx: true });
			} else {
				const target = join(dir, spec.placeAs ?? asset.file);
				copyFileSync(downloaded.path, target);
				chmodSync(target, 0o755);
			}
			// Some archives hold one top folder (`gh_2.103.3_macOS_arm64/bin/gh`, `bun-darwin-aarch64/bun`): its contents move up, so the layout the
			// path files name is the same on every platform.
			const first = spec.executables[0];
			if (spec.kind === "archive" && first !== undefined && !existsSync(join(dir, ...first.split("/")))) liftSingleFolder(dir, first);
			await spec.afterExtract?.(ctx, dir, asset);
		},
		async verify(ctx) {
			const asset = assetOf(ctx);
			const dir = staging(ctx, asset);
			for (const exe of spec.executables) {
				if (!existsSync(join(dir, ...exe.split("/")))) throw new StageError("other", { stage: spec.name }, `${spec.tool} ${asset.version} has no ${exe} after extraction`);
			}
			const text = spec.check ? await spec.check(ctx, dir, asset) : `${spec.tool} ${asset.version}`;
			const finals = files(ctx, asset);
			const evidence: Evidence = {
				text,
				version: asset.version,
				files: finals,
				stagedFiles: Object.fromEntries(spec.executables.map((e, i) => [finals[i] as string, join(dir, ...e.split("/"))])),
			};
			const deps = dependsOn(ctx);
			if (Object.keys(deps).length > 0) evidence.dependsOn = deps;
			return evidence;
		},
		async activate(ctx, evidence) {
			const asset = assetOf(ctx);
			await activateDir(ctx, { tool: spec.tool, version: evidence.version, staging: staging(ctx, asset) });
		},
	};
}

/**
 * When `dir` holds one folder and nothing else, and `probe` (a path relative to `dir`) is inside that folder, moves the folder's contents up and
 * removes the folder. Anything else is left as it is: the caller's `verify` then names the file that is missing.
 */
export function liftSingleFolder(dir: string, probe: string): void {
	const entries = readdirSync(dir);
	const only = entries.length === 1 ? entries[0] : undefined;
	if (only === undefined || !statSync(join(dir, only)).isDirectory()) return;
	if (!existsSync(join(dir, only, ...probe.split("/")))) return;
	// Out of the way first, so a child with the folder's own name cannot collide with it.
	const aside = join(dir, `${only}.lifting`);
	renameSync(join(dir, only), aside);
	for (const child of readdirSync(aside)) renameSync(join(aside, child), join(dir, child));
	removeTree(aside);
}
