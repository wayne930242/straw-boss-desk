import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { join, posix, win32 } from "node:path";

// `<root>/remove-pending` and the safety checks around deleting a data root (spec: Uninstall and data; Build notes T3-F006). **Remove all data** deletes everything it can, writes this marker, and
// leaves `<root>/electron` (Chromium holds files there open while the app runs) to a detached cleanup that runs after the app's exit. When that cleanup never ran, the marker is still there at the
// next launch, and `finishPending` deletes the root before Chromium opens anything. The marker is read by Node, so it may hold Unicode paths; the detached cleanup never reads it.

export const PENDING_FILE = "remove-pending";
export const FALLBACK_PARENT = ".straw-boss-desk";

export interface PendingMarker {
	schema: 1;
	/** The root's id (first 8 hex digits of the SHA-256 of its real path), which names the fallback folder; null when the layout never fell back. */
	id: string | null;
	/** The fallback folder to delete with the root; null when there is none. Checked again when the marker is used. */
	fallbackDir: string | null;
	/**
	 * The app that wrote the marker, by pid and start token (`Processes.inspect`). While that process lives the root is its own: a second launch must not finish the removal under it. Absent or
	 * null when the start could not be read; a pid alone is no proof (it is given to another program after a reboot), so then nothing is held.
	 */
	owner?: { pid: number; startTime: string } | null;
}

type Pathish = typeof posix;
const pathOf = (platform: NodeJS.Platform): Pathish => (platform === "win32" ? win32 : posix);

/** The id a root's fallback folder is named by (`computeLayout`): the first 8 hex digits of the SHA-256 of the root's real path. */
export const rootId = (realRoot: string): string => createHash("sha256").update(realRoot).digest("hex").slice(0, 8);

