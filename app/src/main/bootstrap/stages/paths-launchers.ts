import { copyFileSync, existsSync, linkSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, posix, win32 } from "node:path";
import { toolDir, toolExecutable, type AppPlatform } from "../../paths.ts";
import { StageError } from "../errors.ts";
import { activateFiles, detectFromRecord, fileKey, type Evidence, type Stage, type StageContext } from "../stage.ts";
import { removeTree } from "../fsutil.ts";
import { FORGE_LAUNCHERS, everyLauncherName, launcherFiles, optionalLaunchers, windowsShims, type LauncherSpec } from "./launcher-files.ts";
import { configValue, hasBlock, readGitconfig, upsertBlock, removeBlock } from "./gitconfig.ts";
import { PATHS_FORMAT, pathFiles, type EnabledTools, type PathVersions } from "./path-files.ts";
import { systemEnv } from "../../env.ts";
import { expectVersion, runLine } from "./support.ts";

// The stages that make the tool folders reachable: `tool-paths` (the two generated files), `launchers` (gh, glab, and the optional tools' launchers), and
// `git-helpers` (the forge credential helpers in the private gitconfig). Spec: Stages, Tool paths.

export const LAUNCHER_FORMAT = 1;

/** The enabled set as a stage's evidence names it: adding or removing a name in the recipe changes it, which fails `detect`. */
const setTag = (enabled: EnabledTools): string => [...enabled.clis, ...enabled.optional].join(",") || "none";

const stageOf = (tool: string): string => (tool === "gh" || tool === "glab" ? tool : `opt:${tool}`);

/** The versions the path files name, from `current.json`: node, git, herdr, the CLIs the recipe needs, and the optional tools it names (never a dropped tool). */
function versionsFor(ctx: StageContext, enabled: EnabledTools): PathVersions {
	const base = ctx.versionsOf(["node", "git", "herdr", ...enabled.clis]);
	const optional = ctx.versionsOf(enabled.optional);
	return { node: base.node as string, git: base.git as string, herdr: base.herdr as string, ...(base.gh !== undefined ? { gh: base.gh } : {}), ...(base.glab !== undefined ? { glab: base.glab } : {}), optional };
}

const dependsOnOf = (versions: PathVersions): Record<string, string> => ({
	node: versions.node,
	git: versions.git,
	herdr: versions.herdr,
	...(versions.gh !== undefined ? { gh: versions.gh } : {}),
	...(versions.glab !== undefined ? { glab: versions.glab } : {}),
	...versions.optional,
});

const toolsBin = (ctx: StageContext, name: string): string => join(ctx.layout.tools.bin, name);

function writeStaged(dir: string, files: Record<string, string>, mode: number): void {
	mkdirSync(dir, { recursive: true });
	for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text, { encoding: "utf8", mode });
}

// ---- tool-paths ------------------------------------------------------------------------------------------------------

