import type { ProjectLinks } from "../../shared/projects.ts";

// The symlink check of the projects step (spec: Projects: symlinks in a repository (Windows)). Under PortableGit's default (`core.symlinks=false`) Git checks a link out as a small text file
// holding the target path, so pi finds a file where it expects a folder of skills. The check only lists the index entries of mode 120000 under the three folders pi reads; it never changes
// `core.symlinks` and never writes to the repository.

/** The folders pi reads from a repository, in the order the listing names them. */
export const LINK_FOLDERS = [".agents", ".pi", ".claude"] as const;
/** At most this many paths are named; the rest are counted. */
export const MAX_LINK_PATHS = 10;

/** The arguments of the listing: staged entries with mode and path, NUL separated, so a path with a space or a Unicode name is read as it is. */
export const linkListing = (): string[] => ["ls-files", "-s", "-z", "--", ...LINK_FOLDERS];

/** The paths of the mode-120000 entries in the output of `git ls-files -s -z`, with `/` separators. */
export function linkPaths(stdout: string): string[] {
	const paths: string[] = [];
	for (const entry of stdout.split("\0")) {
		const m = /^120000 [0-9a-f]{40,64} \d\t(.+)$/s.exec(entry);
		if (m !== null) paths.push(m[1] as string);
	}
	return [...new Set(paths)].sort();
}

/** What the row shows: the first ten paths and how many more. Null when there is none. */
export function summarizeLinks(paths: readonly string[]): ProjectLinks | null {
	if (paths.length === 0) return null;
	return { paths: paths.slice(0, MAX_LINK_PATHS), more: Math.max(0, paths.length - MAX_LINK_PATHS) };
}
