import { existsSync } from "node:fs";
import { posix, win32 } from "node:path";
import type { UserPath } from "./platform/types.ts";
import { hasRemoveUserPath, hasStopStack } from "./runtime/args.ts";
import { finishPending, type FinishPending } from "./removal/pending.ts";

// What the app does before anything else: before `app.setPath("userData")`, before the single-instance lock, before a window (spec: Uninstall and data). Three cases are decided here, and
// none of them may leave a file behind in the data root:
//   - `<root>/remove-pending` exists: a **Remove all data** whose cleanup never ran. The root is deleted now, before Chromium opens its profile in it, and the app then starts as on a new machine;
//   - `--remove-user-path`: the uninstaller's call. The app's one user PATH entry is removed through `UserPath` and the app exits;
//   - `--stop-stack` with no data root: nothing was ever started (or **Remove all data** removed it), so there is nothing to stop. Starting the app would only re-create the root's folders.

export type PreLaunch =
	| { action: "continue" }
	| { action: "exit"; code: number }
	/** A pending removal could not be finished: the app does not start on a half-removed root. */
	| { action: "stop"; code: number; folder: string; detail: string };

export interface PreLaunchDeps {
	argv: readonly string[];
	root: string;
	home: string;
	platform: NodeJS.Platform;
	userPath: UserPath;
	exists?: (path: string) => boolean;
	finish?: (input: { root: string; home: string; platform: NodeJS.Platform }) => FinishPending;
	log?: (line: string) => void;
}

export async function preLaunch(deps: PreLaunchDeps): Promise<PreLaunch> {
	const exists = deps.exists ?? existsSync;
	const log = deps.log ?? (() => {});
	const finished = (deps.finish ?? finishPending)({ root: deps.root, home: deps.home, platform: deps.platform });
	if (finished.found) {
		log(`remove-pending: ${finished.removed ? "the data root was removed" : "could not remove the data root"}`);
		if (!finished.removed) return { action: "stop", code: 1, folder: deps.root, detail: finished.error ?? "" };
	}
	if (hasRemoveUserPath(deps.argv)) {
		if (!deps.userPath.supported) return { action: "exit", code: 0 };
		try {
			// The entry is `<root>\tools\shims` whether or not the root is there: a PM who deleted the folder by hand still has the entry.
			await deps.userPath.remove((deps.platform === "win32" ? win32 : posix).join(deps.root, "tools", "shims"));
			return { action: "exit", code: 0 };
		} catch (error) {
			log(`the user PATH entry was not removed: ${(error as Error).message}`);
			return { action: "exit", code: 1 };
		}
	}
	if (hasStopStack(deps.argv) && !exists(deps.root)) return { action: "exit", code: 0 };
	return { action: "continue" };
}
