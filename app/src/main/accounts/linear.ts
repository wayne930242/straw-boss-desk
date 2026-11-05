import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { renameRetry } from "../bootstrap/fsutil.ts";
import { binScript, binShim, npmGlobalPin } from "../bootstrap/stages/pi.ts";
import { nodeBinaryPath } from "../bootstrap/npm.ts";
import type { Stack } from "../bootstrap/stack.ts";
import { buildEnv, type EnvMap } from "../env.ts";
import type { CurrentTools, Layout } from "../paths.ts";
import type { CommandRunner } from "../platform/types.ts";
import type { RuntimeEvent } from "../runtime/log.ts";
import { KEY_SHAPE, type LinearAction, type LinearFlow, type LinearRestart, type LinearState, type LinearView } from "../../shared/accounts.ts";
import { loginLine } from "./cli.ts";
import { hideSecrets } from "./token-search.ts";

// The Linear key and its setup (spec: First run, step 9; Secrets; Environment). The key is the app's own: encrypted with Electron's `safeStorage` into `secrets/linear.bin` (Windows DPAPI; on macOS a
// Keychain item named after the build's product), and nowhere else: not in a file the CLIs write, not in a log. It reaches a pane only as `LINEAR_API_KEY` in the Herdr server's environment
// (`Supervisor`'s `linearKey`, decrypted at each start), and `ttt init` gets it the same way, through the child's environment. When `isEncryptionAvailable()` is false the key is refused: there is no
// plain-text fallback. Herdr's environment is fixed for its lifetime, so a key saved while the stack runs reaches panes only after a restart: the screen offers **Restart now** or **Later**.
// It knows no Electron: the box, the stage that installs `ttt`, the command runner and the restart come in as dependencies.

/**
 * What `safeStorage` offers, as the app uses it: the asynchronous API (Electron 45 deprecates the synchronous one, and its first call on macOS reaches into the Keychain on the main thread). A test passes a
 * stand-in; the product passes Electron's.
 */
export interface SecretBox {
	/** `isAsyncEncryptionAvailable()`, asked when the Linear screen opens and at each save and read (a test stubs it false at run time). */
	available(): Promise<boolean>;
	encrypt(text: string): Promise<Buffer>;
	/**
	 * Throws when the blob cannot be decrypted (another machine, a lost Safe Storage key). `shouldReEncrypt` is Electron's request to encrypt the text again with the current key and store that
	 * (the key it was encrypted with is being retired).
	 */
	decrypt(blob: Buffer): Promise<{ result: string; shouldReEncrypt: boolean }>;
}

/** The result of the `ttt` stage: whether `ttt` is installed now, and the first line of why not. */
export interface TttInstall {
	ok: boolean;
	detail: string;
}

export interface LinearAccountsDeps {
	layout: Layout;
	box: SecretBox;
	/** One-shot CLI calls (`ttt init`). */
	run: CommandRunner;
	appEnv: Readonly<Record<string, string | undefined>>;
	/** The active tool versions; null before the install is complete. */
	current(): CurrentTools | null;
	/** What runs `ttt` (the private Node with its script, or the prefix's `bin/ttt`); null when `ttt` is not installed. */
	ttt(): { file: string; args: readonly string[] } | null;
	/** Runs the `ttt` stage (engine, only that stage) and says whether `ttt` can run now. */
	installTtt(): Promise<TttInstall>;
	/** The work folder: `ttt init` runs there, so every base under it finds `.ttt` above it. */
	workFolder(): string;
	stackRunning(): boolean;
	/** Stops the stack and starts it again, so Herdr's environment holds the new key. */
	restartStack(): Promise<void>;
	proxyEnv?(): Promise<Record<string, string>>;
	log: RuntimeEvent;
	openExternal(url: string): void;
	/** Makes main's redactor hide `value` in every log (the key), and forget it again. */
	hold?(value: string): void;
	release?(value: string): void;
	/** The limit of `ttt init` (default 120 s). */
	initMs?: number;
}

const INIT_MS = 120_000;
/** Linear's page for creating a personal API key (the address `ttt init` itself names). */
export const LINEAR_KEY_URL = "https://linear.app/settings/api";