export function toolPathsStage(platform: AppPlatform, enabled: EnabledTools): Stage {
	const needs = ["node", "git", "herdr", ...enabled.clis, ...enabled.optional.map(stageOf)];
	const tag = `format ${PATHS_FORMAT}; tools ${setTag(enabled)}`;
	const stagingOf = (ctx: StageContext): string => `${ctx.layout.tools.root}${platform === "win32" ? "\\" : "/"}tool-paths.staging`;
	const wanted = (ctx: StageContext): { versions: PathVersions; files: Record<string, string> } => {
		const versions = versionsFor(ctx, enabled);
		return { versions, files: pathFiles(platform, ctx.layout, versions, enabled) };
	};
	return {
		name: "tool-paths",
		needs,
		plannedVersion: () => tag,
		async detect(ctx) {
			let want: ReturnType<typeof wanted>;
			try {
				want = wanted(ctx);
			} catch {
				return null;
			}
			const found = await detectFromRecord(ctx, { version: tag, dependsOn: dependsOnOf(want.versions) });
			if (found === null) return null;
			// The files must hold exactly what the active versions say (an app update may change the generator).
			for (const [name, text] of Object.entries(want.files)) {
				const path = toolsBin(ctx, name);
				if (!existsSync(path) || readFileSync(path, "utf8") !== text) {
					ctx.log.event({ event: "detect-failed", reason: `${path} differs from what the active versions give` });
					return null;
				}
			}
			return found;
		},
		async install(ctx) {
			const dir = ctx.freshStaging(stagingOf(ctx));
			writeStaged(dir, wanted(ctx).files, 0o644);
		},
		async verify(ctx) {
			const { versions, files } = wanted(ctx);
			const dir = stagingOf(ctx);
			const names = Object.keys(files);
			for (const name of names) {
				const text = readFileSync(join(dir, name), "utf8");
				// ASCII only, and no byte of the root's path (the root comes from SBD_APP_ROOT at run time).
				if (/[^\x09\x0a\x0d\x20-\x7e]/.test(text)) throw new StageError("other", { stage: "tool-paths" }, `${name} would hold a character outside ASCII`);
				if (text.includes(ctx.layout.root)) throw new StageError("other", { stage: "tool-paths" }, `${name} would hold the data root's path`);
			}
			// Every executable the files name exists where they say.
			const P = platform === "win32" ? win32 : posix;
			const executables = [
				...["node", "git", "herdr", ...enabled.clis].map((tool) => [tool, versions[tool as "node"] as string] as const),
				...enabled.optional.map((tool) => [tool, versions.optional[tool] as string] as const),
			];
			for (const [tool, version] of executables) {
				const exe = P.join(toolDir(ctx.layout, tool, version), ...toolExecutable(platform, tool).split("/"));
				if (!existsSync(exe)) throw new StageError("other", { stage: "tool-paths" }, `${tool} ${version} has no ${exe}`);
			}
			const keys = names.map((name) => fileKey(ctx.layout, toolsBin(ctx, name)));
			return {
				text: `${names.join(", ")} for ${executables.map(([tool, version]) => `${tool} ${version}`).join(", ")}`,
				version: tag,
				dependsOn: dependsOnOf(versions),
				files: keys,
				stagedFiles: Object.fromEntries(names.map((name, i) => [keys[i] as string, join(dir, name)])),
			};
		},
		async activate(ctx) {
			const dir = stagingOf(ctx);
			mkdirSync(ctx.layout.tools.bin, { recursive: true });
			activateFiles(ctx, Object.keys(wanted(ctx).files).map((name) => ({ from: join(dir, name), to: toolsBin(ctx, name) })));
		},
	};
}

// ---- launchers -------------------------------------------------------------------------------------------------------

function specsFor(enabled: EnabledTools): LauncherSpec[] {
	return [...enabled.clis.map((cli) => FORGE_LAUNCHERS[cli]), ...enabled.optional.flatMap(optionalLaunchers)];
}

/** Hard-links `source` as `target`, or copies it when the file system cannot link. */
function linkOrCopy(source: string, target: string): void {
	try {
		linkSync(source, target);
	} catch {
		copyFileSync(source, target);
	}
}

