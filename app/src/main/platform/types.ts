// One interface per concern the two operating systems answer differently (spec: Architecture). `win.ts` and `mac.ts` implement them all;
// `index.ts` picks the pair. Nothing outside this folder branches on the platform for these concerns.

export interface RunOptions {
	/** Written to the child's standard input, then closed. Never put a secret on a command line. */
	stdin?: string;
	/** The child is killed after this long and the result reports `timedOut`. */
	timeoutMs?: number;
	/** The child's working directory. Unlike an argument, it reaches a Windows program as UTF-16, so it may hold characters outside the ANSI code page. */
	cwd?: string;
	/** Added to the runner's base environment for this call. */
	env?: Readonly<Record<string, string>>;
	/** With `env`: the child gets `env` and nothing else, not the runner's base environment merged with it. */
	replaceEnv?: boolean;
	/** The child is killed when this aborts (a quit while it runs); the result then has no exit code. */
	signal?: AbortSignal;
}

export interface RunResult {
	/** Null when the child did not exit by itself (timeout, spawn failure). */
	code: number | null;
	stdout: string;
	stderr: string;
	timedOut?: boolean;
}

/** Runs a program by absolute path, with no shell. Injected so a test can record, fake, or point a call at a scratch HOME. */
export type CommandRunner = (file: string, args: readonly string[], options?: RunOptions) => Promise<RunResult>;

// ---- Locate ----------------------------------------------------------------------------------------------------------

/** OS-provided programs the app calls by absolute path, never by a PATH lookup (a Git for Windows GNU `tar` on the PATH cannot read zip). */
export type SystemTool = "tar" | "powershell" | "reg" | "cmd" | "security" | "ps" | "lsof" | "sh";

export interface Locate {
	/** Absolute path of an OS-provided program. Throws when this platform has none under that name. */
	system(tool: SystemTool): string;
	/**
	 * The first file `name` resolves to along `pathValue`, as the OS resolves it: Windows tries each PATHEXT extension in every folder (a name that
	 * already ends in one is tried as it is); macOS takes an executable file. Null when nothing matches. The caller expands `%VAR%` entries first.
	 */
	onPath(name: string, pathValue: string): string | null;
}

// ---- Processes -------------------------------------------------------------------------------------------------------

export interface ProcessInfo {
	pid: number;
	/** An opaque token for the process's start, equal on two reads of one process and different for a later process with the same pid. Null: gone or unreadable. */
	startTime: string | null;
	/** Full path of the program the process runs (never its command line). Null: gone or unreadable. */
	executable: string | null;
}

export interface Processes {
	/** Start time and executable of each pid, in one call. A pid that is gone comes back with nulls. */
	inspect(pids: readonly number[]): Promise<ProcessInfo[]>;
	/** Every process whose executable lies under `dir` (the leftover listing, spec: Start times). */
	listUnder(dir: string): Promise<ProcessInfo[]>;
	/** Ends the process at once. False when it is already gone. */
	kill(pid: number): boolean;
}

// ---- UserPath --------------------------------------------------------------------------------------------------------

export interface UserPathValue {
	/** The registry type: `ExpandString` is REG_EXPAND_SZ. */
	kind: "ExpandString" | "String";
	/** As stored, `%VAR%` entries unexpanded. */
	value: string;
}

export interface UserPath {
	/** False where the user PATH is not touched (macOS): `read` answers null and the writers change nothing. */
	readonly supported: boolean;
	read(): Promise<UserPathValue | null>;
	/** Puts `entry` first among the user entries, once. */
	ensureFirst(entry: string): Promise<{ changed: boolean }>;
	/** Removes only that exact entry; deletes the value when it was the only one. */
	remove(entry: string): Promise<{ changed: boolean }>;
}

// ---- CredentialStore -------------------------------------------------------------------------------------------------

/** One stored credential, by attributes. `name` is the service gh and glab give the keyring (`gh:github.com`); the secret is never part of it. */
export interface StoreEntry {
	name: string;
	account: string;
	/** UTC, ISO 8601: macOS `mdat` (to the second), Windows `LastWritten` (to 100 ns). Equal on two reads when nothing wrote the entry in between. Empty when the store gave no time: the caller treats that as unreadable, so the entry is foreign. */
	modified: string;
}

export type ProbeResult = { ok: true } | { ok: false; reason: string };

export class CredentialStoreError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CredentialStoreError";
	}
}

export interface CredentialStore {
	/** Writes, reads back, and deletes a throwaway entry. A timeout or any failed step is `ok: false`, never a throw. */
	probe(): Promise<ProbeResult>;
	/**
	 * Every entry whose service is exactly one of `names`, with its account and modification time. An empty array means none. Any failure of the
	 * listing throws `CredentialStoreError`, which the caller treats as a failed probe. No secret is read into the app: macOS prints attributes only;
	 * the Windows helper copies out name, user, and time.
	 */
	list(names: readonly string[]): Promise<StoreEntry[]>;
	/** Deletes one entry by name and account. Throws `CredentialStoreError` when it cannot. */
	delete(entry: { name: string; account: string }): Promise<void>;
}

export interface Platform {
	locate: Locate;
	processes: Processes;
	userPath: UserPath;
	credentials: CredentialStore;
}