/** Where the encrypted key lives. */
export const linearFile = (layout: Layout): string => join(layout.secrets, "linear.bin");

/** The folder's `ttt` setup: `ttt init` writes `config.toon` and `local.toon` under `<cwd>/.ttt`. */
export const tttConfigFile = (workFolder: string): string => join(workFolder, ".ttt", "config.toon");

/**
 * What runs `ttt` for this machine, the way the app runs every npm bin (**Tool paths**): on Windows the private Node with the package's bin script (never npm's `.cmd` wrapper, which breaks under a root
 * with `&` or `^`), on macOS the prefix's `bin/ttt` (a script whose `node` shebang finds the private Node on the constructed `PATH`). Null when the pin or the installed bin is missing.
 */
export function tttCommand(layout: Layout, current: CurrentTools, stack: Stack): { file: string; args: readonly string[] } | null {
	let pin;
	try {
		pin = npmGlobalPin(stack, "ttt");
	} catch {
		return null;
	}
	if (layout.platform === "win32") {
		const script = binScript(layout, pin, "ttt");
		const node = current.node;
		if (script === null || node === undefined || !existsSync(script.absolute)) return null;
		return { file: nodeBinaryPath(layout, node), args: [script.absolute] };
	}
	const shim = binShim(layout, "ttt");
	return existsSync(shim) ? { file: shim, args: [] } : null;
}

/** The encrypted key on disk. A wrong or unreadable file is a state, never a crash. */
export class LinearKeyFile {
	readonly #layout: Layout;
	readonly #box: SecretBox;

	constructor(layout: Layout, box: SecretBox) {
		this.#layout = layout;
		this.#box = box;
	}

