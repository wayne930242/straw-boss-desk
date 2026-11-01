import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { toolDir } from "../../paths.ts";
import { StageError } from "../errors.ts";
import { activateFiles, detectFromRecord, type Stage, type StageContext } from "../stage.ts";

// The `pi-settings` stage (spec: Stages). Windows only: pi looks for Git Bash only under Program Files and on the PATH, and PortableGit lives in the app's
// tools folder, so without `shellPath` in `settings.json` its bash tool is dead (VM 2026-10-26). The key is merged into the existing file, which the
// `profile` stage wrote first; the file is never replaced. The path names Git's version, so the evidence keeps that version and a Git update writes
// the key again (**Tool paths**).

export const SETTINGS_FORMAT = 1;

/** `bin/bash.exe` of the active PortableGit: the shell pi's bash tool starts. */
export const gitBashPath = (ctx: StageContext): string => join(toolDir(ctx.layout, "git", ctx.versionsOf(["git"]).git as string), "bin", "bash.exe");

const settingsPath = (ctx: StageContext): string => join(ctx.layout.agent, "settings.json");

/** What `settings.json` holds as an object, or null when it is missing; throws a `StageError` when it is there and is not a JSON object. */
export function readSettings(file: string): Record<string, unknown> | null {
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new StageError("other", { stage: "pi-settings" }, `${file} is not valid JSON, so shellPath is not merged into it: ${(error as Error).message}`);
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new StageError("other", { stage: "pi-settings" }, `${file} is not a JSON object`);
	return parsed as Record<string, unknown>;
}

/** The text of `settings` with `shellPath` set, every other key as it was. pi writes two-space JSON. */
export const withShellPath = (settings: Record<string, unknown>, shellPath: string): string => `${JSON.stringify({ ...settings, shellPath }, null, 2)}\n`;

export function piSettingsStage(): Stage {
	const tag = `format ${SETTINGS_FORMAT}`;
	/** A folder beside the file: `freshStaging` makes folders, and the staged copy is renamed over `settings.json`. */
	const stagingOf = (ctx: StageContext): string => join(ctx.layout.agent, "settings.staging");
	const gitDeps = (ctx: StageContext): Record<string, string> => ctx.versionsOf(["git"]);
	return {
		name: "pi-settings",
		needs: ["profile", "git"],
		plannedVersion: () => tag,
		async detect(ctx) {
			let deps: Record<string, string>;
			try {
				deps = gitDeps(ctx);
			} catch {
				return null;
			}
			const found = await detectFromRecord(ctx, { version: tag, dependsOn: deps });
			if (found === null) return null;
			const settings = readSettings(settingsPath(ctx));
			if (settings?.shellPath !== gitBashPath(ctx)) {
				ctx.log.event({ event: "detect-failed", reason: `${settingsPath(ctx)} does not name ${gitBashPath(ctx)} as shellPath` });
				return null;
			}
			return found;
		},
		async install(ctx) {
			const settings = readSettings(settingsPath(ctx));
			if (settings === null) throw new StageError("other", { stage: "pi-settings" }, `${settingsPath(ctx)} is missing; run the profile stage first`);
			const dir = ctx.freshStaging(stagingOf(ctx));
			writeFileSync(join(dir, "settings.json"), withShellPath(settings, gitBashPath(ctx)), "utf8");
		},
		async verify(ctx) {
			const bash = gitBashPath(ctx);
			if (!existsSync(bash)) throw new StageError("other", { stage: "pi-settings" }, `${bash} does not exist`);
			const staged = readSettings(join(stagingOf(ctx), "settings.json"));
			if (staged?.shellPath !== bash) throw new StageError("other", { stage: "pi-settings" }, "the staged settings.json does not name the Git bash as shellPath");
			return { text: `shellPath=${bash}`, version: tag, dependsOn: gitDeps(ctx) };
		},
		async activate(ctx) {
			activateFiles(ctx, [{ from: join(stagingOf(ctx), "settings.json"), to: settingsPath(ctx) }]);
		},
	};
}
