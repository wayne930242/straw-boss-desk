import { spawn } from "node:child_process";
import type { EnvMap } from "../env.ts";
import { buildEnv } from "../env.ts";
import type { CurrentTools, Layout } from "../paths.ts";
import type { CommandRunner } from "../platform/types.ts";
import type { RuntimeEvent } from "../runtime/log.ts";
import type { ClaudeAction, ClaudeFlow, ClaudeState, ClaudeView } from "../../shared/accounts.ts";
import { loginLine, type LoginChild } from "./cli.ts";
import { hideSecrets } from "./token-search.ts";

// The Claude sign-in (spec: First run, step 7; Secrets). The login is `claude auth login` of the Agent SDK's bundled executable with the app's own `CLAUDE_CONFIG_DIR`: the browser does the
// sign-in; the screen shows the address the CLI printed for a browser that did not open, and a masked field for a code when the CLI asks for one. The code goes over IPC to main and from there to the
// CLI's standard input, under the GitLab token's rules: never on a command line, never in a log, kept in memory only until the login has ended (so the redactor can hide it if the CLI echoes it), and
// cleared from the page at once. Done when the CLI's own status says signed in. It knows no Electron: the process spawn, the browser and the clipboard come in as dependencies.
//
// Where the login ends up is Claude Code's choice (spec: Secrets): on macOS a Keychain item whose name carries a hash of `CLAUDE_CONFIG_DIR`, so it is never the PM's own; on Windows a plain-text file in
// the app's own Claude folder, which the boss accepted for the pilot (Open for the boss, item 9). Nothing here reads or writes either: the CLI is the only program that touches them.

/** The part of a spawned `claude` the login uses: the output, the exit, and the standard input the code is written to. */
export interface ClaudeChild extends LoginChild {
	stdin: { write(chunk: string, callback?: (error?: Error | null) => void): unknown; end(): unknown; on?(event: "error", listener: (error: Error) => void): unknown } | null;
}

export type SpawnClaude = (file: string, args: readonly string[], options: { env: Record<string, string> }) => ClaudeChild;

/** The production spawn: no shell, no window, and a standard input the code can be written to. */
export const spawnClaude: SpawnClaude = (file, args, options) =>
	// SAFETY: a `ChildProcess` has every member of `ClaudeChild`; the cast only narrows `on` and `kill`'s overloads to the calls the sign-in makes.
	spawn(file, [...args], { env: options.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true }) as unknown as ClaudeChild;

/** The `claude` executable and any leading arguments. A development build's test stand-in answers here too (`SBD_TEST_CLAUDE_CMD`), so the sign-in is proved without an account. */
export interface ClaudeCommand {
	file: string;
	args: readonly string[];
}

/**
 * The stand-in `claude` of the e2e (`SBD_TEST_CLAUDE_CMD`: a JSON array, the program first, then its leading arguments). Only a development build asks for it (`index.ts`), as it asks for
 * `SBD_TEST_WSL_BASH`; a release build never reads the variable. Null for an unset or malformed value.
 */
export function testClaudeCommand(env: Readonly<Record<string, string | undefined>>): ClaudeCommand | null {
	const raw = env.SBD_TEST_CLAUDE_CMD;
	if (raw === undefined || raw === "") return null;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every((p): p is string => typeof p === "string" && p !== "")) return null;
		const [file, ...args] = parsed as string[];
		return { file: file as string, args };
	} catch {
		return null;
	}
}

export interface ClaudeAccountsDeps {
	layout: Layout;
	/** One-shot CLI calls (status, logout). */
	run: CommandRunner;
	/** The login, which runs until the person has signed in. */
	spawn: SpawnClaude;
	appEnv: Readonly<Record<string, string | undefined>>;
	/** The active tool versions; null before the install is complete. */
	current(): CurrentTools | null;
	/** The executable, or null when the `claude` stage has not run. */
	command(): ClaudeCommand | null;
	proxyEnv?(): Promise<Record<string, string>>;
	log: RuntimeEvent;
	openExternal(url: string): void;
	writeClipboard(text: string): void;
	/** Makes main's redactor hide `value` in every log until `release` (the code in flight). */
	hold?(value: string): void;
	release?(value: string): void;
	/** How long a login may wait for the browser (default 15 minutes). */
	loginWaitMs?: number;
	/** The limit of a status or a logout call (default 60 s). */
	callMs?: number;
	setTimer?: (fn: () => void, ms: number) => unknown;
	clearTimer?: (timer: unknown) => void;
}