export function launchersStage(platform: AppPlatform, enabled: EnabledTools, allOptional: readonly string[]): Stage {
	const win = platform === "win32";
	const tag = `format ${LAUNCHER_FORMAT}; launchers ${setTag(enabled)}`;
	const specs = specsFor(enabled);
	const stagingOf = (ctx: StageContext): string => join(ctx.layout.tools.root, "bin.staging");
	/** On Windows the optional tools' executables are linked into `tools/bin` as `bun.exe` and `bunx.exe` (FE2R-F009), so their versions are in the evidence. */
	const shimTools = win ? enabled.optional.filter((tool) => windowsShims(tool).length > 0) : [];
	const dependsOn = (ctx: StageContext): Record<string, string> => (shimTools.length > 0 ? ctx.versionsOf(shimTools) : {});
	const textFiles = launcherFiles(platform, specs);
	const shimNames = shimTools.flatMap(windowsShims);
	return {
		name: "launchers",
		needs: ["tool-paths"],
		plannedVersion: () => tag,
		async detect(ctx) {
			let deps: Record<string, string>;
			try {
				deps = dependsOn(ctx);
			} catch {
				return null;
			}
			const found = await detectFromRecord(ctx, { version: tag, dependsOn: deps });
			if (found === null) return null;
			for (const [name, text] of Object.entries(textFiles)) {
				const path = toolsBin(ctx, name);
				if (!existsSync(path) || readFileSync(path, "utf8") !== text) {
					ctx.log.event({ event: "detect-failed", reason: `${path} differs from what the app writes` });
					return null;
				}
			}
			// A launcher of a tool the recipe no longer names is deleted when the set changes; one that came back is a reason to write the set again.
			const written = new Set([...Object.keys(textFiles), ...shimNames]);
			const stale = everyLauncherName(platform, allOptional).find((name) => !written.has(name) && existsSync(toolsBin(ctx, name)));
			if (stale !== undefined) {
				ctx.log.event({ event: "detect-failed", reason: `${toolsBin(ctx, stale)} belongs to a tool the recipe does not name` });
				return null;
			}
			return found;
		},
		async install(ctx) {
			const dir = ctx.freshStaging(stagingOf(ctx));
			writeStaged(dir, textFiles, 0o755);
			// The staged launchers find their root from their own place (`tools/bin.staging/../..`) and read the `paths` files beside them: copy those in
			// for the check. They are not part of the set that is renamed into `tools/bin`.
			for (const name of Object.keys(pathFiles(platform, ctx.layout, versionsFor(ctx, enabled), enabled))) copyFileSync(toolsBin(ctx, name), join(dir, name));
			for (const tool of shimTools) {
				const version = ctx.versionsOf([tool])[tool] as string;
				const source = join(toolDir(ctx.layout, tool, version), ...toolExecutable(platform, tool).split("/"));
				for (const name of windowsShims(tool)) linkOrCopy(source, join(dir, name));
			}
		},
		async verify(ctx) {
			const dir = stagingOf(ctx);
			const lines: string[] = [];
			const env = systemEnv(platform, ctx.appEnv);
			const versions = versionsFor(ctx, enabled);
			const targets = specs.map((spec) => ({ spec, tool: spec.pathVar === "SBD_GH" ? "gh" : spec.pathVar === "SBD_GLAB" ? "glab" : spec.pathVar.slice(4).toLowerCase() }));
			for (const { spec, tool } of targets) {
				const version = tool === "gh" || tool === "glab" ? (versions[tool] as string) : (versions.optional[tool] as string);
				// A Windows .cmd cannot be spawned directly (Node refuses it), and cmd.exe takes only names the app chose: run it by name from its own folder.
				const line = win
					? await (async () => {
							const result = await ctx.exec(ctx.platform.locate.system("cmd"), ["/d", "/c", `${spec.name}.cmd`, "--version"], { cwd: dir, env, timeoutMs: 120_000 });
							if (result.code !== 0) throw new StageError("other", { stage: "launchers" }, `${spec.name}.cmd --version failed (exit ${result.code}): ${(result.stderr || result.stdout).trim().split(/\r?\n/)[0] ?? ""}`);
							return result.stdout.trim().split(/\r?\n/)[0] ?? "";
						})()
					: await runLine(ctx, join(dir, spec.name), ["--version"]);
				expectVersion(ctx, spec.name, line, version);
				lines.push(`${spec.name} -> ${line}`);
			}
			for (const name of shimNames) {
				const line = await runLine(ctx, join(dir, name), ["--version"]);
				lines.push(`${name} -> ${line}`);
			}
			const names = [...Object.keys(textFiles), ...shimNames];
			const keys = names.map((name) => fileKey(ctx.layout, toolsBin(ctx, name)));
			const deps = dependsOn(ctx);
			const evidence: Evidence = {
				text: lines.length > 0 ? lines.join("; ") : "no launchers (the recipe names no code host and no optional tool)",
				version: tag,
				files: keys,
				stagedFiles: Object.fromEntries(names.map((name, i) => [keys[i] as string, join(dir, name)])),
			};
			if (Object.keys(deps).length > 0) evidence.dependsOn = deps;
			return evidence;
		},
		async activate(ctx) {
			const dir = stagingOf(ctx);
			mkdirSync(ctx.layout.tools.bin, { recursive: true });
			const names = [...Object.keys(textFiles), ...shimNames];
			const keep = new Set(names);
			const drop = everyLauncherName(platform, allOptional).filter((name) => !keep.has(name)).map((name) => toolsBin(ctx, name));
			activateFiles(ctx, names.map((name) => ({ from: join(dir, name), to: toolsBin(ctx, name) })), drop);
		},
	};
}

// ---- git-helpers -----------------------------------------------------------------------------------------------------

/** The path as Git and sh read it: forward slashes, absolute, never a drive-relative form. */
export function posixPath(platform: AppPlatform, path: string): string {
	return platform === "win32" ? win32.resolve(path).split("\\").join("/") : posix.resolve(path);
}

/** `!'<path>' auth git-credential`: the path single-quoted for sh, so spaces and CJK characters pass; a single quote in it is closed, escaped, reopened. */
export function helperCommand(platform: AppPlatform, launcherPath: string): string {
	return `!'${posixPath(platform, launcherPath).replace(/'/g, "'\\''")}' auth git-credential`;
}

export const HELPERS_BLOCK = "forge credential helpers";

/**
 * The body of the forge block. The empty `helper =` comes first for each host: it clears every helper set before it (a general one, Git Credential
 * Manager in the system file). The block must stay after every general `[credential]` setting, so it is always the last thing in the file.
 */