/** True when `child` is `parent` or lies below it (case-insensitive on Windows, as the file system is). */
export function isUnder(parent: string, child: string, platform: NodeJS.Platform): boolean {
	const P = pathOf(platform);
	const rel = P.relative(parent, child);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${P.sep}`) && !P.isAbsolute(rel));
}

/**
 * Whether `fallbackDir` is a folder this app made for `realRoot` and may delete: exactly `<home>/.straw-boss-desk/<id>` with `<id>` the root's own. A layout record that was edited by hand, or
 * a marker from another root, cannot point the deletion at a folder of the PM's (T3-F006).
 */
export function fallbackIsOurs(input: { fallbackDir: string; home: string; realRoot: string; platform: NodeJS.Platform }): boolean {
	const P = pathOf(input.platform);
	const id = rootId(input.realRoot);
	const expected = P.join(input.home, FALLBACK_PARENT, id);
	const norm = (p: string): string => (input.platform === "win32" ? P.normalize(p).replace(/[\\/]+$/, "").toLowerCase() : P.normalize(p).replace(/\/+$/, ""));
	return P.isAbsolute(input.fallbackDir) && norm(input.fallbackDir) === norm(expected);
}

/**
 * Refuses a root that is not a data root a removal may delete: not absolute, a filesystem root, the home folder, or a folder that contains the home folder. `root` is never a folder of the
 * PM's work, because the folder step refuses a work folder inside app data and the root is not the home.
 */
export function assertDeletableRoot(root: string, home: string, platform: NodeJS.Platform): void {
	const P = pathOf(platform);
	if (!P.isAbsolute(root)) throw new Error(`the data root is not an absolute path: ${root}`);
	if (P.parse(root).root === P.normalize(root) || P.dirname(P.normalize(root)) === P.normalize(root)) throw new Error(`the data root is a filesystem root: ${root}`);
	if (isUnder(root, home, platform)) throw new Error(`the data root ${root} is, or contains, the home folder`);
	if (P.basename(root) === "") throw new Error(`the data root has no folder name: ${root}`);
}

export function writePending(root: string, marker: PendingMarker): void {
	writeFileSync(join(root, PENDING_FILE), `${JSON.stringify(marker)}\n`, "utf8");
}

export function readPending(root: string): PendingMarker | "unreadable" | null {
	const file = join(root, PENDING_FILE);
	if (!existsSync(file)) return null;
	try {
		const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
		if (typeof parsed !== "object" || parsed === null) return "unreadable";
		const m = parsed as Partial<PendingMarker>;
		if (m.schema !== 1) return "unreadable";
		const owner = m.owner;
		const held = typeof owner === "object" && owner !== null && Number.isInteger(owner.pid) && owner.pid > 0 && typeof owner.startTime === "string" && owner.startTime !== "";
		return { schema: 1, id: typeof m.id === "string" ? m.id : null, fallbackDir: typeof m.fallbackDir === "string" ? m.fallbackDir : null, owner: held ? { pid: owner.pid, startTime: owner.startTime } : null };
	} catch {
		// A marker that cannot be read still says "delete this root"; it just names no fallback folder.
		return "unreadable";
	}
}

/**
 * True while the app that wrote `<root>/remove-pending` still runs: the pid is alive and its start token is the recorded one. The first instance shows the result and holds Chromium's files
 * under the root, so a second launch (a double-click on the shortcut, `open -n` on macOS) must leave the root alone (T14-F005). A marker with no owner, or one whose process is gone or is
 * another program now, holds nothing. Reading a start costs one PowerShell start on Windows, so this runs only when a marker names an owner.
 */
export async function pendingOwnerLives(root: string, inspect: (pids: readonly number[]) => Promise<ReadonlyArray<{ pid: number; startTime: string | null }>>): Promise<boolean> {
	const marker = readPending(root);
	if (marker === null || marker === "unreadable" || marker.owner === undefined || marker.owner === null) return false;
	try {
		const [info] = await inspect([marker.owner.pid]);
		return info !== undefined && info.startTime !== null && info.startTime === marker.owner.startTime;
	} catch {
		// A read that fails proves nothing; the root is then finished as before (the fail-safe direction for a PM who must not be locked out).
		return false;
	}
}

export interface FinishPendingDeps {
	root: string;
	home: string;
	platform: NodeJS.Platform;
	/** Real path of the root, read while it exists. Default `fs.realpathSync.native`. */
	realpath?: (path: string) => string;
	/** Deletes a folder tree. Default `fs.rmSync` with retries. */
	remove?: (path: string) => void;
}

export type FinishPending = { found: false } | { found: true; removed: boolean; fallbackRemoved: boolean; error?: string };

const defaultRemove = (path: string): void => rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });

/**
 * If `<root>/remove-pending` exists, deletes the root (and the marker's fallback folder, when it is the root's own) and says so. Runs before `app.setPath("userData")`, so Chromium has opened
 * nothing in the root. A deletion that fails leaves the marker in place and reports the error: the next launch tries again, and the caller must not start on a half-removed root.
 */
export function finishPending(deps: FinishPendingDeps): FinishPending {
	const marker = readPending(deps.root);
	if (marker === null) return { found: false };
	// The same check as the removal's own: a marker in a folder that is not a data root (a relative path resolved against the cwd, the home folder, a filesystem root) deletes nothing.
	try {
		assertDeletableRoot(deps.root, deps.home, deps.platform);
	} catch (error) {
		return { found: true, removed: false, fallbackRemoved: false, error: (error as Error).message.split(/\r?\n/)[0] ?? "" };
	}
	const remove = deps.remove ?? defaultRemove;
	const realpath = deps.realpath ?? ((p: string) => realpathSync.native(p));
	let fallbackRemoved = false;
	try {
		const fallback = marker === "unreadable" ? null : marker.fallbackDir;
		if (fallback !== null) {
			// The id is computed from the root as it is now, so a marker copied from another root names a folder this root does not own and is ignored.
			const real = realpath(deps.root);
			if (fallbackIsOurs({ fallbackDir: fallback, home: deps.home, realRoot: real, platform: deps.platform })) {
				remove(fallback);
				fallbackRemoved = true;
				// `~/.straw-boss-desk` itself goes only when nothing else lives in it (another root's fallback folder).
				const parent = pathOf(deps.platform).dirname(fallback);
				try {
					if (readdirSync(parent).length === 0) rmdirSync(parent);
				} catch {
					// not empty, or gone
				}
			}
		}
		remove(deps.root);
	} catch (error) {
		return { found: true, removed: false, fallbackRemoved, error: (error as Error).message.split(/\r?\n/)[0] ?? "" };
	}
	// `remove` with force does not fail on a path that is still there for a reason it hid.
	return existsSync(deps.root) ? { found: true, removed: false, fallbackRemoved, error: "the folder is still there after the deletion" } : { found: true, removed: true, fallbackRemoved };
}
