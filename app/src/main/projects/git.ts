import type { RuntimeEvent } from "../runtime/log.ts";
import type { RunResult } from "../platform/types.ts";
import { linkListing } from "./links.ts";

// The Git calls of the projects step, through the app's own Git with the constructed environment (the private `gitconfig`, the forge credential helpers, no terminal prompt). Every call is one
// event in `logs/shell.jsonl` (its arguments and exit code, never its output beyond the caller's own redacted line), so a test can say which Git ran and which did not.

export type GitExec = (args: readonly string[], options: { cwd?: string; timeoutMs: number; signal?: AbortSignal; env?: Readonly<Record<string, string>> }) => Promise<RunResult>;

/**
 * What the projects step reads from Git's words (`Not a valid ref` for a missing branch, the causes of a failed clone) is Git's English text, which a localized Git translates (Git for Windows follows the
 * Windows language, and a PM's `LANG` passes through on macOS). The C locale for these calls alone gives the words the code matches; `LANGUAGE` is cleared of any translation list too (R12-F005).
 */
export const GIT_PARSED_LOCALE: Readonly<Record<string, string>> = { LC_ALL: "C", LANGUAGE: "C" };

/** The environment of one Git call: the app's Git environment, then what the call asks for, which wins over a locale that came through. */
export const callEnv = (base: Readonly<Record<string, string>>, asked: Readonly<Record<string, string>> | undefined): Record<string, string> => ({ ...base, ...(asked ?? {}) });

export const CLONE_MS = 45 * 60_000;
export const FETCH_MS = 15 * 60_000;
export const QUICK_MS = 60_000;

export type GitLog = RuntimeEvent;

export class ProjectGit {
	readonly #exec: GitExec;
	readonly #log: GitLog;
	readonly #signal: () => AbortSignal | undefined;

	constructor(exec: GitExec, log: GitLog, signal: () => AbortSignal | undefined = () => undefined) {
		this.#exec = exec;
		this.#log = log;
		this.#signal = signal;
	}

	async #run(args: readonly string[], timeoutMs: number, cwd?: string): Promise<RunResult> {
		const signal = this.#signal();
		const result = await this.#exec(args, { timeoutMs, env: GIT_PARSED_LOCALE, ...(cwd !== undefined ? { cwd } : {}), ...(signal !== undefined ? { signal } : {}) });
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

	/** True when `HEAD` names a commit. A clone that was cut short has none (Git exits 1 and says nothing), and a folder like that is not a repository to reuse. Throws when Git cannot say. */
	async hasCommit(dir: string): Promise<boolean> {
		const result = await this.#run(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], QUICK_MS, dir);
		if (result.code === 0) return true;
		if (result.code === 1) return false;
		throw new Error(`git rev-parse failed (exit ${result.code}): ${result.stderr.trim().split(/\r?\n/)[0] ?? ""}`);
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
