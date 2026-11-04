import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../bootstrap/fsutil.ts";
import type { EnvMap } from "../env.ts";
import type { CurrentTools, Layout } from "../paths.ts";
import type { CommandRunner, CredentialStore, StoreEntry } from "../platform/types.ts";
import type { RuntimeEvent } from "../runtime/log.ts";
import type { EntryName, ForgeAction, ForgeFlow, ForgeState, ForgeView } from "../../shared/accounts.ts";
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
	setTimer?: (fn: () => void, ms: number) => unknown;
	clearTimer?: (timer: unknown) => void;
}

const LOGIN_WAIT_MS = 15 * 60_000;
const CALL_MS = 60_000;

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
}

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
			// Before the store is listed, the row says what the record says; `refresh` corrects it.
			const record = readAccountsRecord(this.#d.layout);
			const mine = (e: { kind: ForgeKind; host: string }): boolean => e.kind === kind && e.host === host;
			const state: ForgeState = record.left.some(mine) ? "left" : record.entries.some(mine) ? "signed-in" : "not-signed-in";
			slot = { kind, flow: { phase: "idle" }, state, entries: record.left.filter(mine).map((e) => ({ name: e.name, account: e.account })), child: null, timer: null, code: null, attempt: 0 };
			this.#hosts.set(key, slot);
		}
		return slot;
	}

	#set(slot: HostState, flow: ForgeFlow): void {
		slot.flow = flow;
		this.#emit();
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
			if (slot.child !== null || slot.flow.phase === "checking") continue;
			await this.#settle(f.kind, f.host, slot);
		}
		this.#emit();
	}

	// ---- the checks before a login -------------------------------------------------------------------------------------

	/**
	 * The store probe, then the existing-sign-in check, in this order; the step stops before the person makes a token when one fails. Passing leaves the host `ready`.
	 */
	async begin(kind: ForgeKind, host: string): Promise<void> {
		const slot = this.#slot(kind, host);
		if (slot.child !== null || ["checking", "waiting-code", "code", "working"].includes(slot.flow.phase)) return;
		const attempt = ++slot.attempt;
		this.#set(slot, { phase: "checking" });
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
		const checked = await this.#check("github", host, slot);
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
			this.#afterLogin("github", host, slot, attempt, before, /saved in plain text/i.test(output)).catch((error: Error) => this.#failed(slot, attempt, error));
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
		const args = ["auth", "login", "--hostname", host, "--git-protocol", "https", "--api-protocol", "https", "--stdin"];
		this.#d.log({ event: "forge-login-start", cli: "glab", host, args });
		const result = await this.#d.run(prepared.file, args, { stdin: `${secret}\n`, env: prepared.env, replaceEnv: true, timeoutMs: this.#d.callMs ?? CALL_MS });
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
			const removal = await this.#remove(kind, host, slot, "plain-text");
			if (slot.attempt !== attempt) return;
			this.#set(slot, { phase: "plain-text", detail: removal.phase === "signed-out" ? verdict.reason : `${verdict.reason}; removing it ended as ${removal.phase}` });
			return;
		}
		if (!verdict.verified || !after.ok) {
			this.#set(slot, { phase: "unverified", detail: after.ok ? verdict.reason : `the credential store could not be listed: ${after.detail}` });
			return;
		}
		this.#set(slot, { phase: "done" });
		for (const l of this.#signedIn) l(kind, host);
	}

	/** After either login: gh's `tokenSource` must be `keyring` and neither of gh's files may hold a token for the host; glab's `config.yml` may hold none. */
	async verdict(kind: ForgeKind, host: string): Promise<Verdict> {
		const prepared = await this.#prepare(kind, host);
		if (prepared === null) return { plain: false, verified: false, reason: `could not verify: ${cliOf(kind)} is not installed` };
		if (kind === "github") {
			const status = await this.#d.run(prepared.file, ["auth", "status", "--hostname", host, "--json", "hosts"], { env: prepared.env, replaceEnv: true, timeoutMs: this.#d.callMs ?? CALL_MS });
			const source = status.code === 0 ? ghTokenSource(status.stdout, host).source : null;
			const files = ghFileFindings(forgeConfigDir(this.#d.layout, "github"), host);
			return ghTokenVerdict({ source, hostsTokens: files.hosts.own, configTokens: files.config.own });
		}
		const status = await this.#d.run(prepared.file, ["auth", "status", "--hostname", host], { env: prepared.env, replaceEnv: true, timeoutMs: this.#d.callMs ?? CALL_MS });
		return glabTokenVerdict({ configTokens: glabFileFindings(forgeConfigDir(this.#d.layout, "gitlab"), host).own, statusExit: status.code });
	}

	// ---- removing a login ------------------------------------------------------------------------------------------------

	async signOut(kind: ForgeKind, host: string): Promise<void> {
		const slot = this.#slot(kind, host);
		if (slot.child !== null || ["checking", "waiting-code", "code", "working"].includes(slot.flow.phase)) return;
		const attempt = ++slot.attempt;
		this.#set(slot, { phase: "working" });
		const outcome = await this.#remove(kind, host, slot, "sign-out");
		if (slot.attempt !== attempt) return;
		this.#set(slot, outcome);
	}

	/**
	 * Removing a login acts only on entries the app owns (spec: **Removing a login**). Right before it, the host's entries are listed again with their times. When every one is owned, or there is
	 * none, the CLI's logout runs and the record is dropped. When any is foreign, no logout runs: the host leaves the app's own `hosts.yml` or `config.yml`, every entry the app made is marked `left`
	 * (they stay in the store beside the foreign one), and the outcome names what stays.
	 */
	async #remove(kind: ForgeKind, host: string, slot: HostState, why: "sign-out" | "plain-text"): Promise<ForgeFlow> {
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
		const prepared = await this.#prepare(kind, host);
		if (prepared === null) return { phase: "failed", detail: `${cliOf(kind)} is not installed` };
		const result = await this.#d.run(prepared.file, ["auth", "logout", "--hostname", host], { env: prepared.env, replaceEnv: true, timeoutMs: this.#d.callMs ?? CALL_MS });
		this.#d.log({ event: "forge-logout", cli: cliOf(kind), host, why, exit: result.code });
		if (result.code !== 0) return { phase: "failed", detail: hideSecrets(loginLine(`${result.stdout}\n${result.stderr}`)) };
		// A logout that left an owned entry in the store did not finish it; the record keeps what the store still holds.
		const after = await listHostEntries(this.#d.credentials, kind, host);
		const held = readAccountsRecord(this.#d.layout);
		const dropped = dropHost(held, kind, host);
		const record = after.ok ? this.#keepSurvivors(dropped, held, after.entries, kind, host) : dropped;
		this.#writeRecord(record);
		slot.state = after.ok ? stateOf(record, after.entries, kind, host) : "not-signed-in";
		slot.entries = [];
		return { phase: "signed-out" };
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

	// ---- the rest of the actions -----------------------------------------------------------------------------------------

	/** Stops a login that waits and goes back to `ready`; the checks ran already, and every login checks again before it writes. */
	cancel(host: string): void {
		const slot = this.#hosts.get(hostKey(host));
		if (slot === undefined) return;
		const waiting = slot.child !== null || ["waiting-code", "code"].includes(slot.flow.phase);
		slot.attempt++;
		const child = slot.child;
		this.#release(slot);
		child?.kill();
		if (waiting) this.#set(slot, { phase: "ready" });
	}

	/** Back to the start of a host: the next `begin` runs the checks again. */
	reset(host: string): void {
		const slot = this.#hosts.get(hostKey(host));
		if (slot === undefined) return;
		this.cancel(host);
		this.#set(slot, { phase: "idle" });
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

	/** The app is quitting: a login that waits ends with it. */
	dispose(): void {
		for (const slot of this.#hosts.values()) {
			slot.attempt++;
			const child = slot.child;
			this.#release(slot);
			child?.kill();
		}
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
