import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../bootstrap/fsutil.ts";
import type { EnvMap } from "../env.ts";
import type { CurrentTools, Layout } from "../paths.ts";
import type { CommandRunner, CredentialStore, StoreEntry } from "../platform/types.ts";
import type { RuntimeEvent } from "../runtime/log.ts";
import type { EntryName, ForgeAction, ForgeFlow, ForgeState, ForgeView } from "../../shared/accounts.ts";
import type { LeftEntry } from "../../shared/computer.ts";
import type { Forge } from "../../shared/wizard.ts";
import { cliOf, forgeBinary, forgeConfigDir, forgeEnv, loginLine, parseDeviceCode, type LoginChild, type SpawnLogin } from "./cli.ts";
import {
	classify,
	dropHost,
	markHostLeft,
	readAccountsRecord,
	reconcile,
	recordLogin,
	stateOf,
	writeAccountsRecord,
	type AccountsRecord,
	type ForgeKind,
} from "./existing.ts";
import { ghFileFindings, ghTokenSource, ghTokenVerdict, glabFileFindings, glabTokenVerdict, removeHostBlock, type Verdict } from "./forge.ts";
import { listHostEntries, probeStore } from "./probe.ts";
import { hideSecrets } from "./token-search.ts";

// The code-host sign-in (spec: The code-host screens). One `ForgeAccounts` owns the state of every forge host: the checks before a login (the store probe, then the existing-sign-in check), the
// device-code login of GitHub, the token login of GitLab, the verdict after either, and the removal of a login that touches only entries the app owns. It knows no Electron: the store, the
// command runner, the process spawn, the clipboard and the browser come in as dependencies, so every rule here runs under plain Node. No log line or event it makes holds a token, a code, or
// a command's output beyond one redacted line.

export interface ForgeAccountsDeps {
	layout: Layout;
	credentials: CredentialStore;
	/** One-shot CLI calls (status, logout, the GitLab login with its token on standard input). */
	run: CommandRunner;
	/** The GitHub device login, which runs until the person approves it. */
	spawn: SpawnLogin;
	appEnv: Readonly<Record<string, string | undefined>>;
	/** The active tool versions; null before the install is complete. */
	current(): CurrentTools | null;
	proxyEnv?(hosts: readonly string[]): Promise<Record<string, string>>;
	log: RuntimeEvent;
	openExternal(url: string): void;
	writeClipboard(text: string): void;
	/** How long a device code may wait for approval (default 15 minutes). */
	loginWaitMs?: number;
	/** The limit of a status or a logout call (default 60 s); the GitLab login has the same. */
	callMs?: number;
	/** How long a quit waits for a login that is being finished, and the deadline that bounds every call made after the quit began (default 75 s; T10RR-F002). */
	settleMs?: number;
	now?: () => number;
	setTimer?: (fn: () => void, ms: number) => unknown;
	clearTimer?: (timer: unknown) => void;
}

const LOGIN_WAIT_MS = 15 * 60_000;
const CALL_MS = 60_000;
/** How long a quit waits for a login that is being finished (spec: a quit waits for it, up to 75 s). */
const SETTLE_MS = 75_000;
/** The least a call gets once the quit's deadline is near: enough for a local CLI to answer, short enough to end the chain. */
const MIN_CALL_MS = 2_000;

const hostKey = (host: string): string => host.toLowerCase();
const namesOf = (entries: readonly StoreEntry[]): EntryName[] => entries.map((e) => ({ name: e.name, account: e.account }));

interface HostState {
	kind: ForgeKind;
	flow: ForgeFlow;
	state: ForgeState;
	entries: EntryName[];
	/** The login that waits for approval. */
	child: LoginChild | null;
	timer: unknown;
	code: string | null;
	/** Counts the attempts: a continuation of an abandoned one finds a newer number and stops. */
	attempt: number;
	/** The operations on this host that list the store and write the record run one after another (T10R-F006). */
	lock: Promise<void>;
}

/** The phases in which an attempt is under way and nothing else may start on the host. */
const BUSY = ["checking", "waiting-code", "code", "working"];

/** The GitLab page where a personal access token is made, with the name and the scope filled in. */
export const gitlabTokenUrl = (host: string): string => `https://${host}/-/user_settings/personal_access_tokens?name=Straw%20Boss&scopes=api`;
export const githubDeviceUrl = (host: string): string => `https://${host}/login/device`;

export class ForgeAccounts {
	readonly #d: ForgeAccountsDeps;
	readonly #hosts = new Map<string, HostState>();
	readonly #listeners = new Set<() => void>();
	readonly #signedIn = new Set<(kind: ForgeKind, host: string) => void>();
	readonly #setTimer: (fn: () => void, ms: number) => unknown;
	readonly #clearTimer: (timer: unknown) => void;
	/** The operations under way, so a quit can wait for a login that glab or gh is finishing (T10R-F001). */
	readonly #inflight = new Set<Promise<unknown>>();
	#disposed = false;
	/** Set when the quit began: every CLI call made after it ends by then (T10RR-F002). */
	#deadline: number | null = null;

