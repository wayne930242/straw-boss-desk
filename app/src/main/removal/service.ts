import { rm } from "node:fs/promises";
import type { Forge } from "../../shared/wizard.ts";
import type { Leftover, LeftEntry, RemovalPlan, RemovalProblem, RemovalResult, RemoveState, RemoveStep } from "../../shared/computer.ts";
import type { ForgeKind } from "../accounts/existing.ts";
import type { Layout } from "../paths.ts";
import type { Platform } from "../platform/types.ts";
import type { RuntimeEvent } from "../runtime/log.ts";
import { deleteChildren, measureBytes, type DeleteResult } from "./files.ts";
import { claudeItem, safeStorageItem } from "./names.ts";
import { assertDeletableRoot, fallbackIsOurs, PENDING_FILE, writePending } from "./pending.ts";

// **Remove all data** (spec: Uninstall and data). The order, and why:
//   1. plan: list the credential store, measure the folder, say what stays; nothing is touched, and a store that cannot be listed refuses (the app cannot tell its own sign-ins from the PM's);
//   2. stop: the stop sequence of a quit; programs still running from `<root>/tools` stop the removal before anything is deleted (the kill rule is the stop's, unchanged);
//   3. logins: the code hosts' sign-outs through the ownership rule, Claude Code's sign-out, the Linear key, the user PATH entry (Windows), the Keychain items of this build (macOS);
//   4. files: the marker `remove-pending`, then everything in `<root>` but `electron/`, and the fallback folder; the rest goes after the app's exit (`cleanup.ts`).
// Steps 3 and 4 go on past a failure and name it in the result: a sign-in the app made and could not remove is listed by name, never silently dropped with the record that knew it.

export interface RemovalAccounts {
	removalHosts(forges: readonly Forge[]): Array<{ kind: ForgeKind; host: string }>;
	survey(hosts: ReadonlyArray<{ kind: ForgeKind; host: string }>, options?: { owned?: boolean }): Promise<{ ok: true; entries: LeftEntry[] } | { ok: false; detail: string }>;
	removeLogins(hosts: ReadonlyArray<{ kind: ForgeKind; host: string }>): Promise<string[]>;
}

export interface RemovalDeps {
	layout: Layout;
	home: string;
	platform: Pick<Platform, "credentials" | "userPath">;
	/** The running build's product name, which names its Safe Storage item. */
	productName: string;
	accounts: RemovalAccounts;
	forges(): Forge[];
	/** `flow` is the sign-in service's state after `signOut`: `failed` (with its `detail`) when `claude auth logout` did not work, which it reports by state and not by throwing. */
	claude: { resume(): void; signOut(): Promise<void>; readonly flow?: { phase: string; detail?: string } };
	linear: { resume(): void; signOut(): Promise<void> };
	/** The work folder, which the removal leaves with its clones; null when none was chosen. */
	workFolder(): string | null;
	/** The stop sequence of a quit. `ok` is false when a program of this app still runs from `<root>/tools`, and `busy` when another stop (a quit's, an update's) was under way: nothing was started, and that stop goes on. */
	stop(): Promise<{ ok: boolean; leftovers: Leftover[]; busy?: boolean }>;
	/** Takes the app up again after a stop that could not finish: the stack starts if it ran before, and the sign-in services work again. Not called after a `busy` stop, which put nothing down. */
	resume(): Promise<void>;
	/** This app's pid and start token, for the marker (a second launch must not finish the removal under it). A start token that cannot be read is null. */
	self?: () => Promise<{ pid: number; startTime: string | null }>;
	/** Records that the cleanup must run when the app exits. `marked` is whether `remove-pending` was written: the cleanup then goes on only while the marker is there (T14R-F002). */
	arm(spec: { root: string; fallbackDir: string | null; marked: boolean }): void;
	/** Leaves the app (the PM read the result). */
	quit(): void;
	log: RuntimeEvent;
	/** Called once, right before the first file is deleted: the logs live in the folder that goes, so the caller stops writing to them. */
	beforeFiles?: () => void;
	measure?: (root: string) => Promise<number | null>;
	deleteChildren?: (root: string, keep: readonly string[]) => Promise<DeleteResult>;
	/** Deletes a folder tree (the fallback folder); default `fs.rm` with retries. */
	removeTree?: (path: string) => Promise<void>;
}

const firstLine = (text: string): string => text.split(/\r?\n/)[0]?.slice(0, 300) ?? "";

/**
 * What a Claude sign-out that failed means for the result (T14-F008). On macOS the app's Keychain item is deleted by name afterwards, so the failure is only logged. On Windows the login is the file in
 * the Claude folder, which goes with the folder, unless it lives in Credential Manager (R11-F004, not yet verified on a machine): then a failed logout can leave it, so it is named.
 */