export function helpersBody(platform: AppPlatform, binDir: string, forges: ReadonlyArray<{ kind: "github" | "gitlab"; host: string }>): string {
	const lines: string[] = [];
	for (const { kind, host } of forges) {
		lines.push(`[credential "https://${host}"]`, "\thelper =", `\thelper = ${configValue(helperCommand(platform, join(binDir, kind === "github" ? "gh" : "glab")))}`);
	}
	return lines.join("\n");
}

export function gitHelpersStage(platform: AppPlatform, forges: ReadonlyArray<{ kind: "github" | "gitlab"; host: string }>): Stage {
	const win = platform === "win32";
	const tag = `format 1; hosts ${forges.map((f) => f.host).join(",") || "none"}`;
	const bodyOf = (ctx: StageContext): string => helpersBody(platform, ctx.layout.tools.bin, forges);
	const stagingOf = (ctx: StageContext): string => `${ctx.layout.gitconfig}.staging`;
	const gitOf = (ctx: StageContext): string => join(toolDir(ctx.layout, "git", ctx.versionsOf(["git"]).git as string), ...(win ? ["cmd", "git.exe"] : ["bin", "git"]));
	const shOf = (ctx: StageContext): string => (win ? join(toolDir(ctx.layout, "git", ctx.versionsOf(["git"]).git as string), "usr", "bin", "sh.exe") : "/bin/sh");
	const wantsBlock = forges.length > 0;
	return {
		name: "git-helpers",
		needs: ["git", "launchers"],
		plannedVersion: () => tag,
		async detect(ctx) {
			const found = await detectFromRecord(ctx, { version: tag });
			if (found === null) return null;
			const ok = wantsBlock ? hasBlock(ctx.layout.gitconfig, HELPERS_BLOCK, bodyOf(ctx), "last") : !readGitconfig(ctx.layout.gitconfig).includes("straw-boss forge credential helpers");
			if (!ok) ctx.log.event({ event: "detect-failed", reason: `${ctx.layout.gitconfig} does not hold the forge block the recipe needs` });
			return ok ? found : null;
		},
		async install(ctx) {
			const staging = stagingOf(ctx);
			// Registered for cleanup like a staging folder; the copy of the file it edits goes in its place.
			ctx.freshStaging(staging);
			removeTree(staging);
			writeFileSync(staging, readGitconfig(ctx.layout.gitconfig), "utf8");
			if (wantsBlock) upsertBlock(staging, HELPERS_BLOCK, bodyOf(ctx), "last");
			else removeBlock(staging, HELPERS_BLOCK);
		},
		async verify(ctx) {
			const staging = stagingOf(ctx);
			const env = ctx.childEnv();
			const seen: string[] = [];
			for (const forge of forges) {
				const cli = forge.kind === "github" ? "gh" : "glab";
				const read = await ctx.exec(gitOf(ctx), ["config", "--file", staging, "--get-all", `credential.https://${forge.host}.helper`], { env, timeoutMs: 60_000 });
				const values = read.stdout.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
				const command = helperCommand(platform, join(ctx.layout.tools.bin, cli));
				if (read.code !== 0 || values.length !== 2 || values[0] !== "" || values[1] !== command) {
					throw new StageError("other", { stage: "git-helpers" }, `git reads the ${forge.host} helpers as ${JSON.stringify(values)}, not an empty entry and ${command}`);
				}
				// Run the helper command the way Git does, through sh, with --version in place of the helper's subcommand: the quoting of a path with spaces and CJK characters is proved by running it.
				const tail = " auth git-credential";
				const probe = `${(values[1] as string).slice(1, -tail.length)} --version`;
				const ran = await ctx.exec(shOf(ctx), ["-c", probe], { env, timeoutMs: 60_000 });
				const line = `${ran.stdout}\n${ran.stderr}`.trim().split(/\r?\n/)[0] ?? "";
				const version = ctx.state.version(cli) ?? "";
				if (ran.code !== 0) throw new StageError("other", { stage: "git-helpers" }, `the ${forge.host} helper command did not run through sh (exit ${ran.code}): ${line}`);
				expectVersion(ctx, `the ${forge.host} helper`, line, version);
				seen.push(`${forge.host}: helper '' then ${command} -> ${line}`);
			}
			return {
				text: seen.length > 0 ? seen.join("; ") : "no forge in the recipe, no credential helpers",
				version: tag,
				files: [],
			};
		},
		async activate(ctx) {
			activateFiles(ctx, [{ from: stagingOf(ctx), to: ctx.layout.gitconfig }]);
		},
	};
}