	constructor(deps: ForgeAccountsDeps) {
		this.#d = deps;
		this.#setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
		this.#clearTimer = deps.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
	}

	onChange(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/** Called when a sign-in passed its verdict (the wizard takes the host off its list of sign-ins put off). */
	onSignedIn(listener: (kind: ForgeKind, host: string) => void): () => void {
		this.#signedIn.add(listener);
		return () => this.#signedIn.delete(listener);
	}

	#emit(): void {
		for (const l of this.#listeners) l();
	}

	#slot(kind: ForgeKind, host: string): HostState {
		const key = hostKey(host);
		let slot = this.#hosts.get(key);
		if (slot === undefined || slot.kind !== kind) {
			// Before the store is listed, the row says what the record says; `refresh` corrects it. A `left` entry is the exception: whether it was changed afterwards or only left intact beside a foreign
			// sign-in is a fact about the store, which the record cannot show, so the row is `checking` until the listing arrives (T14R2-F003).
			const record = readAccountsRecord(this.#d.layout);
			const mine = (e: { kind: ForgeKind; host: string }): boolean => e.kind === kind && e.host === host;
			const state: ForgeState = record.left.some(mine) ? "checking" : record.entries.some(mine) ? "signed-in" : "not-signed-in";
			slot = { kind, flow: { phase: "idle" }, state, entries: record.left.filter(mine).map((e) => ({ name: e.name, account: e.account })), child: null, timer: null, code: null, attempt: 0, lock: Promise.resolve() };
			this.#hosts.set(key, slot);
		}
		return slot;
	}

	#set(slot: HostState, flow: ForgeFlow): void {
		slot.flow = flow;
		this.#emit();
	}

