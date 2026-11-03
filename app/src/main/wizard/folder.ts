import { realpathSync } from "node:fs";
import { join, win32, posix } from "node:path";
import { isInside, type AppPlatform } from "../paths.ts";
import type { FolderProblem } from "../../shared/wizard.ts";

// The work folder step (spec: First run, step 4; Decisions, Work folder). The default is `~/StrawBoss`; the PM may pick another folder inside the home. The home base is `Straw Boss` inside it.

export const DEFAULT_WORK_FOLDER_NAME = "StrawBoss";

export const defaultWorkFolder = (home: string): string => join(home, DEFAULT_WORK_FOLDER_NAME);

export interface FolderCheckInput {
	path: string;
	home: string;
	/** The data root: the work folder must not lie inside it (Remove all data would delete the work). */
	root: string;
	platform: AppPlatform;
	/** Real path of what exists of `path` (default `realpathSync.native`); a path that does not exist yet is checked as given. */
	realpath?: (path: string) => string;
	/** True when `path` exists and is not a folder. */
	isFile?: (path: string) => boolean;
}

/** Why `path` cannot be the work folder, or null when it can. Pure apart from the injected file system reads. */
export function workFolderProblem(input: FolderCheckInput): FolderProblem | null {
	const P = input.platform === "win32" ? win32 : posix;
	if (!P.isAbsolute(input.path)) return "not-absolute";
	const real = (p: string): string => {
		try {
			return (input.realpath ?? ((x: string) => realpathSync.native(x)))(p);
		} catch {
			return p;
		}
	};
	const path = real(input.path);
	const home = real(input.home);
	const root = real(input.root);
	if (input.isFile?.(input.path) === true) return "not-a-folder";
	if (P.relative(home, path) === "") return "is-home";
	if (!isInside(home, path, P)) return "outside-home";
	if (isInside(root, path, P)) return "inside-app-data";
	return null;
}
