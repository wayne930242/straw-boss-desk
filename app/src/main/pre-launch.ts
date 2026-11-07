import { existsSync } from "node:fs";
import { posix, win32 } from "node:path";
import { electronDir } from "./paths.ts";
import type { Processes, UserPath } from "./platform/types.ts";
import { hasRemoveUserPath, hasStopStack } from "./runtime/args.ts";
import { finishPending, pendingOwnerLives, type FinishPending } from "./removal/pending.ts";

// What the app does before anything else: before `app.setPath("userData")`, before the single-instance lock, before a window (spec: Uninstall and data). Three cases are decided here, and
// none of them may leave a file behind in the data root:
//   - `<root>/remove-pending` exists: a **Remove all data** whose cleanup never ran. The root is deleted now, before Chromium opens its profile in it, and the app then starts as on a new machine.
//     Unless the app that wrote the marker still runs (it shows the result and holds the root): then this launch deletes nothing and hands over to it (`handOver`): the running instance raises its
//     window, or opens one for the result if the PM had closed theirs. It never ends silently while the first instance lives (T14R-F001). When the lock turns out free the owner has ended in between, and
//     this launch goes on as if the owner had been gone at the start (`earlyLaunch`, T14R2-F001);
//   - `--remove-user-path`: the uninstaller's call. The app's one user PATH entry is removed through `UserPath` and the app exits;
//   - `--stop-stack` with no data root: nothing was ever started (or **Remove all data** removed it), so there is nothing to stop. Starting the app would only re-create the root's folders.

export type PreLaunch =
	| { action: "continue" }
	| { action: "exit"; code: number }
	/** The app that is removing its data still runs: this launch tells it so (the single-instance lock) and ends. */
	| { action: "handover" }
	/** A pending removal could not be finished: the app does not start on a half-removed root. */
	| { action: "stop"; code: number; folder: string; detail: string };

export interface PreLaunchDeps {
	argv: readonly string[];
	root: string;
	home: string;
	platform: NodeJS.Platform;
	userPath: UserPath;
	/** Reads a process's start token; the owner of a pending removal is looked up with it. */
	processes: Pick<Processes, "inspect">;
	exists?: (path: string) => boolean;
	finish?: (input: { root: string; home: string; platform: NodeJS.Platform }) => FinishPending;
	log?: (line: string) => void;
}

export async function preLaunch(deps: PreLaunchDeps): Promise<PreLaunch> {
	const log = deps.log ?? (() => {});
	if (await pendingOwnerLives(deps.root, (pids) => deps.processes.inspect(pids))) {
		log("remove-pending: the app that is removing its data still runs, so this launch leaves the root alone and hands over to it");
		return { action: "handover" };
	}
	return launchWithoutOwner(deps);
}

/** What `preLaunch` decides once no running app holds the root: finish a pending removal, then the uninstaller's calls and the `--stop-stack` with no root. */
async function launchWithoutOwner(deps: PreLaunchDeps): Promise<Exclude<PreLaunch, { action: "handover" }>> {
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

export interface HandOverDeps {
	/** `<root>/electron`, the user data folder the running app's single-instance lock is keyed on. */
	userData: string;
	exists(path: string): boolean;
	setUserData(path: string): void;
	/** `app.requestSingleInstanceLock`: false when another instance holds it, and that instance has been told (its `second-instance` event). */
	lock(): boolean;
	release(): void;
}

/**
 * The launch that found the owner of a pending removal alive: it asks for the single-instance lock on the owner's user data folder, which only tells the owner to raise its window. It makes no folder
 * of its own: without `electron/` it asks for nothing, and a lock that turns out to be free (the owner ended in between) is let go again. `handed` says whether a running instance was told; `free` means none
 * was, and the caller goes on with the launch (`earlyLaunch`). In the instant between the `exists` check and the lock a folder can still appear, made by Chromium's lock call: the launch that goes on owns it.
 */
export function handOver(deps: HandOverDeps): "handed" | "free" {
	// The owner keeps `electron/` through the whole removal; without it no instance can hold a lock there, and none must be created.
	if (!deps.exists(deps.userData)) return "free";
	deps.setUserData(deps.userData);
	if (deps.lock()) {
		deps.release();
		return "free";
	}
	return "handed";
}

export interface EarlyLaunchDeps extends PreLaunchDeps {
	/** Electron's single-instance lock, as `handOver` uses it. */
	instanceLock: Pick<HandOverDeps, "setUserData" | "lock" | "release">;
}

/** What the app does with the early check: go on to the normal launch, or end with the code (a `stop` is shown to the PM first, by the caller). */
export type EarlyLaunch = { action: "continue" } | { action: "exit"; code: number } | { action: "stop"; code: number; folder: string; detail: string };

/**
 * The whole early check, with the handover inside it. A launch beside the live owner of a pending removal hands over to it and ends (`exit` 0). A lock that turns out free means the owner has ended
 * between the check and the lock, and no instance is left to tell: this launch then does what it would have done had the owner been gone at the start (the marker's root is finished first, so the
 * cleanup that the owner left stops on the missing marker, and no window is lost). It never ends with no window and no owner (T14R2-F001).
 */
export async function earlyLaunch(deps: EarlyLaunchDeps): Promise<EarlyLaunch> {
	const early = await preLaunch(deps);
	if (early.action !== "handover") return early;
	const outcome = handOver({ userData: electronDir(deps.root), exists: deps.exists ?? existsSync, ...deps.instanceLock });
	if (outcome === "handed") return { action: "exit", code: 0 };
	(deps.log ?? (() => {}))("remove-pending: the app that was removing its data has ended, so this launch goes on");
	return launchWithoutOwner(deps);
}