	get exists(): boolean {
		return existsSync(linearFile(this.#layout));
	}

	/** Encrypts and writes `key` (a temporary sibling, then a rename, mode 600). Throws when the box refuses or the disk does. */
	async write(key: string): Promise<void> {
		this.#put(await this.#box.encrypt(key));
	}

	/** Writes `blob` in one synchronous step. With `expected`, it writes only when the file still holds exactly those bytes, and answers whether it did. */
	#put(blob: Buffer, expected?: Buffer): boolean {
		const file = linearFile(this.#layout);
		if (expected !== undefined && !(existsSync(file) && readFileSync(file).equals(expected))) return false;
		mkdirSync(dirname(file), { recursive: true });
		const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
		try {
			writeFileSync(tmp, blob, { mode: 0o600 });
			renameRetry(tmp, file);
		} catch (error) {
			rmSync(tmp, { force: true });
			throw error;
		}
		return true;
	}

	/** The decrypted key; null when there is none; throws when the file cannot be decrypted. */
	async read(): Promise<string | null> {
		if (!this.exists) return null;
		if (!(await this.#box.available())) throw new Error("the OS cannot decrypt the key: encryption is not available");
		// A sign-out can land during the availability question: the file is then gone, and there is no key to read (a read that threw here made the row ask for the key again).
		let blob: Buffer;
		try {
			blob = readFileSync(linearFile(this.#layout));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw error;
		}
		const { result: key, shouldReEncrypt } = await this.#box.decrypt(blob);
		// Written back under the current key (R11-F006), only while the file still holds the blob that was decrypted: a save or a sign-out that landed meanwhile is not undone (R11B-F002; the check and the rename share one synchronous step). A write that fails leaves the old blob, which still reads until the old key is dropped: the key itself was read, so this read does not fail.
		if (shouldReEncrypt && key !== "") {
			try {
				this.#put(await this.#box.encrypt(key), blob);
			} catch {
				// the old blob stays
			}
		}
		return key === "" ? null : key;
	}

	remove(): void {
		rmSync(linearFile(this.#layout), { force: true });
	}
}

const BUSY = ["saving", "installing", "initializing"];

/** The first line of what a tool printed that says it failed, for **Details**: redacted of the key and of anything shaped like a token. */
export function failureLine(text: string, key?: string): string {
	return hideSecrets(loginLine(text), key === undefined ? [] : [key]).replace(/lin_(?:api|oauth)_[A-Za-z0-9]+/g, "<token>");
}

export class LinearAccounts {
	readonly #d: LinearAccountsDeps;
	readonly #file: LinearKeyFile;
	readonly #listeners = new Set<() => void>();
	readonly #saved = new Set<() => void>();
	readonly #inflight = new Set<Promise<unknown>>();
	#flow: LinearFlow = { phase: "idle" };
	#restart: LinearRestart = { phase: "none" };
	/** Set when a decrypt failed: the key needs to be entered again. Cleared by a save or a removal. */
	#unreadable = false;
	/** What the OS answered when it was last asked whether it can encrypt; null before the first question. */
	#encryption: boolean | null = null;
	#disposed = false;
	/** Ends the `ttt init` child when the app quits (R11-F007). */
	#quit = new AbortController();

	constructor(deps: LinearAccountsDeps) {
		this.#d = deps;
		this.#file = new LinearKeyFile(deps.layout, deps.box);
	}

	onChange(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/** Called when a key was saved (the wizard takes Linear off its list of sign-ins put off). */
	onSaved(listener: () => void): () => void {
		this.#saved.add(listener);
		return () => this.#saved.delete(listener);
	}

	#emit(): void {
		for (const l of this.#listeners) l();
	}

	#set(flow: LinearFlow): void {
		this.#flow = flow;
		this.#emit();
	}

	#offer(restart: LinearRestart): void {
		this.#restart = restart;
		this.#emit();
	}

	get state(): LinearState {
		if (!this.#file.exists) return "not-saved";
		return this.#unreadable ? "unreadable" : "saved";
	}

	get flow(): LinearFlow {
		return this.#flow;
	}

	view(): LinearView {
		return { state: this.state, flow: this.#flow, restart: this.#restart, encryption: this.#encryption };
	}

	/**
	 * Asks the OS whether it can encrypt, and tells the screen. Called when the Linear screen opens (the wizard's step, settings' Accounts), never at start: nothing reaches `safeStorage` for a PM who
	 * does not use Linear. A box that throws counts as "cannot".
	 */
	async probe(): Promise<void> {
		let answer: boolean;
		try {
			answer = await this.#d.box.available();
		} catch (error) {
			this.#d.log({ event: "linear-probe-failed", detail: loginLine(String((error as Error).message)) });
			answer = false;
		}
		if (this.#encryption !== answer) {
			this.#encryption = answer;
			this.#emit();
		}
	}

	#track<T>(work: Promise<T>): Promise<T> {
		this.#inflight.add(work);
		const done = (): void => void this.#inflight.delete(work);
		work.then(done, done);
		return work;
	}

	// ---- the key, for the Herdr server ---------------------------------------------------------------------------------------

	/**
	 * The decrypted key for the Herdr server's environment (`Supervisor`'s `linearKey`), or undefined when there is none or it cannot be read. A failed decrypt makes the row say the key needs to be entered
	 * again; it never throws, so a start never fails for it.
	 */
	async read(): Promise<string | undefined> {
		try {
			const key = await this.#file.read();
			if (key === null) return undefined;
			this.#hold(key);
			if (this.#unreadable) {
				this.#unreadable = false;
				this.#emit();
			}
			return key;
		} catch (error) {
			this.#d.log({ event: "linear-key-unreadable", detail: loginLine(String((error as Error).message)) });
			if (!this.#unreadable) {
				this.#unreadable = true;
				this.#emit();
			}
			return undefined;
		}
	}

	#hold(key: string): void {
		try {
			this.#d.hold?.(key);
		} catch {
			// A value the redactor refuses (too short to mask) is not one of Linear's.
		}
	}

	// ---- saving ----------------------------------------------------------------------------------------------------------

	/**
	 * Saves `typed`, then installs `ttt` and runs `ttt init`. The key is saved first and kept whatever the later steps say: a failed setup leaves it saved and offers to run the setup again. With
	 * `isEncryptionAvailable()` false nothing is written. The restart is offered at the end, when the stack runs.
	 */
	async save(typed: string): Promise<void> {
		if (BUSY.includes(this.#flow.phase) || this.#disposed) return;
		const key = typed.trim();
		if (!KEY_SHAPE.test(key)) {
			this.#set({ phase: "invalid" });
			return;
		}
		await this.probe();
		if (this.#encryption !== true) {
			this.#d.log({ event: "linear-save-refused", why: "encryption-unavailable" });
			this.#set({ phase: "refused" });
			return;
		}
		this.#set({ phase: "saving" });
		this.#offer({ phase: "none" });
		try {
			await this.#file.write(key);
		} catch (error) {
			this.#d.log({ event: "linear-save-failed", detail: failureLine(String((error as Error).message), key) });
			this.#set({ phase: "save-failed", detail: failureLine(String((error as Error).message), key) });
			return;
		}
		this.#hold(key);
		this.#unreadable = false;
		this.#d.log({ event: "linear-key-saved" });
		for (const l of this.#saved) l();
		await this.#track(this.#setup(key));
	}

	/** Runs the setup again with the key that is saved (after a failed install or `ttt init`, or a changed work folder). */
	async setup(): Promise<void> {
		if (BUSY.includes(this.#flow.phase) || this.#disposed) return;
		let key: string | null;
		try {
			key = await this.#file.read();
		} catch {
			this.#unreadable = true;
			this.#emit();
			return;
		}
		if (key === null) return;
		this.#hold(key);
		this.#set({ phase: "installing" });
		await this.#track(this.#setup(key));
	}

	async #setup(key: string): Promise<void> {
		try {
			this.#set({ phase: "installing" });
			const installed = await this.#d.installTtt();
			if (this.#disposed) return;
			if (!installed.ok) {
				this.#d.log({ event: "linear-ttt-install-failed", detail: failureLine(installed.detail, key) });
				this.#set({ phase: "setup-failed", step: "install", detail: failureLine(installed.detail, key) });
				return;
			}
			const done = await this.#init(key);
			if (this.#disposed) return;
			this.#set(done);
		} catch (error) {
			this.#d.log({ event: "linear-setup-failed", detail: failureLine(String((error as Error).message), key) });
			this.#set({ phase: "setup-failed", step: "init", detail: failureLine(String((error as Error).message), key) });
		} finally {
			// The key is saved in every case; the offer comes once the setup has ended, so a restart never meets an install that still writes to the private prefix.
			if (!this.#disposed && this.#file.exists && this.#restart.phase === "none") this.#offerRestart("saved");
		}
	}

	/** `ttt init -y` in the work folder, with the key in the child's environment only. A folder that holds a setup already is kept as it is (`init` would refuse it without `--force`, and `--force` would overwrite the PM's choices). */
	async #init(key: string): Promise<LinearFlow> {
		const work = this.#d.workFolder();
		if (existsSync(tttConfigFile(work))) {
			this.#d.log({ event: "linear-init-kept" });
			return { phase: "done", initialized: "kept" };
		}
		const command = this.#d.ttt();
		const current = this.#d.current();
		if (command === null || current === null) return { phase: "setup-failed", step: "install", detail: "ttt is not installed" };
		this.#set({ phase: "initializing" });
		mkdirSync(work, { recursive: true });
		let proxyEnv: Record<string, string> = {};
		try {
			proxyEnv = (await this.#d.proxyEnv?.()) ?? {};
		} catch {
			proxyEnv = {};
		}
		// The key is in this child's environment and nowhere else. `-y` takes the defaults and never prompts; an empty standard input ends a prompt that a later version might add.
		const env: EnvMap = { ...proxyEnv, ...buildEnv({ layout: this.#d.layout, current, appEnv: this.#d.appEnv, linearApiKey: key }) };
		const result = await this.#d.run(command.file, [...command.args, "init", "-y"], { env, replaceEnv: true, cwd: work, stdin: "", timeoutMs: this.#d.initMs ?? INIT_MS, signal: this.#quit.signal });
		this.#d.log({ event: "linear-init", exit: result.code, ...(result.timedOut ? { timedOut: true } : {}) });
		// `ttt init` reports an API error on its output and still exits 0, so what it wrote decides.
		if (result.code === 0 && existsSync(tttConfigFile(work))) return { phase: "done", initialized: "ran" };
		const detail = failureLine(`${result.stdout}\n${result.stderr}`, key);
		return { phase: "setup-failed", step: "init", detail: result.timedOut ? `timed out after ${(this.#d.initMs ?? INIT_MS) / 1000} s` : detail };
	}

	// ---- removing --------------------------------------------------------------------------------------------------------

	/** Deletes `secrets/linear.bin`. The `.ttt` setup and the `ttt` install stay: they hold no key. Panes already open keep the key until the stack restarts, which the screen offers. */
	async signOut(): Promise<void> {
		if (BUSY.includes(this.#flow.phase)) return;
		let key: string | null = null;
		try {
			key = await this.#file.read();
		} catch {
			key = null;
		}
		this.#file.remove();
		if (key !== null) {
			try {
				this.#d.release?.(key);
			} catch {
				// not registered
			}
		}
		this.#unreadable = false;
		this.#d.log({ event: "linear-key-removed" });
		this.#set({ phase: "signed-out" });
		this.#offerRestart("removed");
	}

	#offerRestart(change: "saved" | "removed"): void {
		this.#offer(this.#d.stackRunning() ? { phase: "offer", change } : { phase: "none" });
	}

	// ---- the restart -----------------------------------------------------------------------------------------------------

	/** **Restart now**: the stack stops and starts again, so Herdr's environment holds the key (running agents stop and Herdr restores them). */
	async restart(): Promise<void> {
		if (this.#restart.phase !== "offer") return;
		this.#offer({ phase: "restarting" });
		await this.#track(
			this.#d.restartStack().then(
				() => {
					this.#d.log({ event: "linear-restart", ok: true });
					this.#offer({ phase: "restarted" });
				},
				(error: Error) => {
					this.#d.log({ event: "linear-restart", ok: false, detail: loginLine(String(error.message)) });
					this.#offer({ phase: "failed", detail: loginLine(String(error.message)) });
				},
			),
		);
	}

	/** **Later**: the key applies at the next start. */
	restartLater(): void {
		if (this.#restart.phase === "offer") this.#offer({ phase: "later" });
	}

	open(): void {
		this.#d.openExternal(LINEAR_KEY_URL);
	}

	/** Back to the start of the screen after an outcome the PM has read (also **Cancel** of the field). */
	reset(): void {
		if (BUSY.includes(this.#flow.phase)) return;
		this.#set({ phase: "idle" });
	}

	/** Shows the field beside a key that is saved, to replace it. */
	edit(): void {
		if (BUSY.includes(this.#flow.phase)) return;
		this.#set({ phase: "entering" });
	}

	// ---- the request of a page, and the end ------------------------------------------------------------------------------

	async act(action: LinearAction): Promise<void> {
		switch (action.type) {
			case "linear-save":
				return this.save(action.key);
			case "linear-edit":
				return this.edit();
			case "linear-cancel":
				return this.reset();
			case "linear-setup":
				return this.setup();
			case "linear-open":
				return this.open();
			case "linear-sign-out":
				return this.signOut();
			case "linear-restart":
				return this.restart();
			case "linear-restart-later":
				return this.restartLater();
		}
	}

	/** The app is quitting: what runs is not continued. The setup's `ttt init` child is ended through the runner that holds it; the engine run of the `ttt` stage is cancelled by the engine host's dispose. */
	dispose(): void {
		this.#disposed = true;
		this.#quit.abort();
	}

	/** The app goes on after a stop that did not end it (an update's installer that could not start): work is taken again. A setup the stop cut short shows as failed, so Run setup again is offered. */
	resume(): void {
		this.#disposed = false;
		this.#quit = new AbortController();
		if (BUSY.includes(this.#flow.phase)) this.#set(this.#file.exists ? { phase: "setup-failed", step: "init", detail: "interrupted" } : { phase: "idle" });
	}

	/** Resolves when the work under way has ended, or after `maxMs`. */
	settled(maxMs = 20_000): Promise<void> {
		if (this.#inflight.size === 0) return Promise.resolve();
		return new Promise((resolve) => {
			const timer = setTimeout(resolve, maxMs);
			void Promise.allSettled([...this.#inflight]).then(() => {
				clearTimeout(timer);
				resolve();
			});
		});
	}
}
