import type { RunResult } from "../platform/types.ts";
import { linkListing } from "./links.ts";

// The Git calls of the projects step, through the app's own Git with the constructed environment (the private `gitconfig`, the forge credential helpers, no terminal prompt). Every call is one
// event in `logs/shell.jsonl` (its arguments and exit code, never its output beyond the caller's own redacted line), so a test can say which Git ran and which did not.

export type GitExec = (args: readonly string[], options: { cwd?: string; timeoutMs: number; signal?: AbortSignal }) => Promise<RunResult>;

export const CLONE_MS = 45 * 60_000;
export const FETCH_MS = 15 * 60_000;
export const QUICK_MS = 60_000;

export type GitLog = (fields: Record<string, unknown>) => void;

export class ProjectGit {
	readonly #exec: GitExec;
	readonly #log: GitLog;
	readonly #signal: AbortSignal | undefined;

	constructor(exec: GitExec, log: GitLog, signal?: AbortSignal) {
		this.#exec = exec;
		this.#log = log;
		this.#signal = signal;
	}

	async #run(args: readonly string[], timeoutMs: number, cwd?: string): Promise<RunResult> {
		const result = await this.#exec(args, { timeoutMs, ...(cwd !== undefined ? { cwd } : {}), ...(this.#signal !== undefined ? { signal: this.#signal } : {}) });
		this.#log({ event: "project-git", args: [...args], code: result.code, timedOut: result.timedOut === true });
		return result;
	}

	/** `git clone -- <url> <target>`, run from the work folder. */
	clone(url: string, target: string, workFolder: string): Promise<RunResult> {
		return this.#run(["clone", "--", url, target], CLONE_MS, workFolder);
	}

	fetch(dir: string): Promise<RunResult> {
		return this.#run(["fetch", "--prune", "origin"], FETCH_MS, dir);
	}

	/** The raw `remote.origin.url` of the repository in `dir` (not `remote get-url`, which would show an `insteadOf` rewrite): null when `origin` is not set; throws when Git cannot say. */
	async originOf(dir: string): Promise<string | null> {
		const result = await this.#run(["config", "--get", "remote.origin.url"], QUICK_MS, dir);
		if (result.code === 0) return result.stdout.trim() === "" ? null : result.stdout.trim();
		if (result.code === 1 && result.stderr.trim() === "") return null;
		throw new Error(`git config failed (exit ${result.code}): ${result.stderr.trim().split(/\r?\n/)[0] ?? ""}`);
	}

	/** `git remote set-head origin <branch>`: `origin/HEAD` then points at that branch. Git refuses a branch `origin` does not have ("Not a valid ref"). */
	setHead(dir: string, branch: string): Promise<RunResult> {
		return this.#run(["remote", "set-head", "origin", branch], QUICK_MS, dir);
	}

	/** The staged entries under the folders pi reads, for the symlink check (Windows only). */
	linkEntries(dir: string): Promise<RunResult> {
		return this.#run(linkListing(), QUICK_MS, dir);
	}
}

/** What a failed `clone` or `fetch` said, as a cause the page words. */
export function cloneCause(result: RunResult): "network" | "auth" | "not-found" | "other" {
	if (result.timedOut === true) return "network";
	const text = `${result.stderr}\n${result.stdout}`;
	if (/Authentication failed|could not read (Username|Password)|terminal prompts disabled|HTTP Basic: Access denied|The requested URL returned error: 40[13]|Permission denied|invalid credentials|HTTP 40[13]/i.test(text)) return "auth";
	if (/Repository not found|repository .* not found|does not appear to be a git repository|The requested URL returned error: 404|HTTP 404/i.test(text)) return "not-found";
	if (/Could not resolve host|Failed to connect|Connection (timed out|refused|reset)|Operation timed out|SSL|certificate|unable to access|early EOF|RPC failed|Network is unreachable|TLS/i.test(text)) return "network";
	return "other";
}