export function claudeLogoutProblem(platform: NodeJS.Platform, detail: string): RemovalProblem | null {
	return platform === "win32" ? { step: "claude", detail: firstLine(detail) } : null;
}

export class RemovalService {
	readonly #d: RemovalDeps;
	readonly #listeners = new Set<() => void>();
	#state: RemoveState = { phase: "idle" };

	constructor(deps: RemovalDeps) {
		this.#d = deps;
	}

	onChange(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	get state(): RemoveState {
		return this.#state;
	}

	/** True from the first step of the removal on: the other parts of the app (keep awake, a second plan) are left alone. */
	#locked(): boolean {
		return this.#state.phase === "working" || this.#state.phase === "done";
	}

	/** A log that cannot be written must not change what the removal does: its folder may be the one that was just deleted. */
	#log(fields: Parameters<RuntimeEvent>[0]): void {
		try {
			this.#d.log(fields);
		} catch {
			// nothing to do: the log is gone with the folder
		}
	}

	#set(state: RemoveState): void {
		this.#state = state;
		for (const l of this.#listeners) l();
	}

	// ---- 1. the plan -----------------------------------------------------------------------------------------------------

	async plan(): Promise<void> {
		if (this.#state.phase === "planning" || this.#locked()) return;
		this.#set({ phase: "planning" });
		const { layout, home } = this.#d;
		try {
			assertDeletableRoot(layout.root, home, layout.platform);
			const hosts = this.#d.accounts.removalHosts(this.#d.forges());
			const surveyed = await this.#d.accounts.survey(hosts);
			if (!surveyed.ok) {
				this.#log({ event: "remove-refused", reason: "store", detail: surveyed.detail });
				this.#set({ phase: "refused", reason: "store", detail: surveyed.detail });
				return;
			}
			const bytes = await (this.#d.measure ?? ((root: string) => measureBytes(root)))(layout.root);
			const plan: RemovalPlan = {
				root: layout.root,
				bytes,
				workFolder: this.#d.workFolder(),
				left: surveyed.entries,
				pathEntry: this.#d.platform.userPath.supported ? layout.tools.shims : null,
			};
			this.#set({ phase: "confirm", plan });
		} catch (error) {
			this.#set({ phase: "failed", detail: firstLine((error as Error).message) });
		}
	}

	cancel(): void {
		if (this.#state.phase === "working" || this.#state.phase === "done" || this.#state.phase === "planning") return;
		this.#set({ phase: "idle" });
	}

	// ---- 2 to 4: the removal -----------------------------------------------------------------------------------------------

	async confirm(): Promise<void> {
		const shown = this.#state;
		if (shown.phase !== "confirm") return;
		const { layout, home } = this.#d;
		const step = (name: RemoveStep): void => {
			this.#set({ phase: "working", step: name });
			this.#log({ event: "remove-step", step: name });
		};
		step("stopping");
		const problems: RemovalProblem[] = [];
		let left: LeftEntry[] = shown.plan.left;
		try {
			const stopped = await this.#d.stop();
			if (stopped.busy === true) {
				// Another stop (an update's, a quit's) is under way and owns the stack; starting it again here would undo that stop.
				this.#log({ event: "remove-stop-busy" });
				this.#set({ phase: "busy" });
				return;
			}
			if (!stopped.ok) {
				this.#log({ event: "remove-stop-failed", leftovers: stopped.leftovers.length });
				await this.#d.resume().catch(() => undefined);
				this.#set({ phase: "stop-failed", leftovers: stopped.leftovers, detail: "" });
				return;
			}
			assertDeletableRoot(layout.root, home, layout.platform);

			step("logins");
			const hosts = this.#d.accounts.removalHosts(this.#d.forges());
			for (const problem of await this.#d.accounts.removeLogins(hosts)) problems.push({ step: "logins", detail: problem });
			// What the store still holds, read once more before the record that names the app's own entries goes: anything the app made and could not remove is listed as such.
			const after = await this.#d.accounts.survey(hosts, { owned: true });
			if (after.ok) left = after.entries;
			else problems.push({ step: "logins", detail: after.detail });

			step("claude");
			await this.#claude(problems);

			step("linear");
			this.#d.linear.resume();
			await this.#d.linear.signOut().catch((error: Error) => problems.push({ step: "linear", detail: firstLine(error.message) }));

			step("path");
			await this.#userPath(problems);

			step("safe-storage");
			await this.#keychainItems(problems);
		} catch (error) {
			// Nothing in `<root>` was deleted yet: put the app back as it was and say what went wrong.
			this.#log({ event: "remove-failed", detail: firstLine((error as Error).message) });
			await this.#d.resume().catch(() => undefined);
			this.#set({ phase: "failed", detail: firstLine((error as Error).message) });
			return;
		}

		step("files");
		await this.#files(problems);
		const result: RemovalResult = { root: layout.root, workFolder: shown.plan.workFolder, left, problems };
		this.#log({ event: "remove-done", left: left.length, problems: problems.length });
		this.#set({ phase: "done", result });
	}

	async #claude(problems: RemovalProblem[]): Promise<void> {
		const { layout } = this.#d;
		this.#d.claude.resume();
		// The CLI's own logout first (it also tells Claude's service); what a failure of it means is `claudeLogoutProblem`'s.
		let failure: string | null = null;
		await this.#d.claude.signOut().catch((error: Error) => {
			failure = firstLine(error.message);
		});
		const flow = this.#d.claude.flow;
		if (failure === null && flow?.phase === "failed") failure = firstLine(flow.detail ?? "");
		if (failure !== null) {
			this.#log({ event: "remove-claude-logout-failed", detail: failure });
			const problem = claudeLogoutProblem(layout.platform, failure);
			if (problem !== null) problems.push(problem);
		}
		if (layout.platform !== "darwin") return;
		await this.#deleteItems([claudeItem(layout.claude)], "claude", problems);
	}

	async #keychainItems(problems: RemovalProblem[]): Promise<void> {
		if (this.#d.layout.platform !== "darwin") return;
		await this.#deleteItems([safeStorageItem(this.#d.productName)], "safe-storage", problems);
	}

	/** Deletes the Keychain items whose service is exactly one of `names` (the names come from `names.ts`, computed from this build and this root). */
	async #deleteItems(names: string[], step: RemoveStep, problems: RemovalProblem[]): Promise<void> {
		const { credentials } = this.#d.platform;
		try {
			for (const entry of await credentials.list(names)) {
				if (!names.includes(entry.name)) continue;
				try {
					await credentials.delete({ name: entry.name, account: entry.account });
					this.#log({ event: "remove-keychain-item", step, name: entry.name });
				} catch (error) {
					problems.push({ step, detail: firstLine((error as Error).message) });
				}
			}
		} catch (error) {
			problems.push({ step, detail: firstLine((error as Error).message) });
		}
	}

	async #userPath(problems: RemovalProblem[]): Promise<void> {
		const { userPath } = this.#d.platform;
		if (!userPath.supported) return;
		try {
			const removed = await userPath.remove(this.#d.layout.tools.shims);
			this.#log({ event: "remove-user-path", changed: removed.changed });
		} catch (error) {
			problems.push({ step: "path", detail: firstLine((error as Error).message) });
		}
	}

	/** The marker first, so a crash from here on is finished by the next launch; then everything but Chromium's folder. */
	async #files(problems: RemovalProblem[]): Promise<void> {
		const { layout, home } = this.#d;
		let fallbackDir: string | null = null;
		try {
			this.#d.beforeFiles?.();
		} catch {
			// the log could not be closed; the writes after this are caught one by one
		}
		const recorded = layout.record.fallbackDir;
		if (recorded !== null) {
			if (fallbackIsOurs({ fallbackDir: recorded, home, realRoot: layout.record.realRoot, platform: layout.platform })) fallbackDir = recorded;
			else problems.push({ step: "files", detail: `the fallback folder ${recorded} is not this app's, so it was not deleted` });
		}
		let owner: { pid: number; startTime: string } | null = null;
		try {
			const me = await this.#d.self?.();
			if (me !== undefined && me.startTime !== null) owner = { pid: me.pid, startTime: me.startTime };
		} catch {
			// no start token: the marker holds nothing against a second launch, as before
		}
		let marked = false;
		try {
			writePending(layout.root, { schema: 1, id: layout.id, fallbackDir, owner });
			marked = true;
		} catch (error) {
			problems.push({ step: "files", detail: `remove-pending could not be written: ${firstLine((error as Error).message)}` });
		}
		this.#d.arm({ root: layout.root, fallbackDir, marked });
		if (fallbackDir !== null) {
			try {
				await (this.#d.removeTree ?? ((path: string) => rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 })))(fallbackDir);
			} catch (error) {
				problems.push({ step: "files", detail: `${fallbackDir}: ${firstLine((error as Error).message)}` });
			}
		}
		try {
			const removeChildren = this.#d.deleteChildren ?? ((root: string, keep: readonly string[]) => deleteChildren(root, keep, { caseInsensitive: layout.platform === "win32" }));
			const deleted = await removeChildren(layout.root, ["electron", PENDING_FILE]);
			for (const f of deleted.failed) problems.push({ step: "files", detail: `${f.name}: ${f.detail}` });
		} catch (error) {
			problems.push({ step: "files", detail: firstLine((error as Error).message) });
		}
	}

	quit(): void {
		if (this.#state.phase === "done") this.#d.quit();
	}
}
