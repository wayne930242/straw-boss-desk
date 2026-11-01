import { existsSync, readFileSync } from "node:fs";
import { posix, win32 } from "node:path";
import { systemEnv } from "../../env.ts";
import type { Layout } from "../../paths.ts";
import { StageError } from "../errors.ts";
import { writeFileAtomic } from "../fsutil.ts";
import type { Evidence, Stage, StageContext } from "../stage.ts";

// Pieces the tool stages share.

export const pathModule = (layout: Layout): typeof posix => (layout.platform === "win32" ? win32 : posix);

/** `gh` on macOS, `gh.exe` on Windows. */
export const exeName = (layout: Layout, base: string): string => (layout.platform === "win32" ? `${base}.exe` : base);

/** A path under the data root as the path files write it: relative to the root, with the platform's separator. */
export function relativeToRoot(layout: Layout, absolute: string): string {
	return pathModule(layout).relative(layout.root, absolute);
}

const firstLine = (text: string): string => text.trim().split(/\r?\n/)[0] ?? "";

/**
 * Runs `file --version` (or `args`) with the system essentials as its whole environment and returns the first line of its output. Throws a
 * `StageError` of category `other` that names the program and what it said when it fails.
 */
export async function runLine(ctx: StageContext, file: string, args: readonly string[] = ["--version"], extraEnv?: Readonly<Record<string, string>>): Promise<string> {
	const result = await ctx.exec(file, args, { env: { ...systemEnv(ctx.layout.platform, ctx.appEnv), ...extraEnv }, timeoutMs: 120_000 });
	const text = firstLine(`${result.stdout}\n${result.stderr}`);
	if (result.code !== 0) {
		const why = result.timedOut ? "timed out" : `exit ${result.code}`;
		throw new StageError("other", { stage: ctx.stage }, `${file} ${args.join(" ")} failed (${why}): ${text}`);
	}
	return firstLine(result.stdout) !== "" ? firstLine(result.stdout) : text;
}

/** Throws unless `line` (a `--version` output) names `version`. Compares as a word, so `1.2.23` does not match `11.2.23` or `1.2.230`. */
export function expectVersion(ctx: StageContext, what: string, line: string, version: string): void {
	const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	if (!new RegExp(`(^|[^0-9.])${escaped}($|[^0-9])`).test(line)) throw new StageError("other", { stage: ctx.stage }, `${what} reports "${line}", the pin is ${version}`);
}

/** A file whose whole text a stage owns: written atomically in `activate`, compared in `detect`. */
export interface ManagedFile {
	path: string;
	text: string;
	mode?: number;
}

function readText(path: string): string | null {
	try {
		return readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

export const managedFileMatches = (file: ManagedFile): boolean => readText(file.path) === file.text;

export function writeManagedFile(file: ManagedFile): void {
	writeFileAtomic(file.path, file.text);
}

/**
 * Adds files a stage owns, outside its tool folder (Herdr's `config.toml`, the macOS `ZDOTDIR` files), to a stage: `detect` also requires each file
 * to hold exactly its text, and `activate` writes them after the tool folder is in place. They carry no hash in the record: their text is the check.
 */
export function withManagedFiles(stage: Stage, files: (ctx: StageContext) => ManagedFile[]): Stage {
	return {
		...stage,
		async detect(ctx) {
			const found = await stage.detect(ctx);
			if (found === null) return null;
			for (const file of files(ctx)) {
				if (!managedFileMatches(file)) {
					ctx.log.event({ event: "detect-failed", reason: `${file.path} differs from what the app writes` });
					return null;
				}
			}
			return found;
		},
		async activate(ctx, evidence: Evidence) {
			await stage.activate(ctx, evidence);
			for (const file of files(ctx)) writeManagedFile(file);
		},
	};
}

export const fileExists = (path: string): boolean => existsSync(path);