const LOGIN_WAIT_MS = 15 * 60_000;
const CALL_MS = 60_000;
/** The most of the CLI's output kept for reading the address and the prompt. */
const OUTPUT_KEEP = 20_000;

/** The phases in which an attempt is under way and nothing else may start. */
const BUSY = ["checking", "starting", "browser", "working"];

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
export const stripAnsi = (text: string): string => text.replace(ANSI, "");

/** The address the CLI prints for a browser that did not open: the one after "visit:" or "Sign in at:", else the first https address. Null when it printed none, or one that is not https. */
export function parseSignInUrl(text: string): string | null {
	const plain = stripAnsi(text);
	const after = /(?:visit|sign in at)\s*:?\s*(https:\/\/[^\s'"<>]+)/i.exec(plain)?.[1];
	const found = after ?? /(https:\/\/[^\s'"<>]+)/.exec(plain)?.[1];
	if (found === undefined) return null;
	try {
		const url = new URL(found);
		return url.protocol === "https:" ? url.href : null;
	} catch {
		return null;
	}
}

/** True when the CLI asks to be given a code ("Paste code here if prompted >"). */
/** The CLI's answer to a code it cannot take (`Invalid code. Please make sure the full code was copied.`): said on a line of its own while it goes on waiting. */
export const refusesCode = (text: string): boolean => /invalid code|incorrect code|code (?:is )?(?:not valid|expired)|full code was copied/i.test(stripAnsi(text));

export const asksForCode = (text: string): boolean => /paste code here/i.test(stripAnsi(text));

/** The `loggedIn` field of `claude auth status --json`: true, false, or null when the output is not that JSON. */
export function parseStatus(stdout: string): boolean | null {
	const start = stdout.indexOf("{");
	if (start < 0) return null;
	try {
		const parsed: unknown = JSON.parse(stdout.slice(start, stdout.lastIndexOf("}") + 1));
		if (typeof parsed !== "object" || parsed === null) return null;
		const loggedIn = (parsed as Record<string, unknown>).loggedIn;
		return typeof loggedIn === "boolean" ? loggedIn : null;
	} catch {
		return null;
	}
}

interface Slot {
	flow: ClaudeFlow;
	state: ClaudeState;
	child: LoginChild | null;
	stdin: ClaudeChild["stdin"];
	timer: unknown;
	/** The CLI's own address for a browser that did not open; main opens only this one. */
	url: string | null;
	/** Codes handed to the CLI in this attempt; held for the redactor until the attempt ends. */
	codes: string[];
	/** The CLI's output so far (the last `OUTPUT_KEEP` characters), for the address and the prompt. */
	output: string;
	codeSent: boolean;
	/** The CLI answered the last code with a refusal and still waits (a line it cannot read as `code#state`): the field is offered again. */
	codeRefused: boolean;
	attempt: number;
}

export class ClaudeAccounts {
	readonly #d: ClaudeAccountsDeps;
	readonly #slot: Slot = { flow: { phase: "idle" }, state: "unknown", child: null, stdin: null, timer: null, url: null, codes: [], output: "", codeSent: false, codeRefused: false, attempt: 0 };
	readonly #listeners = new Set<() => void>();
	readonly #signedIn = new Set<() => void>();
	readonly #setTimer: (fn: () => void, ms: number) => unknown;
	readonly #clearTimer: (timer: unknown) => void;
	readonly #inflight = new Set<Promise<unknown>>();
	#disposed = false;

	constructor(deps: ClaudeAccountsDeps) {
		this.#d = deps;
		this.#setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
		this.#clearTimer = deps.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
	}

	onChange(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/** Called when a sign-in ended with the CLI's status saying signed in (the wizard takes Claude off its list of sign-ins put off). */
	onSignedIn(listener: () => void): () => void {
		this.#signedIn.add(listener);
		return () => this.#signedIn.delete(listener);
	}

	#emit(): void {
		for (const l of this.#listeners) l();
	}

	#set(flow: ClaudeFlow): void {
		this.#slot.flow = flow;
		this.#emit();
	}

	view(): ClaudeView {
		return { state: this.#slot.state, storage: this.#d.layout.platform === "win32" ? "file" : "keychain", flow: this.#slot.flow };
	}

	get flow(): ClaudeFlow {
		return this.#slot.flow;
	}

	get state(): ClaudeState {
		return this.#slot.state;
	}

	#track<T>(work: Promise<T>): Promise<T> {
		this.#inflight.add(work);
		const done = (): void => void this.#inflight.delete(work);
		work.then(done, done);
		return work;
	}

	async #env(): Promise<{ file: string; args: readonly string[]; env: EnvMap } | null> {
		const current = this.#d.current();
		const command = this.#d.command();
		if (current === null || command === null) return null;
		let proxyEnv: Record<string, string> = {};
		try {
			proxyEnv = (await this.#d.proxyEnv?.()) ?? {};
		} catch {
			proxyEnv = {};
		}
		// `buildEnv` sets the app's `CLAUDE_CONFIG_DIR`, the telemetry switches, and never carries `CLAUDE_SECURESTORAGE_CONFIG_DIR` (it would move the login onto another Keychain name; spec: Secrets).
		return { file: command.file, args: command.args, env: { ...proxyEnv, ...buildEnv({ layout: this.#d.layout, current, appEnv: this.#d.appEnv }) } };
	}

	// ---- the status ----------------------------------------------------------------------------------------------------

	/** What the CLI's own status says now. */
	async #status(): Promise<{ loggedIn: boolean | null; detail: string }> {
		const prepared = await this.#env();
		if (prepared === null) return { loggedIn: null, detail: "claude is not installed" };
		const result = await this.#d.run(prepared.file, [...prepared.args, "auth", "status", "--json"], { env: prepared.env, replaceEnv: true, timeoutMs: this.#d.callMs ?? CALL_MS });
		const loggedIn = result.timedOut ? null : parseStatus(result.stdout);
		this.#d.log({ event: "claude-status", exit: result.code, loggedIn, ...(result.timedOut ? { timedOut: true } : {}) });
		return { loggedIn, detail: loggedIn === null ? hideSecrets(loginLine(`${result.stdout}\n${result.stderr}`)) : "" };
	}

	/** Reads the status for the row: the wizard's step and settings call it when they open. A login under way is left alone. */
	async refresh(): Promise<void> {
		const slot = this.#slot;
		if (BUSY.includes(slot.flow.phase)) return;
		const attempt = ++slot.attempt;
		this.#set({ phase: "checking" });
		await this.#track(
			this.#status().then((status) => {
				if (slot.attempt !== attempt) return;
				slot.state = status.loggedIn === null ? "unknown" : status.loggedIn ? "signed-in" : "not-signed-in";
				this.#set({ phase: "idle" });
			}),
		).catch((error: Error) => {
			if (slot.attempt !== attempt) return;
			this.#d.log({ event: "claude-status-failed", detail: loginLine(String(error.message)) });
			slot.state = "unknown";
			this.#set({ phase: "idle" });
		});
	}

	// ---- the login -------------------------------------------------------------------------------------------------------

	async start(): Promise<void> {
		const slot = this.#slot;
		if (BUSY.includes(slot.flow.phase) || slot.child !== null || this.#disposed) return;
		const attempt = ++slot.attempt;
		this.#set({ phase: "starting" });
		const prepared = await this.#env();
		if (slot.attempt !== attempt) return;
		if (prepared === null) {
			this.#set({ phase: "failed", detail: "claude is not installed" });
			return;
		}
		// A quit that began while the environment was built starts no login.
		if (this.#disposed) {
			this.#set({ phase: "idle" });
			return;
		}
		const args = [...prepared.args, "auth", "login"];
		this.#d.log({ event: "claude-login-start", args: ["auth", "login"] });
		let child: ClaudeChild;
		try {
			child = this.#d.spawn(prepared.file, args, { env: prepared.env });
		} catch (error) {
			this.#set({ phase: "failed", detail: loginLine(String((error as Error).message)) });
			return;
		}
		slot.child = child;
		slot.stdin = child.stdin;
		slot.url = null;
		slot.codes = [];
		slot.output = "";
		slot.codeSent = false;
		slot.codeRefused = false;
		// A closed standard input (the CLI ended while a code was on its way) must not throw in main.
		child.stdin?.on?.("error", () => undefined);
		const take = (chunk: Buffer | string): void => {
			// Output can still arrive after `exit` (the pipes may be open): by then the attempt has ended and its phase is final (R11-F005).
			if (slot.attempt !== attempt || slot.child !== child) return;
			const text = chunk.toString();
			slot.output = `${slot.output}${text}`.slice(-OUTPUT_KEEP);
			// The CLI answers a line it cannot read as `code#state` with a refusal and keeps waiting: the field comes back for another code (R11-F003).
			if (slot.codeSent && refusesCode(text)) {
				slot.codeSent = false;
				slot.codeRefused = true;
			}
			this.#showBrowser();
		};
		child.stdout?.on("data", take);
		child.stderr?.on("data", take);
		slot.timer = this.#setTimer(() => {
			if (slot.attempt !== attempt || slot.child !== child) return;
			slot.attempt++;
			child.kill();
			this.#end(slot);
			this.#d.log({ event: "claude-login-timeout" });
			this.#set({ phase: "timeout" });
		}, this.#d.loginWaitMs ?? LOGIN_WAIT_MS);
		child.on("error", (error) => {
			if (slot.attempt !== attempt) return;
			slot.attempt++;
			const hidden = hideSecrets(loginLine(error.message), slot.codes);
			this.#end(slot);
			this.#set({ phase: "failed", detail: hidden });
		});
		child.on("exit", (code) => {
			if (slot.attempt !== attempt) return;
			const said = hideSecrets(loginLine(slot.output), slot.codes);
			this.#end(slot);
			this.#d.log({ event: "claude-login-exit", exit: code });
			if (code !== 0) {
				this.#set({ phase: "failed", detail: said });
				return;
			}
			this.#set({ phase: "working" });
			void this.#track(this.#afterLogin(attempt)).catch((error: Error) => {
				if (slot.attempt !== attempt) return;
				this.#set({ phase: "unverified", detail: loginLine(String(error.message)) });
			});
		});
	}

	/** The page's view of a login that waits: what the CLI printed so far, read for the address and for the request of a code. */
	#showBrowser(): void {
		const slot = this.#slot;
		slot.url = parseSignInUrl(slot.output);
		this.#set({ phase: "browser", url: slot.url, codeAsked: asksForCode(slot.output), codeSent: slot.codeSent, ...(slot.codeRefused ? { codeRefused: true } : {}) });
	}

	/** The CLI ended its login well: done when its own status says signed in. */
	async #afterLogin(attempt: number): Promise<void> {
		const slot = this.#slot;
		const status = await this.#status();
		if (slot.attempt !== attempt) return;
		if (status.loggedIn === true) {
			slot.state = "signed-in";
			this.#set({ phase: "done" });
			for (const l of this.#signedIn) l();
			return;
		}
		slot.state = status.loggedIn === false ? "not-signed-in" : "unknown";
		this.#set({ phase: "unverified", detail: status.loggedIn === false ? "claude auth status says not logged in" : status.detail });
	}

	/** Frees what an attempt held: the timer, the child, the standard input, and the codes (the redactor forgets them). */
	#end(slot: Slot): void {
		if (slot.timer !== null) this.#clearTimer(slot.timer);
		slot.timer = null;
		slot.child = null;
		slot.stdin = null;
		for (const code of slot.codes) this.#d.release?.(code);
		slot.codes = [];
		slot.output = "";
		slot.codeSent = false;
		slot.codeRefused = false;
	}

	/**
	 * The code from the masked field: written to the CLI's standard input with a line end, once, and only while the CLI has asked for one. It is held in memory for the redactor until the login
	 * ends and appears nowhere else: not in a log, an event, the view, or a command line.
	 */
	sendCode(code: string): void {
		const slot = this.#slot;
		const value = code.trim();
		const flow = slot.flow;
		if (value === "" || flow.phase !== "browser" || !flow.codeAsked || flow.codeSent || slot.stdin === null) return;
		try {
			this.#d.hold?.(value);
		} catch {
			// A value too short for the redactor to take is still sent; the CLI refuses it.
		}
		slot.codes.push(value);
		slot.stdin.write(`${value}\n`, () => undefined);
		this.#d.log({ event: "claude-code-sent" });
		slot.codeSent = true;
		slot.codeRefused = false;
		this.#showBrowser();
	}

	/** Stops a login that waits and goes back to idle (the status row stays what it was). */
	cancel(): void {
		const slot = this.#slot;
		if (slot.flow.phase === "working") return;
		const waiting = slot.child !== null || ["starting", "browser"].includes(slot.flow.phase);
		slot.attempt++;
		const child = slot.child;
		this.#end(slot);
		child?.kill();
		if (waiting || slot.flow.phase === "checking") this.#set({ phase: "idle" });
	}

	open(): void {
		const slot = this.#slot;
		if (slot.flow.phase === "browser" && slot.url !== null) this.#d.openExternal(slot.url);
	}

	copyUrl(): void {
		const slot = this.#slot;
		if (slot.flow.phase === "browser" && slot.url !== null) this.#d.writeClipboard(slot.url);
	}

	// ---- signing out -----------------------------------------------------------------------------------------------------

	/** `claude auth logout` with the app's `CLAUDE_CONFIG_DIR`: on macOS it deletes the app's own Keychain item (its name carries the folder's hash), on Windows the file in the Claude folder. */
	async signOut(): Promise<void> {
		const slot = this.#slot;
		if (BUSY.includes(slot.flow.phase) || this.#disposed) return;
		const attempt = ++slot.attempt;
		this.#set({ phase: "working" });
		await this.#track(
			(async () => {
				const prepared = await this.#env();
				if (slot.attempt !== attempt) return;
				if (prepared === null) {
					this.#set({ phase: "failed", detail: "claude is not installed" });
					return;
				}
				const result = await this.#d.run(prepared.file, [...prepared.args, "auth", "logout"], { env: prepared.env, replaceEnv: true, timeoutMs: this.#d.callMs ?? CALL_MS });
				if (slot.attempt !== attempt) return;
				this.#d.log({ event: "claude-logout", exit: result.code, ...(result.timedOut ? { timedOut: true } : {}) });
				if (result.code !== 0) {
					this.#set({ phase: "failed", detail: hideSecrets(loginLine(`${result.stdout}\n${result.stderr}`)) });
					return;
				}
				const status = await this.#status();
				if (slot.attempt !== attempt) return;
				slot.state = status.loggedIn === true ? "signed-in" : status.loggedIn === false ? "not-signed-in" : "unknown";
				if (status.loggedIn === true) this.#set({ phase: "failed", detail: "claude auth status still says logged in" });
				else this.#set({ phase: "signed-out" });
			})(),
		).catch((error: Error) => {
			if (slot.attempt !== attempt) return;
			this.#set({ phase: "failed", detail: loginLine(String(error.message)) });
		});
	}

	// ---- the request of a page, and the end ------------------------------------------------------------------------------

	async act(action: ClaudeAction): Promise<void> {
		switch (action.type) {
			case "claude-begin":
				return this.refresh();
			case "claude-start":
				return this.start();
			case "claude-code":
				return this.sendCode(action.code);
			case "claude-cancel":
				return this.cancel();
			case "claude-open":
				return this.open();
			case "claude-copy-url":
				return this.copyUrl();
			case "claude-sign-out":
				return this.signOut();
		}
	}

	/** The app is quitting: a login that waits ends with it; a status or logout call under way is waited for by `settled`. */
	dispose(): void {
		this.#disposed = true;
		const slot = this.#slot;
		if (slot.flow.phase === "working") return;
		slot.attempt++;
		const child = slot.child;
		this.#end(slot);
		child?.kill();
	}

	/** Resolves when every call under way has ended, or after `maxMs`. */
	settled(maxMs: number = (this.#d.callMs ?? CALL_MS) + 15_000): Promise<void> {
		if (this.#inflight.size === 0) return Promise.resolve();
		return new Promise((resolve) => {
			const timer = this.#setTimer(resolve, maxMs);
			void Promise.allSettled([...this.#inflight]).then(() => {
				this.#clearTimer(timer);
				resolve();
			});
		});
	}
}
