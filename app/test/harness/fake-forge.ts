import { EventEmitter } from "node:events";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CredentialStoreError, type CommandRunner, type CredentialStore, type ProbeResult, type RunOptions, type RunResult, type StoreEntry } from "../../src/main/platform/types.ts";
import type { LoginChild, SpawnLogin } from "../../src/main/accounts/cli.ts";
import { removeHostBlock } from "../../src/main/accounts/forge.ts";

// Stand-ins for the OS credential store and for gh and glab, for the code-host tests. The store keeps entries with a time that moves on every write, as a keychain's `mdat` and Credential Manager's
// `LastWritten` do; the CLIs write and delete entries in it the way the real ones name them. Test code only: nothing here touches a real store or a real login.

const pad = (n: number): string => String(n).padStart(2, "0");

export class FakeStore implements CredentialStore {
	entries: StoreEntry[] = [];
	probeResult: ProbeResult = { ok: true };
	/** A message makes `list` throw it, as a keychain that did not answer does. */
	listError: string | null = null;
	calls: string[] = [];
	/** The next `list` answers what the store held when it was called, but only after this settles (a listing that takes its time). Cleared once used. */
	holdList: Promise<void> | null = null;
	/** The next `probe` waits for this. Cleared once used. */
	holdProbe: Promise<void> | null = null;
	#tick = 0;

	/** A new time on every call, two seconds apart, so a second write always differs (macOS keeps `mdat` to the second). */
	time(): string {
		this.#tick += 2;
		return `2026-11-04T01:${pad(Math.floor(this.#tick / 60))}:${pad(this.#tick % 60)}Z`;
	}

	/** What gh or glab does: creates the entry, or rewrites it in place under the same name with a new time. */
	write(name: string, account = "", modified: string = this.time()): void {
		const found = this.entries.find((e) => e.name === name && e.account === account);
		if (found) found.modified = modified;
		else this.entries.push({ name, account, modified });
	}

	get(name: string, account = ""): StoreEntry | undefined {
		return this.entries.find((e) => e.name === name && e.account === account);
	}

	async probe(): Promise<ProbeResult> {
		this.calls.push("probe");
		const hold = this.holdProbe;
		this.holdProbe = null;
		if (hold !== null) await hold;
		return this.probeResult;
	}

	async list(names: readonly string[]): Promise<StoreEntry[]> {
		this.calls.push("list");
		if (this.listError !== null) throw new CredentialStoreError(this.listError);
		const snapshot = this.entries.filter((e) => names.includes(e.name)).map((e) => ({ ...e }));
		const hold = this.holdList;
		this.holdList = null;
		if (hold !== null) await hold;
		return snapshot;
	}

	async delete({ name, account }: { name: string; account: string }): Promise<void> {
		this.calls.push(`delete ${name}`);
		const before = this.entries.length;
		this.entries = this.entries.filter((e) => !(e.name === name && e.account === account));
		if (this.entries.length === before) throw new CredentialStoreError(`no such entry ${name}`);
	}
}

export interface CliCall {
	cli: "gh" | "glab";
	args: string[];
	stdin?: string;
	env?: Record<string, string>;
}

export interface FakeCliOptions {
	/** gh's `tokenSource` in `auth status --json hosts`; null makes the status fail. */
	tokenSource?: string | null;
	/** glab's `auth status` exit code. */
	glabStatusExit?: number;
	/** glab's login output and exit code. */
	glabLogin?: { code: number; stderr: string };
	/** What a login does to the store besides writing its entry. */
	onGlabLogin?: (host: string) => void;
	/** The logout's exit code. */
	logoutExit?: number;
	/** The logout leaves the entries in the store (a logout that did not finish). */
	logoutKeepsEntries?: boolean;
	/** glab's login waits for this after it wrote its entry (a login that takes its time). */
	holdGlabLogin?: Promise<void>;
}