	/**
	 * Runs `fn` after every earlier operation on the host has ended. A listing and the record it is reconciled against must not straddle a login (T10R-F006): a refresh that listed the store before
	 * the login and reconciled after it would turn the fresh login `left`, or drop it. Nothing inside `fn` takes the lock again.
	 */
	#exclusive<T>(slot: HostState, fn: () => Promise<T>): Promise<T> {
		const run = slot.lock.then(fn, fn);
		slot.lock = run.then(
			() => undefined,
			() => undefined,
		);
		this.#inflight.add(run);
		const done = (): void => void this.#inflight.delete(run);
		run.then(done, done);
		return run;
	}

	/** What the pages show for these forges. */
	views(forges: readonly Forge[]): ForgeView[] {
		return forges.map((f) => {
			const slot = this.#slot(f.kind, f.host);
			return { kind: f.kind, host: f.host, state: slot.state, entries: slot.entries.map((e) => ({ ...e })), flow: slot.flow };
		});
	}

	flowOf(host: string): ForgeFlow {
		return this.#hosts.get(hostKey(host))?.flow ?? { phase: "idle" };
	}

	// ---- the store, and the record -------------------------------------------------------------------------------------

	/**
	 * The limit of a CLI call now. Normally `callMs`; once the quit began, no call may run past the quit's deadline, so a login that was being finished when the quit began (the status, and on the
	 * plain-text path a logout) ends within `settleMs` of it in all, and not 60 s per step (T10RR-F002).
	 */
	#callMs(): number {
		const base = this.#d.callMs ?? CALL_MS;
		if (this.#deadline === null) return base;
		return Math.max(MIN_CALL_MS, Math.min(base, this.#deadline - (this.#d.now ?? Date.now)()));
	}

	#writeRecord(record: AccountsRecord): void {
		writeAccountsRecord(this.#d.layout, record);
	}

	/**
	 * Lists the host's entries and settles the record against them (an owned entry that turned foreign moves to `left`; one the store no longer holds is dropped). Null when the listing failed:
	 * the caller stops, since an empty list would otherwise read as "no entry".
	 */
	async #settle(kind: ForgeKind, host: string, slot: HostState): Promise<{ record: AccountsRecord; entries: StoreEntry[] } | { failed: string }> {
		const listing = await listHostEntries(this.#d.credentials, kind, host);
		if (!listing.ok) {
			slot.state = "unknown";
			this.#d.log({ event: "forge-listing-failed", cli: cliOf(kind), host, detail: listing.detail });
			return { failed: listing.detail };
		}
		const before = readAccountsRecord(this.#d.layout);
		const settled = reconcile(before, listing.entries, kind, host);
		if (settled.changed) this.#writeRecord(settled.record);
		for (const moved of settled.movedToLeft) this.#d.log({ event: "forge-entry-left", cli: cliOf(kind), host, name: moved.name, account: moved.account });
		const split = classify(listing.entries, settled.record);
		slot.state = stateOf(settled.record, listing.entries, kind, host);
		slot.entries = namesOf(split.foreign);
		return { record: settled.record, entries: listing.entries };
	}

	/** Every forge's row from the store now (settings opens on it, and a finished action asks again). A failed listing leaves that row unknown. */
	async refresh(forges: readonly Forge[]): Promise<void> {
		for (const f of forges) {
			const slot = this.#slot(f.kind, f.host);
			if (slot.child !== null || BUSY.includes(slot.flow.phase)) continue;
			await this.#exclusive(slot, async () => {
				// Asked again once it is the host's turn: a login may have begun while this waited.
				if (slot.child !== null || BUSY.includes(slot.flow.phase)) return;
				await this.#settle(f.kind, f.host, slot);
			});
		}
		this.#emit();
	}

	// ---- the checks before a login -------------------------------------------------------------------------------------

	/**
	 * The store probe, then the existing-sign-in check, in this order; the step stops before the person makes a token when one fails. Passing leaves the host `ready`.
	 */
	async begin(kind: ForgeKind, host: string): Promise<void> {
		const slot = this.#slot(kind, host);
		if (slot.child !== null || BUSY.includes(slot.flow.phase)) return;
		const attempt = ++slot.attempt;
		this.#set(slot, { phase: "checking" });
		await this.#exclusive(slot, async () => {
			const probe = await probeStore(this.#d.credentials);
			if (slot.attempt !== attempt) return;
			this.#d.log({ event: "forge-probe", cli: cliOf(kind), host, ok: probe.ok, ...(probe.ok ? {} : { detail: probe.detail }) });
			if (!probe.ok) {
				slot.state = "unknown";
				this.#set(slot, { phase: "store-unavailable", detail: probe.detail });
				return;
			}
			const checked = await this.#check(kind, host, slot);
			if (slot.attempt !== attempt) return;
			this.#set(slot, "stop" in checked ? checked.stop : { phase: "ready" });
		});
	}

	/** The listing and the ownership check, right before a login. Either the flow that stops it, or the entries listed (all of them owned, or none). */
	async #check(kind: ForgeKind, host: string, slot: HostState): Promise<{ stop: ForgeFlow } | { entries: StoreEntry[] }> {
		const settled = await this.#settle(kind, host, slot);
		if ("failed" in settled) return { stop: { phase: "store-unavailable", detail: settled.failed } };
		const split = classify(settled.entries, settled.record);
		this.#d.log({ event: "forge-existing-check", cli: cliOf(kind), host, found: settled.entries.length, owned: split.owned.length, foreign: split.foreign.length });
		if (split.foreign.length > 0) return { stop: { phase: "foreign", entries: namesOf(split.foreign), changed: namesOf(split.changed) } };
		return { entries: settled.entries };
	}

	// ---- GitHub: the device code ---------------------------------------------------------------------------------------

	async startGithub(host: string): Promise<void> {
		const slot = this.#slot("github", host);
		if (slot.flow.phase !== "ready" || slot.child !== null) return;
		const attempt = ++slot.attempt;
		this.#set(slot, { phase: "waiting-code" });
		const checked = await this.#exclusive(slot, () => this.#check("github", host, slot));
		if (slot.attempt !== attempt) return;
		if ("stop" in checked) {
			this.#set(slot, checked.stop);
			return;
		}
		const before = checked.entries;
		const prepared = await this.#prepare("github", host);
		if (slot.attempt !== attempt) return;
		if (prepared === null) {
			this.#set(slot, { phase: "failed", detail: "gh is not installed" });
			return;
		}
		// The flag that keeps gh from writing a refreshable token, which gh itself would rewrite on routine use and so make the entry foreign (Ownership).
		const args = ["auth", "login", "--hostname", host, "--git-protocol", "https", "--web", "--expiring=false"];
		this.#d.log({ event: "forge-login-start", cli: "gh", host, args });
		let child: LoginChild;
		try {
			child = this.#d.spawn(prepared.file, args, { env: prepared.env });
		} catch (error) {
			this.#set(slot, { phase: "failed", detail: loginLine(String((error as Error).message)) });
			return;
		}
		slot.child = child;
		slot.code = null;
		let output = "";
		const take = (chunk: Buffer | string): void => {
			if (slot.attempt !== attempt) return;
			output = `${output}${chunk.toString()}`.slice(-20_000);
			if (slot.code === null) {
				const code = parseDeviceCode(output);
				if (code !== null) {
					slot.code = code;
					this.#set(slot, { phase: "code", code, deviceUrl: githubDeviceUrl(host) });
				}
			}
		};
		child.stdout?.on("data", take);
		child.stderr?.on("data", take);
		slot.timer = this.#setTimer(() => {
			if (slot.attempt !== attempt || slot.child !== child) return;
			slot.attempt++;
			child.kill();
			this.#release(slot);
			this.#d.log({ event: "forge-login-timeout", cli: "gh", host });
			this.#set(slot, { phase: "timeout" });
		}, this.#d.loginWaitMs ?? LOGIN_WAIT_MS);
		child.on("error", (error) => {
			if (slot.attempt !== attempt) return;
			slot.attempt++;
			this.#release(slot);
			this.#set(slot, { phase: "failed", detail: loginLine(error.message) });
		});
		child.on("exit", (code) => {
			if (slot.attempt !== attempt) return;
			this.#release(slot);
			this.#d.log({ event: "forge-login-exit", cli: "gh", host, exit: code });
			if (code !== 0) {
				this.#set(slot, { phase: "failed", detail: hideSecrets(loginLine(output)) });
				return;
			}
			this.#set(slot, { phase: "working" });
			const cliSaidPlain = /saved in plain text/i.test(output);
			this.#exclusive(slot, () => this.#afterLogin("github", host, slot, attempt, before, cliSaidPlain)).catch((error: Error) => this.#failed(slot, attempt, error));
		});
	}

	#failed(slot: HostState, attempt: number, error: Error): void {
		if (slot.attempt !== attempt) return;
		this.#set(slot, { phase: "failed", detail: loginLine(String(error.message)) });
	}

	#release(slot: HostState): void {
		if (slot.timer !== null) this.#clearTimer(slot.timer);
		slot.timer = null;
		slot.child = null;
	}

	// ---- GitLab: the token ---------------------------------------------------------------------------------------------

	/** `token` goes to the CLI's standard input and nowhere else; it is not logged, kept, or put on a command line. */
	async signInGitlab(host: string, token: string): Promise<void> {
		const slot = this.#slot("gitlab", host);
		const secret = token.trim();
		if (slot.flow.phase !== "ready" || secret === "") return;
		const attempt = ++slot.attempt;
		this.#set(slot, { phase: "working" });
		await this.#exclusive(slot, () => this.#signInGitlab(host, secret, slot, attempt));
	}

	async #signInGitlab(host: string, secret: string, slot: HostState, attempt: number): Promise<void> {
		const checked = await this.#check("gitlab", host, slot);
		if (slot.attempt !== attempt) return;
		if ("stop" in checked) {
			this.#set(slot, checked.stop);
			return;
		}
		const before = checked.entries;
		const prepared = await this.#prepare("gitlab", host);
		if (slot.attempt !== attempt) return;
		if (prepared === null) {
			this.#set(slot, { phase: "failed", detail: "glab is not installed" });
			return;
		}
		// A quit that began while the checks ran starts no login: one that glab already runs is waited for and recorded (`settled`).
		if (this.#disposed) {
			this.#set(slot, { phase: "ready" });
			return;
		}
		const args = ["auth", "login", "--hostname", host, "--git-protocol", "https", "--api-protocol", "https", "--stdin"];
		this.#d.log({ event: "forge-login-start", cli: "glab", host, args });
		const result = await this.#d.run(prepared.file, args, { stdin: `${secret}\n`, env: prepared.env, replaceEnv: true, timeoutMs: this.#callMs() });
		if (slot.attempt !== attempt) return;
		this.#d.log({ event: "forge-login-exit", cli: "glab", host, exit: result.code, ...(result.timedOut ? { timedOut: true } : {}) });
		if (result.code !== 0) {
			this.#set(slot, { phase: "failed", detail: hideSecrets(loginLine(`${result.stdout}\n${result.stderr}`), [secret]) });
			return;
		}
		await this.#afterLogin("gitlab", host, slot, attempt, before, /keyring is unavailable|plaintext|plain text/i.test(`${result.stdout} ${result.stderr}`)).catch((error: Error) => this.#failed(slot, attempt, error));
	}

	// ---- after a login ---------------------------------------------------------------------------------------------------

	/**
	 * Lists the host's entries again at once and records each one that was not there before, or that the app owned before; then the verdict. A plain-text token is removed and the login refused;
	 * a status that cannot be read fails the step and keeps the login.
	 */
	async #afterLogin(kind: ForgeKind, host: string, slot: HostState, attempt: number, before: readonly StoreEntry[], cliSaidPlain: boolean): Promise<void> {
		const after = await listHostEntries(this.#d.credentials, kind, host);
		if (slot.attempt !== attempt) return;
		if (after.ok) {
			const record = recordLogin(readAccountsRecord(this.#d.layout), { kind, host, before, after: after.entries });
			this.#writeRecord(record);
			slot.state = stateOf(record, after.entries, kind, host);
			slot.entries = [];
			this.#d.log({ event: "forge-recorded", cli: cliOf(kind), host, entries: record.entries.filter((e) => e.kind === kind && e.host === host).length });
		} else {
			// Without the listing the entries cannot be recorded, so they would read as foreign later: the safe direction. The step says the login could not be checked.
			this.#d.log({ event: "forge-listing-failed", cli: cliOf(kind), host, detail: after.detail });
			slot.state = "unknown";
		}
		const verdict = await this.verdict(kind, host);
		if (slot.attempt !== attempt) return;
		this.#d.log({ event: "forge-verdict", cli: cliOf(kind), host, plain: verdict.plain, verified: verdict.verified, cliSaidPlain });
		if (verdict.plain || cliSaidPlain) {
			let removal = await this.#remove(kind, host, slot, "plain-text");
			if (slot.attempt !== attempt) return;
			// A removal that stopped before the logout (the store could not be listed, the logout failed) still takes the host out of the app's own file: that touches no store entry (T10R-F002).
			if (removal.phase !== "signed-out" && removal.phase !== "left-alone") {
				this.#removeFromOwnFile(kind, host);
				// With the host gone from that file the CLI can no longer log out of it (gh: "not logged in to <host>"), so an entry the app owns that a failed logout left in the store is deleted by the app
				// itself (T10RR-F003). Without a listing nothing is known about the store, so nothing is deleted.
				if (removal.phase === "failed") {
					const cleaned = await this.#deleteOwned(kind, host, slot);
					if (slot.attempt !== attempt) return;
					if (cleaned.ok) removal = { phase: "signed-out" };
				}
			}
			// The files decide whether the screen may say no token stays: what the logout was supposed to remove is read again.
			const stays = this.#plainFiles(kind, host);
			const detail = stays.length === 0 ? verdict.reason : `${verdict.reason}; removing it ended as ${removal.phase}; a token still stays in ${stays.join(", ")}`;
			this.#d.log({ event: "forge-plain-removal", cli: cliOf(kind), host, ended: removal.phase, stays: stays.length });
			this.#set(slot, { phase: "plain-text", detail, removed: stays.length === 0 });
			return;
		}
		if (!verdict.verified || !after.ok) {
			this.#set(slot, { phase: "unverified", detail: after.ok ? verdict.reason : `the credential store could not be listed: ${after.detail}` });
			return;
		}
		this.#set(slot, { phase: "done" });
		for (const l of this.#signedIn) l(kind, host);
	}

	/** The files of the app's own configuration folder that hold a non-empty token line for the host: gh's `hosts.yml` and `config.yml`, glab's `config.yml`. */
	#plainFiles(kind: ForgeKind, host: string): string[] {
		const dir = forgeConfigDir(this.#d.layout, kind);
		if (kind === "gitlab") return glabFileFindings(dir, host).own > 0 ? [join(dir, "config.yml")] : [];
		const files = ghFileFindings(dir, host);
		return [...(files.hosts.own > 0 ? [join(dir, "hosts.yml")] : []), ...(files.config.own > 0 ? [join(dir, "config.yml")] : [])];
	}

	/** After either login: gh's `tokenSource` must be `keyring` and neither of gh's files may hold a token for the host; glab's `config.yml` may hold none. */
	async verdict(kind: ForgeKind, host: string): Promise<Verdict> {
		const prepared = await this.#prepare(kind, host);
		if (prepared === null) return { plain: false, verified: false, reason: `could not verify: ${cliOf(kind)} is not installed` };
		if (kind === "github") {
			const status = await this.#d.run(prepared.file, ["auth", "status", "--hostname", host, "--json", "hosts"], { env: prepared.env, replaceEnv: true, timeoutMs: this.#callMs() });
			const source = status.code === 0 ? ghTokenSource(status.stdout, host).source : null;
			const files = ghFileFindings(forgeConfigDir(this.#d.layout, "github"), host);
			return ghTokenVerdict({ source, hostsTokens: files.hosts.own, configTokens: files.config.own });
		}
		const status = await this.#d.run(prepared.file, ["auth", "status", "--hostname", host], { env: prepared.env, replaceEnv: true, timeoutMs: this.#callMs() });
		return glabTokenVerdict({ configTokens: glabFileFindings(forgeConfigDir(this.#d.layout, "gitlab"), host).own, statusExit: status.code });
	}

	// ---- removing a login ------------------------------------------------------------------------------------------------

	async signOut(kind: ForgeKind, host: string): Promise<void> {
		const slot = this.#slot(kind, host);
		if (slot.child !== null || BUSY.includes(slot.flow.phase)) return;
		const attempt = ++slot.attempt;
		this.#set(slot, { phase: "working" });
		await this.#exclusive(slot, async () => {
			const outcome = await this.#remove(kind, host, slot, "sign-out");
			if (slot.attempt !== attempt) return;
			this.#set(slot, outcome);
		});
	}

	/**
	 * Removing a login acts only on entries the app owns (spec: **Removing a login**). Right before it, the host's entries are listed again with their times. When every one is owned, or there is
	 * none, the CLI's logout runs and the record is dropped. When any is foreign, no logout runs: the host leaves the app's own `hosts.yml` or `config.yml`, every entry the app made is marked `left`
	 * (they stay in the store beside the foreign one), and the outcome names what stays.
	 */
	async #remove(kind: ForgeKind, host: string, slot: HostState, why: "sign-out" | "plain-text"): Promise<ForgeFlow> {
		// The CLI and its proxy are looked up first, so nothing but the listing lies between the ownership check and the logout (T10R-F007).
		const prepared = await this.#prepare(kind, host);
		const settled = await this.#settle(kind, host, slot);
		if ("failed" in settled) return { phase: "store-unavailable", detail: settled.failed };
		const split = classify(settled.entries, settled.record);
		if (split.foreign.length > 0) {
			this.#removeFromOwnFile(kind, host);
			const marked = markHostLeft(settled.record, kind, host);
			this.#writeRecord(marked.record);
			slot.state = stateOf(marked.record, settled.entries, kind, host);
			slot.entries = namesOf(split.foreign);
			this.#d.log({ event: "forge-logout-skipped", cli: cliOf(kind), host, why, foreign: split.foreign.length, left: marked.left.length });
			return { phase: "left-alone", foreign: namesOf(split.foreign), left: marked.left.map((e) => ({ name: e.name, account: e.account })) };
		}
		if (prepared === null) return { phase: "failed", detail: `${cliOf(kind)} is not installed` };
		const result = await this.#d.run(prepared.file, ["auth", "logout", "--hostname", host], { env: prepared.env, replaceEnv: true, timeoutMs: this.#callMs() });
		this.#d.log({ event: "forge-logout", cli: cliOf(kind), host, why, exit: result.code });
		if (result.code !== 0) {
			const said = hideSecrets(loginLine(`${result.stdout}\n${result.stderr}`));
			// A host that is still in the CLI's file can be logged out again: the PM tries again.
			if (this.#inOwnFile(kind, host)) return { phase: "failed", detail: said };
			// A host that is not (the app took it out of the file when a login ended on a plain-text token) cannot: gh refuses `auth logout` for a host missing from its `hosts.yml` ("not logged in to
			// <host>", gh 2.103.3 `logoutRun`), so the owned entry would stay in the store for good (T10RR-F003). glab deletes the keyring copy of a token even then (1.124.0 `syncKeyring`, outside
			// CI, which the launcher's environment guarantees). So the entries the app owns, checked again right now, are deleted by the app itself.
			const cleaned = await this.#deleteOwned(kind, host, slot);
			return cleaned.ok ? { phase: "signed-out" } : { phase: "failed", detail: said === "" ? cleaned.detail : said };
		}
		await this.#recordRemoval(kind, host, slot);
		return { phase: "signed-out" };
	}

	/** The record after a login left the store: the host's entries are dropped, except any the store still holds (a logout that left an owned entry did not finish; the record keeps what the store holds). */
	async #recordRemoval(kind: ForgeKind, host: string, slot: HostState): Promise<void> {
		const after = await listHostEntries(this.#d.credentials, kind, host);
		const held = readAccountsRecord(this.#d.layout);
		const dropped = dropHost(held, kind, host);
		const record = after.ok ? this.#keepSurvivors(dropped, held, after.entries, kind, host) : dropped;
		this.#writeRecord(record);
		slot.state = after.ok ? stateOf(record, after.entries, kind, host) : "not-signed-in";
		slot.entries = [];
	}

	/**
	 * Deletes the entries the app owns for the host through the store, after a logout that failed. The entries are listed again first and only those still owned (their name recorded, their modification
	 * time unchanged) are deleted; one that is not the app's stops it. Says whether every owned entry is gone.
	 */
	async #deleteOwned(kind: ForgeKind, host: string, slot: HostState): Promise<{ ok: true; deleted: number } | { ok: false; detail: string }> {
		const settled = await this.#settle(kind, host, slot);
		if ("failed" in settled) return { ok: false, detail: settled.failed };
		const split = classify(settled.entries, settled.record);
		if (split.foreign.length > 0) return { ok: false, detail: "an entry the app does not own is in the store now, so nothing was deleted" };
		let deleted = 0;
		for (const entry of split.owned) {
			try {
				await this.#d.credentials.delete({ name: entry.name, account: entry.account });
				deleted++;
			} catch (error) {
				this.#d.log({ event: "forge-owned-delete-failed", cli: cliOf(kind), host, name: entry.name, detail: loginLine(String((error as Error).message)) });
				return { ok: false, detail: loginLine(String((error as Error).message)) };
			}
		}
		this.#d.log({ event: "forge-owned-deleted", cli: cliOf(kind), host, deleted });
		await this.#recordRemoval(kind, host, slot);
		return { ok: true, deleted };
	}

	/** Entries still in the store after a logout stay in the record as they were (owned ones remain owned; it is not the app's to forget them). */
	#keepSurvivors(dropped: AccountsRecord, before: AccountsRecord, listed: readonly StoreEntry[], kind: ForgeKind, host: string): AccountsRecord {
		const stays = new Set(listed.map((e) => JSON.stringify([e.name, e.account])));
		const mine = (e: { kind: ForgeKind; host: string }): boolean => e.kind === kind && e.host === host;
		return {
			schema: 1,
			entries: [...dropped.entries, ...before.entries.filter((e) => mine(e) && stays.has(JSON.stringify([e.name, e.account])))],
			left: [...dropped.left, ...before.left.filter((e) => mine(e) && stays.has(JSON.stringify([e.name, e.account])))],
		};
	}

	/** True when the CLI's own file (gh `hosts.yml`, glab `config.yml`) in the app's configuration folder still has a block for the host: the CLI's logout can act on it. */
	#inOwnFile(kind: ForgeKind, host: string): boolean {
		const file = join(forgeConfigDir(this.#d.layout, kind), kind === "github" ? "hosts.yml" : "config.yml");
		try {
			return existsSync(file) && removeHostBlock(readFileSync(file, "utf8"), host, kind === "github" ? [] : ["hosts"]).removed;
		} catch {
			return false;
		}
	}

	/** The host leaves the app's own `hosts.yml` (gh) or `config.yml` (glab). A file that is not there, or not readable, is left alone. */
	#removeFromOwnFile(kind: ForgeKind, host: string): void {
		const file = join(forgeConfigDir(this.#d.layout, kind), kind === "github" ? "hosts.yml" : "config.yml");
		try {
			if (!existsSync(file)) return;
			const removed = removeHostBlock(readFileSync(file, "utf8"), host, kind === "github" ? [] : ["hosts"]);
			if (removed.removed) writeFileAtomic(file, removed.text);
		} catch (error) {
			this.#d.log({ event: "forge-own-file-unreadable", cli: cliOf(kind), host, detail: String((error as Error).message).slice(0, 200) });
		}
	}

	// ---- Remove all data ---------------------------------------------------------------------------------------------------

	/**
	 * The hosts a removal has to look at: the recipe's forges and every host the record names (a recipe replaced since the login leaves entries under a host no forge lists any more). Each host
	 * appears once, under the kind its entries were recorded with.
	 */
	removalHosts(forges: readonly Forge[]): Array<{ kind: ForgeKind; host: string }> {
		const record = readAccountsRecord(this.#d.layout);
		const out: Array<{ kind: ForgeKind; host: string }> = [];
		for (const h of [...forges, ...record.entries, ...record.left]) if (!out.some((o) => o.kind === h.kind && hostKey(o.host) === hostKey(h.host))) out.push({ kind: h.kind, host: h.host });
		return out;
	}

	/**
	 * What **Remove all data** would leave in the store (spec: Uninstall and data): the entries of these hosts that the app does not own, each marked `changed` when the app made it and something
	 * else wrote over it, `foreign` when another program made it, `beside` when the app made it and it is intact but a foreign entry sits beside it on the host (the sign-out would delete both, so it
	 * runs none; the app's entry is listed before the removal and after it). With `owned`, an entry the app still owns on a host without a foreign entry is listed as well (`failed`): after a removal it means the removal did not work.
	 * Lists the store afresh and settles the record against it, as every other check does; a listing that fails is a failure, never an empty answer.
	 */
	async survey(hosts: ReadonlyArray<{ kind: ForgeKind; host: string }>, options: { owned?: boolean } = {}): Promise<{ ok: true; entries: LeftEntry[] } | { ok: false; detail: string }> {
		const entries: LeftEntry[] = [];
		for (const { kind, host } of hosts) {
			const slot = this.#slot(kind, host);
			const outcome = await this.#exclusive(slot, async () => {
				const settled = await this.#settle(kind, host, slot);
				if ("failed" in settled) return settled;
				const split = classify(settled.entries, settled.record);
				const keyed = (list: readonly StoreEntry[]): Set<string> => new Set(list.map((e) => JSON.stringify([e.name, e.account])));
				const changed = keyed(split.changed);
				const beside = keyed(split.beside);
				const found: LeftEntry[] = split.foreign.map((e) => {
					const k = JSON.stringify([e.name, e.account]);
					return { name: e.name, account: e.account, host, why: beside.has(k) ? "beside" : changed.has(k) ? "changed" : "foreign" };
				});
				// With a foreign entry on the host the sign-out runs none, so the app's own intact entries stay too (T14-F001): they are named before the removal and again after it.
				if (split.foreign.length > 0) found.push(...split.owned.map((e): LeftEntry => ({ name: e.name, account: e.account, host, why: "beside" })));
				else if (options.owned === true) found.push(...split.owned.map((e): LeftEntry => ({ name: e.name, account: e.account, host, why: "failed" })));
				return { found };
			});
			if ("failed" in outcome) return { ok: false, detail: outcome.failed };
			entries.push(...outcome.found);
		}
		return { ok: true, entries };
	}

	/**
	 * Signs out of every host, one after another, through the ownership rule of **Removing a login**: the CLI's logout runs only when every entry of the host is the app's own; with a foreign
	 * entry beside them it runs none, and marks the app's entries `left`. Called after the stop sequence, so a sign-in that was waiting is put back to rest first (`cancel`), and the limits of the
	 * calls are the normal ones again (`resume`). Returns the first line of each host whose logout failed.
	 */
	async removeLogins(hosts: ReadonlyArray<{ kind: ForgeKind; host: string }>): Promise<string[]> {
		this.resume();
		const problems: string[] = [];
		for (const { kind, host } of hosts) {
			this.cancel(host);
			await this.signOut(kind, host);
			const flow = this.flowOf(host);
			if (flow.phase === "failed" || flow.phase === "store-unavailable") problems.push(`${host}: ${flow.detail}`);
		}
		return problems;
	}

	// ---- the rest of the actions -----------------------------------------------------------------------------------------

	/**
	 * Stops a login that waits and goes back to `ready`; the checks ran already, and every login checks again before it writes. A host whose checks are running goes back to `idle`. A login that is
	 * `working` (glab is signing in, gh has exited and the entries are being recorded) is left alone: it ends in a recorded login and its verdict, never in an entry the app made and does not know
	 * (T10R-F001).
	 */
	cancel(host: string): void {
		const slot = this.#hosts.get(hostKey(host));
		if (slot === undefined || slot.flow.phase === "working") return;
		const waiting = slot.child !== null || ["waiting-code", "code"].includes(slot.flow.phase);
		const checking = slot.flow.phase === "checking";
		slot.attempt++;
		const child = slot.child;
		this.#release(slot);
		child?.kill();
		if (waiting) this.#set(slot, { phase: "ready" });
		else if (checking) this.#set(slot, { phase: "idle" });
	}

	open(kind: ForgeKind, host: string): void {
		const slot = this.#slot(kind, host);
		const shows = kind === "github" ? slot.flow.phase === "code" : ["ready", "failed"].includes(slot.flow.phase);
		if (shows) this.#d.openExternal(kind === "github" ? githubDeviceUrl(host) : gitlabTokenUrl(host));
	}

	copyCode(host: string): void {
		const slot = this.#hosts.get(hostKey(host));
		if (slot?.flow.phase === "code") this.#d.writeClipboard(slot.flow.code);
	}

	/** The request of a page (the caller has checked that the host is one of the recipe's). */
	async act(action: ForgeAction): Promise<void> {
		switch (action.type) {
			case "forge-begin":
				return this.begin(action.kind, action.host);
			case "forge-start":
				return this.startGithub(action.host);
			case "forge-token":
				return this.signInGitlab(action.host, action.token);
			case "forge-cancel":
				return this.cancel(action.host);
			case "forge-open":
				return this.open(action.kind, action.host);
			case "forge-copy-code":
				return this.copyCode(action.host);
			case "forge-sign-out":
				return this.signOut(action.kind, action.host);
		}
	}

	/** The app goes on after a stop that did not end it: calls get their normal limits again. */
	resume(): void {
		this.#disposed = false;
		this.#deadline = null;
	}

	/** The app is quitting: a login that waits for approval ends with it. One that is `working` is not cut off; `settled` waits for it. */
	dispose(): void {
		this.#disposed = true;
		this.#deadline = (this.#d.now ?? Date.now)() + (this.#d.settleMs ?? SETTLE_MS);
		for (const slot of this.#hosts.values()) {
			if (slot.flow.phase === "working") continue;
			slot.attempt++;
			const child = slot.child;
			this.#release(slot);
			child?.kill();
		}
	}

	/**
	 * Resolves when every operation under way has ended, or after `maxMs` (default 75 s): the quit waits for a login that glab or gh is finishing, so its entry is recorded with its time and its
	 * verdict runs (T10R-F001). The whole chain is bounded by the same 75 s, measured from the quit (T10RR-F002): the glab login that was running has its own 60 s limit, and every call made after
	 * the quit began (the status, a logout on the plain-text path) gets at most what is left of the 75 s, and at least 2 s. The store's listings between them have their own 10 s limits (spec: The
	 * code-host screens), so the chain can end that much later; the stop that follows then reports a CLI that still runs as a leftover. A call cut off by its limit leaves the verdict "could not
	 * verify", which fails the step and keeps the login.
	 */
	settled(maxMs: number = this.#d.settleMs ?? SETTLE_MS): Promise<void> {
		if (this.#inflight.size === 0) return Promise.resolve();
		return new Promise((resolve) => {
			const timer = this.#setTimer(resolve, maxMs);
			void Promise.allSettled([...this.#inflight]).then(() => {
				this.#clearTimer(timer);
				resolve();
			});
		});
	}

	async #prepare(kind: ForgeKind, host: string): Promise<{ file: string; env: EnvMap } | null> {
		const current = this.#d.current();
		if (current === null) return null;
		const file = forgeBinary(this.#d.layout, current, kind);
		if (file === null) return null;
		let proxyEnv: Record<string, string> = {};
		try {
			proxyEnv = (await this.#d.proxyEnv?.([host])) ?? {};
		} catch {
			proxyEnv = {};
		}
		return { file, env: forgeEnv({ layout: this.#d.layout, current, appEnv: this.#d.appEnv, kind, proxyEnv }) };
	}
}
