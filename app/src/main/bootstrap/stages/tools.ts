import { chmodSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { bunCacheDir, bunHome } from "../../env.ts";
import { toolExecutable, type AppPlatform } from "../../paths.ts";
import { archiveStage } from "../archive-stage.ts";
import { StageError } from "../errors.ts";
import { removeTree } from "../fsutil.ts";
import { StackError, assetFor } from "../stack.ts";
import { activateFiles, detectFromRecord, fileKey, type Stage, type StageContext } from "../stage.ts";
import { hasBlock, upsertBlock } from "./gitconfig.ts";
import { expectVersion, runLine, withManagedFiles, type ManagedFile } from "./support.ts";

// The tool stages (spec: Stages): node, git, herdr, fd-rg, gh, glab, and one `opt:<tool>` for each optional tool the recipe names. Each downloads its
// pinned asset, extracts it into `tools/<tool>/<version>.staging`, runs the staged binary, and renames the folder into place (`archiveStage`).

const exe = (platform: AppPlatform): string => (platform === "win32" ? ".exe" : "");

// ---- node ------------------------------------------------------------------------------------------------------------

export function nodeStage(platform: AppPlatform): Stage {
	return archiveStage({
		name: "node",
		needs: ["preflight"],
		tool: "node",
		kind: "archive",
		stripComponents: 1,
		executables: [toolExecutable(platform, "node")],
		async check(ctx, dir, asset) {
			const line = await runLine(ctx, join(dir, ...toolExecutable(platform, "node").split("/")));
			expectVersion(ctx, "node", line, asset.version);
			const arch = await runLine(ctx, join(dir, ...toolExecutable(platform, "node").split("/")), ["-p", "process.arch"]);
			return `node ${line} ${arch}`;
		},
	});
}

// ---- git -------------------------------------------------------------------------------------------------------------

/** The `git` block of the private gitconfig: identity placeholder, long paths, and the default branch (spec: Stages, `git`). */
export const GIT_BASE_BLOCK = ["[user]", "\tname = Straw Boss PM", "\temail = pm@straw-boss.invalid", "[core]", "\tlongpaths = true", "[init]", "\tdefaultBranch = main"].join("\n");

/** `2.56.0.3` (PortableGit's pin) is `git version 2.56.0.windows.3`; `2.56.0-2` (dugite-native's) is `git version 2.56.0`. */
export function expectedGitVersion(version: string): string {
	const win = /^(\d+\.\d+\.\d+)\.(\d+)$/.exec(version);
	if (win) return `git version ${win[1]}.windows.${win[2]}`;
	return `git version ${version.split("-")[0]}`;
}

/** The variables dugite-native's git needs to find its helpers and templates (it is built for the prefix `/`; spec: Environment, task 5 finding). */
export function dugiteEnv(gitFolder: string): Record<string, string> {
	return { GIT_EXEC_PATH: join(gitFolder, "libexec", "git-core"), GIT_TEMPLATE_DIR: join(gitFolder, "share", "git-core", "templates") };
}

export function gitStage(platform: AppPlatform): Stage {
	const win = platform === "win32";
	const stage = archiveStage({
		name: "git",
		needs: ["preflight"],
		tool: "git",
		kind: win ? "sfx" : "archive",
		executables: win ? ["cmd/git.exe", "bin/bash.exe", "usr/bin/sh.exe"] : ["bin/git", "libexec/git-core/git-remote-https"],
		async check(ctx, dir, asset) {
			if (win) {
				const line = await runLine(ctx, join(dir, "cmd", "git.exe"));
				if (line !== expectedGitVersion(asset.version)) throw new StageError("other", { stage: "git" }, `git reports "${line}", the pin is ${expectedGitVersion(asset.version)}`);
				const bash = await runLine(ctx, join(dir, "bin", "bash.exe"));
				return `${line}; bash=${bash}`;
			}
			const line = await runLine(ctx, join(dir, "bin", "git"), ["--version"], dugiteEnv(dir));
			if (line !== expectedGitVersion(asset.version)) throw new StageError("other", { stage: "git" }, `git reports "${line}", the pin is ${expectedGitVersion(asset.version)}`);
			return line;
		},
	});
	return {
		...stage,
		async detect(ctx) {
			const found = await stage.detect(ctx);
			if (found === null) return null;
			if (!hasBlock(ctx.layout.gitconfig, "base", GIT_BASE_BLOCK, "first")) {
				ctx.log.event({ event: "detect-failed", reason: `${ctx.layout.gitconfig} lacks the app's base block` });
				return null;
			}
			return found;
		},
		async activate(ctx, evidence) {
			await stage.activate(ctx, evidence);
			upsertBlock(ctx.layout.gitconfig, "base", GIT_BASE_BLOCK, "first");
		},
	};
}

// ---- herdr -----------------------------------------------------------------------------------------------------------

/**
 * Herdr's config (spec: Stages, `herdr`): no onboarding, version or manifest check, no sounds, agents resumed after a restart; on macOS the panes start
 * non-login `/bin/zsh`, whatever the PM's login shell, so the `ZDOTDIR` isolation always applies (mac spike finding 6, R-F007).
 */
export function herdrConfigText(platform: AppPlatform): string {
	const terminal = platform === "darwin" ? ['shell_mode = "non_login"', 'default_shell = "/bin/zsh"'] : [];
	return [
		"# straw-boss-desk: written by the app.",
		"onboarding = false",
		"",
		...(terminal.length > 0 ? ["[terminal]", ...terminal, ""] : []),
		"[update]",
		"version_check = false",
		"manifest_check = false",
		"",
		"# After a restart herdr restores the workspaces and resumes their pi panes, so the tower comes back with its role.",
		"[session]",
		"resume_agents_on_restore = true",
		"",
		"[ui.sound]",
		"enabled = false",
		"",
	].join("\n");
}

/** What a pane's zsh reads on macOS (spec: Panes on macOS): `PATH` from `paths.sh`, nothing of the PM's own startup files. No version and no path in it. */
export const ZDOTDIR_TEXT = [
	"# straw-boss-desk: written by the app. A pane's zsh reads only this folder, so the PM's own startup files never change which gh, git, or node it runs.",
	'if [ -n "$STRAW_BOSS_DESK_ROOT" ] && [ -r "$STRAW_BOSS_DESK_ROOT/tools/bin/paths.sh" ]; then',
	'\tSBD_APP_ROOT=$STRAW_BOSS_DESK_ROOT',
	'\t. "$STRAW_BOSS_DESK_ROOT/tools/bin/paths.sh"',
	'\tPATH="$SBD_PATH:/usr/bin:/bin:/usr/sbin:/sbin"',
	"\texport PATH",
	"fi",
	"",
].join("\n");

export function herdrManagedFiles(platform: AppPlatform, ctx: StageContext): ManagedFile[] {
	const files: ManagedFile[] = [{ path: ctx.layout.herdrConfig, text: herdrConfigText(platform) }];
	if (platform === "darwin") {
		files.push({ path: join(ctx.layout.zdotdir, ".zshenv"), text: ZDOTDIR_TEXT }, { path: join(ctx.layout.zdotdir, ".zshrc"), text: ZDOTDIR_TEXT });
	}
	return files;
}

export function herdrStage(platform: AppPlatform): Stage {
	const win = platform === "win32";
	const stage = archiveStage({
		name: "herdr",
		needs: ["preflight"],
		tool: "herdr",
		kind: win ? "archive" : "file",
		placeAs: "herdr",
		executables: win ? ["herdr.exe", "conpty/conpty.dll"] : ["herdr"],
		async check(ctx, dir, asset) {
			const line = await runLine(ctx, join(dir, win ? "herdr.exe" : "herdr"), ["--version"], { HERDR_DISABLE_SOUND: "1" });
			expectVersion(ctx, "herdr", line, asset.version);
			return line;
		},
	});
	return withManagedFiles(stage, (ctx) => herdrManagedFiles(platform, ctx));
}

// ---- fd and ripgrep --------------------------------------------------------------------------------------------------

/** pi downloads the latest `fd` and `rg` on its first start without a pin (mac spike finding 5); this stage puts the pinned ones into its `bin` folder first. */
export function fdRgStage(platform: AppPlatform): Stage {
	const tools = [
		{ stack: "fd", file: `fd${exe(platform)}` },
		{ stack: "rg", file: `rg${exe(platform)}` },
	] as const;
	const stagingOf = (ctx: StageContext): string => join(ctx.layout.agent, "bin", "fd-rg.staging");
	const finalOf = (ctx: StageContext, file: string): string => join(ctx.layout.agent, "bin", file);
	const versionOf = (ctx: StageContext): string => tools.map((t) => `${t.stack} ${assetFor(ctx.stack, t.stack, ctx.key).version}`).join(", ");
	return {
		name: "fd-rg",
		needs: ["preflight"],
		lane: "download",
		plannedVersion: versionOf,
		async detect(ctx) {
			return detectFromRecord(ctx, { version: versionOf(ctx) });
		},
		async install(ctx) {
			const staging = ctx.freshStaging(stagingOf(ctx));
			for (const tool of tools) {
				const asset = assetFor(ctx.stack, tool.stack, ctx.key);
				const downloaded = await ctx.download(tool.stack, asset);
				const unpacked = join(staging, `${tool.stack}-unpacked`);
				const extracted = await ctx.extract(downloaded.path, unpacked, 1);
				ctx.log.event({ event: "extracted", tool: tool.stack, entries: extracted.entries });
				const from = join(unpacked, tool.file);
				if (!existsSync(from)) throw new StageError("other", { stage: "fd-rg" }, `the ${tool.stack} archive holds no ${tool.file}`);
				renameSync(from, join(staging, tool.file));
				chmodSync(join(staging, tool.file), 0o755);
				removeTree(unpacked);
			}
		},
		async verify(ctx) {
			const staging = stagingOf(ctx);
			const lines: string[] = [];
			const files: string[] = [];
			const stagedFiles: Record<string, string> = {};
			for (const tool of tools) {
				const asset = assetFor(ctx.stack, tool.stack, ctx.key);
				const line = await runLine(ctx, join(staging, tool.file));
				expectVersion(ctx, tool.stack, line, asset.version);
				lines.push(line);
				// T4-F004: the agent folder can lie outside the root on Windows, so these keys carry the `agent:` role.
				const key = fileKey(ctx.layout, finalOf(ctx, tool.file));
				files.push(key);
				stagedFiles[key] = join(staging, tool.file);
			}
			return { text: lines.join("; "), version: versionOf(ctx), files, stagedFiles };
		},
		async activate(ctx) {
			mkdirSync(join(ctx.layout.agent, "bin"), { recursive: true });
			activateFiles(ctx, tools.map((tool) => ({ from: join(stagingOf(ctx), tool.file), to: finalOf(ctx, tool.file) })));
		},
	};
}

// ---- gh and glab -----------------------------------------------------------------------------------------------------

function forgeCliStage(platform: AppPlatform, cli: "gh" | "glab"): Stage {
	const file = `bin/${cli}${exe(platform)}`;
	return archiveStage({
		name: cli,
		needs: ["preflight"],
		tool: cli,
		kind: "archive",
		executables: [file],
		async check(ctx, dir, asset) {
			const env: Record<string, string> =
				cli === "gh"
					? { GH_CONFIG_DIR: ctx.layout.ghConfig, GH_NO_UPDATE_NOTIFIER: "1", GH_TELEMETRY: "disabled", DO_NOT_TRACK: "1" }
					: { GLAB_CONFIG_DIR: ctx.layout.glabConfig, GLAB_CHECK_UPDATE: "false", GLAB_SEND_TELEMETRY: "0", DO_NOT_TRACK: "1" };
			const line = await runLine(ctx, join(dir, ...file.split("/")), ["--version"], env);
			expectVersion(ctx, cli, line, asset.version);
			return line;
		},
	});
}

export const ghStage = (platform: AppPlatform): Stage => forgeCliStage(platform, "gh");
export const glabStage = (platform: AppPlatform): Stage => forgeCliStage(platform, "glab");

// ---- optional tools --------------------------------------------------------------------------------------------------

/** How a stage installs and runs one optional tool. A tool named in `stack.json` without an entry here has no stage, and the engine refuses it by name. */
interface OptionalToolSpec {
	/** Executables inside the tool's folder after the zip's one top folder is flattened. */
	executables(platform: AppPlatform): string[];
	/** The environment the staged `--version` runs with. */
	env(ctx: StageContext): Record<string, string>;
}

export const OPTIONAL_TOOLS: Readonly<Record<string, OptionalToolSpec>> = {
	bun: {
		executables: (platform) => [`bun${exe(platform)}`],
		env: (ctx) => ({ BUN_INSTALL: bunHome(ctx.layout), BUN_INSTALL_CACHE_DIR: bunCacheDir(ctx.layout), DO_NOT_TRACK: "1" }),
	},
};

/** `opt:<tool>`: the official zip into `tools/<tool>/<version>/`, flattened; verify runs `<tool> --version` and compares it to the pin (spec: Stages). */
export function optionalToolStage(platform: AppPlatform, tool: string): Stage {
	const spec = OPTIONAL_TOOLS[tool];
	if (spec === undefined) throw new StackError(`the stack lists the optional tool ${tool}, which this version of the app has no stage for`);
	const executables = spec.executables(platform);
	return archiveStage({
		name: `opt:${tool}`,
		needs: ["preflight"],
		tool,
		kind: "archive",
		executables,
		async check(ctx, dir, asset) {
			const line = await runLine(ctx, join(dir, ...(executables[0] as string).split("/")), ["--version"], spec.env(ctx));
			expectVersion(ctx, tool, line, asset.version);
			return `${tool} ${line}`;
		},
	});
}