const hostArg = (args: readonly string[]): string => args[args.indexOf("--hostname") + 1] ?? "";

/** gh and glab as `CommandRunner`: the one-shot calls the sign-in makes. Every call is recorded; a token on standard input is recorded as `stdin`. */
export function fakeRun(store: FakeStore, options: FakeCliOptions = {}): { run: CommandRunner; calls: CliCall[] } {
	const calls: CliCall[] = [];
	const run: CommandRunner = async (file, args, runOptions?: RunOptions): Promise<RunResult> => {
		const cli = /glab(\.exe)?$/.test(file) ? "glab" : "gh";
		calls.push({ cli, args: [...args], ...(runOptions?.stdin !== undefined ? { stdin: runOptions.stdin } : {}), ...(runOptions?.env !== undefined ? { env: runOptions.env } : {}) });
		const host = hostArg(args);
		const verb = args.slice(0, 2).join(" ");
		if (verb === "auth login" && cli === "glab") {
			const login = options.glabLogin ?? { code: 0, stderr: "" };
			if (login.code === 0) {
				store.write(`glab:${host}:token`, "");
				options.onGlabLogin?.(host);
				if (options.holdGlabLogin !== undefined) await options.holdGlabLogin;
			}
			return { code: login.code, stdout: login.code === 0 ? "Logged in\n" : "", stderr: login.stderr };
		}
		if (verb === "auth status") {
			if (cli === "glab") return { code: options.glabStatusExit ?? 0, stdout: "", stderr: "" };
			const source = options.tokenSource === undefined ? "keyring" : options.tokenSource;
			if (source === null) return { code: 1, stdout: "", stderr: "not logged in" };
			return { code: 0, stdout: JSON.stringify({ hosts: { [host]: [{ state: "success", active: true, host, login: "someone", tokenSource: source }] } }), stderr: "" };
		}
		if (verb === "auth logout") {
			const code = options.logoutExit ?? 0;
			if (code === 0 && options.logoutKeepsEntries !== true) store.entries = store.entries.filter((e) => !(cli === "glab" ? e.name === `glab:${host}:token` || e.name === `glab:${host}` : e.name === `gh:${host}` || e.name === `gh:_refreshable:${host}`));
			// What the real CLIs do besides the store: the host leaves their own file, a plain-text token with it.
			const dir = runOptions?.env?.[cli === "glab" ? "GLAB_CONFIG_DIR" : "GH_CONFIG_DIR"];
			if (code === 0 && dir !== undefined) {
				const file = join(dir, cli === "glab" ? "config.yml" : "hosts.yml");
				if (existsSync(file)) writeFileSync(file, removeHostBlock(readFileSync(file, "utf8"), host, cli === "glab" ? ["hosts"] : []).text);
			}
			return { code, stdout: "", stderr: code === 0 ? "" : "logout failed" };
		}
		return { code: 1, stdout: "", stderr: `unexpected call ${verb}` };
	};
	return { run, calls };
}

/** A running `gh auth login`: the test says what it printed and how it ended. */
export class FakeLogin extends EventEmitter {
	readonly stdout = new EventEmitter();
	readonly stderr = new EventEmitter();
	killed = false;
	kill(): boolean {
		this.killed = true;
		return true;
	}
	say(text: string): void {
		this.stderr.emit("data", Buffer.from(text));
	}
	finish(code: number | null): void {
		this.emit("exit", code, null);
	}
}

export function fakeSpawn(): { spawn: SpawnLogin; started: Array<{ file: string; args: string[]; env: Record<string, string>; child: FakeLogin }> } {
	const started: Array<{ file: string; args: string[]; env: Record<string, string>; child: FakeLogin }> = [];
	const spawn: SpawnLogin = (file, args, options) => {
		const child = new FakeLogin();
		started.push({ file, args: [...args], env: options.env, child });
		return child as unknown as LoginChild;
	};
	return { spawn, started };
}
