import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, win32 } from "node:path";
import { systemEnv } from "../../env.ts";
import { toolDir } from "../../paths.ts";
import { StageError } from "../errors.ts";
import { activateFiles, detectFromRecord, fileKey, type Evidence, type Stage, type StageContext } from "../stage.ts";
import { planEnsureFirst } from "../../platform/win.ts";
import type { EnabledTools } from "./path-files.ts";
import { binScript, npmGlobalPin } from "./pi.ts";
import { everyShimFile, shimFiles, shimNames } from "./shim-files.ts";
import { expectVersion } from "./support.ts";

// The `pi-shim` stage (spec: Stages; Panes on Windows; Writing the PATH entry). Windows only: `tools\shims` with `pi.cmd`, `pi`, `bash.cmd` (and
// `bun.cmd`, `bunx.cmd` for a recipe that names bun), then the one user PATH entry `<root>\tools\shims`, first among the user entries, through
// `UserPath`. The files hold no version and no path, so they are written once; a change of the recipe's optional tools changes the set.

export const SHIM_FORMAT = 1;

/** The files the `pi-shim` stage ever wrote, as absolute paths under `tools/shims`, minus those the current set keeps. */
export function shimDrop(shimsDir: string, enabled: EnabledTools, allOptional: readonly string[]): string[] {
	const keep = shimNames(enabled.optional);
	return everyShimFile(allOptional).filter((name) => !keep.includes(name)).map((name) => join(shimsDir, name));
}

const setTag = (enabled: EnabledTools): string => enabled.optional.join(",") || "none";

export function piShimStage(enabled: EnabledTools, allOptional: readonly string[]): Stage {
	const tag = `format ${SHIM_FORMAT}; tools ${setTag(enabled)}`;
	/** The shim files for the installed pi: `pi.cmd` names the package's bin script, so a pi whose bin entry moved changes the text (T6-F001). */
	const filesOf = (ctx: StageContext): Record<string, string> => {
		const script = binScript(ctx.layout, npmGlobalPin(ctx.stack, "pi"), "pi");
		if (script === null) throw new StageError("other", { stage: "pi-shim" }, `the installed pi has no bin script under ${ctx.layout.tools.npm}`);
		return shimFiles(enabled.optional, script.relative);
	};
	const stagingOf = (ctx: StageContext): string => join(ctx.layout.tools.root, "shims.staging");
	const finalOf = (ctx: StageContext, name: string): string => join(ctx.layout.tools.shims, name);
	// The recipe's optional tools decide the bun shims, which run the launchers: wait for them. `launchers` needs `tool-paths` already.
	const needs = ["pi", "tool-paths", ...(enabled.optional.length > 0 ? ["launchers"] : [])];
	return {
		name: "pi-shim",
		needs,
		plannedVersion: () => tag,
		async detect(ctx) {
			if (!ctx.platform.userPath.supported) return null;
			const found = await detectFromRecord(ctx, { version: tag });
			if (found === null) return null;
			let files: Record<string, string>;
			try {
				files = filesOf(ctx);
			} catch {
				return null;
			}
			for (const [name, text] of Object.entries(files)) {
				const path = finalOf(ctx, name);
				if (!existsSync(path) || readFileSync(path, "utf8") !== text) {
					ctx.log.event({ event: "detect-failed", reason: `${path} differs from what the app writes` });
					return null;
				}
			}
			const stale = shimDrop(ctx.layout.tools.shims, enabled, allOptional).find((path) => existsSync(path));
			if (stale !== undefined) {
				ctx.log.event({ event: "detect-failed", reason: `${stale} does not belong to the shims the recipe needs` });
				return null;
			}
			// The user PATH entry: present and first (Repair adds it again when it is missing).
			const current = await ctx.platform.userPath.read();
			if (planEnsureFirst(current, ctx.layout.tools.shims).changed) {
				ctx.log.event({ event: "detect-failed", reason: `the user PATH does not start its app entries with ${ctx.layout.tools.shims}` });
				return null;
			}
			return found;
		},
		async install(ctx) {
			const files = filesOf(ctx);
			const dir = ctx.freshStaging(stagingOf(ctx));
			// Binary-safe: the batch files keep their CRLF and the POSIX script its LF.
			for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text, { encoding: "utf8", mode: 0o755 });
		},
		async verify(ctx) {
			const dir = stagingOf(ctx);
			const names = shimNames(enabled.optional);
			for (const name of names) {
				const text = readFileSync(join(dir, name), "utf8");
				// ASCII only, and no byte of the root's path or of its parent: the root comes from the shim's own place (cmd reads a batch file in the OEM code page).
				if (/[^\x09\x0a\x0d\x20-\x7e]/.test(text)) throw new StageError("other", { stage: "pi-shim" }, `${name} would hold a character outside ASCII`);
				if (text.includes(ctx.layout.root) || text.includes(ctx.layout.root.replace(/\\/g, "/"))) throw new StageError("other", { stage: "pi-shim" }, `${name} would hold the data root's path`);
			}
			const lines = await runStagedShims(ctx, dir, enabled);
			const keys = names.map((name) => fileKey(ctx.layout, finalOf(ctx, name)));
			const evidence: Evidence = {
				text: `${names.join(", ")}; ${lines.join("; ")}`,
				version: tag,
				files: keys,
				stagedFiles: Object.fromEntries(keys.map((key, i) => [key, join(dir, names[i] as string)])),
			};
			return evidence;
		},
		async activate(ctx) {
			const dir = stagingOf(ctx);
			mkdirSync(ctx.layout.tools.shims, { recursive: true });
			activateFiles(
				ctx,
				shimNames(enabled.optional).map((name) => ({ from: join(dir, name), to: finalOf(ctx, name) })),
				shimDrop(ctx.layout.tools.shims, enabled, allOptional),
			);
			// The files are in place before the entry points at the folder.
			await ctx.platform.userPath.ensureFirst(ctx.layout.tools.shims);
		},
	};
}

