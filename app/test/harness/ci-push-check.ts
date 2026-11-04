// The CI push check of task 10 (boss decision 2026-11-04): the stored GitLab token must work through Git's credential helper, shown by one branch pushed to the account's private test project
// and deleted again. The account is the boss's own, so the rules here are narrow and enforced in one place (`#guard`):
//   - only branches named `sbd-ci-*` are ever pushed or deleted;
//   - the project's default branch (`sbd-ci-mw1lovby-21505`, made by the first CI run when the project was empty, and any branch the project reports as its HEAD) is never touched;
//   - nothing of the project's settings is touched, and a project with no branch at all is only read (a first branch would become a default branch that cannot be deleted);
//   - one fixed branch per OS, so what a killed run leaves is bounded to two names; the run first sweeps every other `sbd-ci-*` branch, then pushes its own and deletes it in a `finally`.
// Test code only. `git` is injected, so the rules run without a network.

/** The default branch of the test project, made by the first CI run (04:12Z, 2026-11-04). It stays for good. */
export const DEFAULT_BRANCH = "sbd-ci-mw1lovby-21505";
export const CI_PREFIX = "sbd-ci-";
/** The branch of each OS: the two jobs of one run may use the project at the same time, so a run never sweeps the other OS's name. */
export const BRANCH_OF = { win32: "sbd-ci-windows", darwin: "sbd-ci-macos" } as const;

export interface GitResult {
	code: number | null;
	stdout: string;
	stderr?: string;
}
export type GitRun = (args: string[], timeoutMs?: number) => Promise<GitResult>;

export interface Listing {
	/** Every branch of the project, by name. */
	heads: string[];
	/** The branch HEAD points at, when the project says. */
	head: string | null;
}

/** Reads `git ls-remote --symref <url> HEAD "refs/heads/*"`: the lines `ref: refs/heads/<name>\tHEAD` and `<sha>\trefs/heads/<name>`. */
export function parseListing(stdout: string): Listing {
	const heads: string[] = [];
	let head: string | null = null;
	for (const line of stdout.split(/\r?\n/)) {
		const symref = /^ref:\s+refs\/heads\/(\S+)\s+HEAD$/.exec(line.trim());
		if (symref !== null) head = symref[1] as string;
		const ref = /^[0-9a-f]{7,64}\s+refs\/heads\/(\S+)$/.exec(line.trim());
		if (ref !== null) heads.push(ref[1] as string);
	}
	return { heads, head };
}

/** The branches the sweep deletes: `sbd-ci-*` ones, not the default branch (named, or reported as HEAD), and not the other OS's own name. */
export function sweepTargets(listing: Listing, { own }: { own: string }): string[] {
	const others = Object.values(BRANCH_OF).filter((name) => name !== own);
	return listing.heads.filter((name) => name.startsWith(CI_PREFIX) && name !== DEFAULT_BRANCH && name !== listing.head && !others.includes(name as never));
}

export interface PushCheckResult {
	/** The project had no branch: only read. */
	skipped: boolean;
	swept: string[];
	/** Old branches the sweep could not delete. */
	sweepFailed: string[];
	pushed: boolean;
}

export interface PushCheckOptions {
	git: GitRun;
	project: string;
	/** This run's own branch, one of `BRANCH_OF`. */
	branch: string;
	log?: (line: string) => void;
}

/** Throws unless `name` may be pushed or deleted. The one place the rules above are enforced. */
function guard(name: string, listing: Listing | null): void {
	if (!name.startsWith(CI_PREFIX)) throw new Error(`refusing to touch '${name}': not an ${CI_PREFIX}* branch`);
	if (name === DEFAULT_BRANCH || (listing !== null && name === listing.head)) throw new Error(`refusing to touch '${name}': it is the project's default branch`);
	if (name.includes("*") || name.includes(" ") || name.includes(":")) throw new Error(`refusing to touch '${name}': not a plain branch name`);
}

export async function runPushCheck({ git, project, branch, log = () => undefined }: PushCheckOptions): Promise<PushCheckResult> {
	guard(branch, null);
	const listed = await git(["ls-remote", "--symref", project, "HEAD", "refs/heads/*"]);
	if (listed.code !== 0) throw new Error(`ls-remote of the private test project exited ${listed.code} (the credential helper gave no token)`);
	const listing = parseListing(listed.stdout);
	guard(branch, listing);
	if (listing.heads.length === 0) {
		log("push check read the test project; it has no branch, so nothing was pushed (a first branch could not be deleted again)");
		return { skipped: true, swept: [], sweepFailed: [], pushed: false };
	}

	// Sweep first: whatever an earlier run left (cancelled between the push and the delete, a lost runner) goes before this run adds its own.
	const swept: string[] = [];
	const sweepFailed: string[] = [];
	for (const stale of sweepTargets(listing, { own: branch })) {
		guard(stale, listing);
		const removed = await git(["push", project, "--delete", stale]);
		(removed.code === 0 ? swept : sweepFailed).push(stale);
	}
	log(`push check swept ${swept.length} old ${CI_PREFIX}* branch(es)${swept.length > 0 ? ` (${swept.join(", ")})` : ""}${sweepFailed.length > 0 ? `; could not delete ${sweepFailed.join(", ")}` : ""}; the default branch ${listing.head ?? DEFAULT_BRANCH} was not touched`);

	let pushed = false;
	let present = false;
	try {
		// `--force`: this run's own fixed name may be left from a run that was killed; it is the only ref the force can reach.
		const push = await git(["push", "--force", project, `HEAD:refs/heads/${branch}`]);
		pushed = push.code === 0;
		if (!pushed) throw new Error(`push exited ${push.code}`);
		const there = await git(["ls-remote", "--heads", project, branch]);
		if (!there.stdout.includes(branch)) throw new Error("the pushed branch is not on the project");
	} finally {
		// In every case, also when the push reported a failure after the server took the branch: look, and delete what is there.
		const look = await git(["ls-remote", "--heads", project, branch]).catch(() => ({ code: 1, stdout: "" }) as GitResult);
		present = look.code !== 0 || look.stdout.includes(branch);
		if (pushed || present) {
			const removed = await git(["push", project, "--delete", branch]);
			if (removed.code === 0) present = false;
			else {
				const again = await git(["ls-remote", "--heads", project, branch]).catch(() => ({ code: 1, stdout: "" }) as GitResult);
				present = again.code !== 0 || again.stdout.includes(branch);
				if (present) log(`push check could not delete ${branch}: the delete exited ${removed.code}`);
			}
		}
	}
	if (present) throw new Error(`the branch ${branch} is still on the project (the next run sweeps it)`);
	return { skipped: false, swept, sweepFailed, pushed };
}
