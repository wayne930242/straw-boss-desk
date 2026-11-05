import { lstat, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

// The two file operations of **Remove all data**: the size the confirmation names, and the deletion of everything in the root but what Chromium holds open.

/**
 * The size of `dir` in bytes: the sum of its regular files, links not followed. It stops at `budgetMs` and answers null, since the tools folder holds tens of thousands of files and a slow disk
 * must not hold the confirmation screen back.
 */
export async function measureBytes(dir: string, options: { budgetMs?: number; now?: () => number } = {}): Promise<number | null> {
	const now = options.now ?? Date.now;
	const deadline = now() + (options.budgetMs ?? 20_000);
	let total = 0;
	const pending: string[] = [dir];
	while (pending.length > 0) {
		if (now() > deadline) return null;
		const current = pending.pop() as string;
		let entries;
		try {
			entries = await readdir(current, { withFileTypes: true });
		} catch {
			continue;
		}
		await Promise.all(
			entries.map(async (entry) => {
				const path = join(current, entry.name);
				if (entry.isDirectory()) pending.push(path);
				else if (entry.isFile()) {
					try {
						total += (await lstat(path)).size;
					} catch {
						// gone while counting
					}
				}
			}),
		);
	}
	return total;
}

export interface DeleteResult {
	/** What could not be deleted, by name, with the first line of why. The cleanup after the app's exit tries again. */
	failed: Array<{ name: string; detail: string }>;
}

/**
 * Deletes every entry of `root` except those named in `keep` (compared without regard to case where the file system is). A link is removed as a link, never followed. A failure does not stop the
 * others: the cleanup that runs after the app has gone deletes the whole root.
 */
export async function deleteChildren(root: string, keep: readonly string[], options: { caseInsensitive: boolean; remove?: (path: string) => Promise<void> } = { caseInsensitive: false }): Promise<DeleteResult> {
	const fold = (name: string): string => (options.caseInsensitive ? name.toLowerCase() : name);
	const kept = new Set(keep.map(fold));
	const remove = options.remove ?? ((path: string) => rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 }));
	const failed: DeleteResult["failed"] = [];
	for (const name of await readdir(root)) {
		if (kept.has(fold(name))) continue;
		try {
			await remove(join(root, name));
		} catch (error) {
			failed.push({ name, detail: (error as Error).message.split(/\r?\n/)[0]?.slice(0, 200) ?? "" });
		}
	}
	return { failed };
}