/**
 * Runs the staged shims the way a desk pane does: `STRAW_BOSS_DESK=1` and `STRAW_BOSS_DESK_ROOT` naming this root, a machine `PATH` of System32 alone.
 * `pi.cmd --version` must print the pin, `bash.cmd --version` must print PortableGit's bash, and `pi` through Git's own `sh` must print the pin as well
 * (the staged folder sits at the same depth as `tools/shims`, so each finds this root).
 */
async function runStagedShims(ctx: StageContext, dir: string, enabled: EnabledTools): Promise<string[]> {
	const system32 = win32.join(systemRoot(ctx), "System32");
	const env: Record<string, string> = { ...systemEnv("win32", ctx.appEnv), STRAW_BOSS_DESK: "1", STRAW_BOSS_DESK_ROOT: ctx.layout.root, PATH: system32 };
	const cmd = ctx.platform.locate.system("cmd");
	const lines: string[] = [];
	const pin = ctx.stack.npmGlobal.find((p) => p.bin === "pi")?.version;
	const piLine = await runLineIn(ctx, cmd, ["/d", "/c", "pi.cmd", "--version"], dir, env);
	if (pin !== undefined) expectVersion(ctx, "pi.cmd", piLine, pin);
	lines.push(`pi.cmd -> ${piLine}`);
	const bashLine = await runLineIn(ctx, cmd, ["/d", "/c", "bash.cmd", "--version"], dir, env);
	if (!/GNU bash/i.test(bashLine)) throw new StageError("other", { stage: "pi-shim" }, `bash.cmd --version printed ${JSON.stringify(bashLine)}, not GNU bash`);
	lines.push(`bash.cmd -> ${bashLine}`);
	const git = ctx.versionsOf(["git"]).git as string;
	// PortableGit's `bin\sh.exe`, the launcher that puts /usr/bin on the PATH as a pane's bash does (npm's POSIX wrapper needs `sed`); `usr\bin\sh.exe` alone does not.
	const sh = join(toolDir(ctx.layout, "git", git), "bin", "sh.exe");
	const viaSh = await runLineIn(ctx, sh, ["-c", './pi --version'], dir, env);
	if (pin !== undefined) expectVersion(ctx, "pi (sh)", viaSh, pin);
	lines.push(`pi (sh) -> ${viaSh}`);
	for (const tool of enabled.optional) {
		if (tool !== "bun") continue;
		const bunLine = await runLineIn(ctx, cmd, ["/d", "/c", "bun.cmd", "--version"], dir, env);
		const bun = ctx.versionsOf(["bun"]).bun as string;
		expectVersion(ctx, "bun.cmd", bunLine, bun);
		lines.push(`bun.cmd -> ${bunLine}`);
	}
	return lines;
}

const systemRoot = (ctx: StageContext): string => (ctx.appEnv.SystemRoot ?? ctx.appEnv.windir ?? "C:\\Windows") as string;

async function runLineIn(ctx: StageContext, file: string, args: readonly string[], cwd: string, env: Record<string, string>): Promise<string> {
	const result = await ctx.exec(file, args, { cwd, env, timeoutMs: 120_000 });
	const line = `${result.stdout}\n${result.stderr}`.trim().split(/\r?\n/)[0] ?? "";
	if (result.code !== 0) throw new StageError("other", { stage: "pi-shim" }, `${file} ${args.join(" ")} failed (exit ${result.code}) in the staged shims: ${line}`);
	return result.stdout.trim().split(/\r?\n/)[0] ?? line;
}
