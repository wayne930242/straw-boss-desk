import type { UpdateAction, UpdatesView } from "../../shared/updates.ts";
import type { RuntimeEvent } from "../runtime/log.ts";
import { CHECK_EVERY_MS, FIRST_CHECK_AFTER_MS, type ShellUpdater } from "./shell.ts";
import type { StackUpdater } from "./stack.ts";

// The two channels behind one settings section (spec: Settings, Updates): **Check now** asks both, the checks also run at start and every six hours, and the section's requests reach the
// channel they belong to. Each channel decides for itself whether a request fits its state.

export interface UpdatesServiceDeps {
	shell: ShellUpdater;
	stack: StackUpdater;
	appVersion: string;
	platform: "win32" | "darwin";
	/** The wizard is over: before that nothing is checked (the settings are not reachable either). */
	enabled(): boolean;
	log: RuntimeEvent;
	now?: () => Date;
	/** Test hooks for the timers. */
	setTimeout?: (fn: () => void, ms: number) => { unref?: () => void };
	setInterval?: (fn: () => void, ms: number) => { unref?: () => void };
	clear?: (timer: unknown) => void;
}

export class UpdatesService {
	readonly #d: UpdatesServiceDeps;
	readonly #listeners = new Set<() => void>();
	#checking = false;
	#checkedAt: string | null = null;
	#timers: unknown[] = [];

	constructor(deps: UpdatesServiceDeps) {
		this.#d = deps;
		deps.shell.onChange(() => this.#emit());
		deps.stack.onChange(() => this.#emit());
	}

	onChange(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	#emit(): void {
		for (const l of this.#listeners) l();
	}

	view(): UpdatesView {
		return {
			appVersion: this.#d.appVersion,
			generation: this.#d.stack.generation,
			shell: this.#d.shell.state,
			stack: this.#d.stack.state,
			checking: this.#checking,
			checkedAt: this.#checkedAt,
			platform: this.#d.platform,
		};
	}

	/** The notice over the GUI: a version ready to install (Windows) or to download (macOS), until the PM acts. */
	notice(): { version: string; action: "restart" | "open" } | null {
		const shell = this.#d.shell.state;
		if (shell.phase === "ready") return { version: shell.version, action: "restart" };
		if (shell.phase === "available") return { version: shell.version, action: "open" };
		return null;
	}

	/** Asks both channels, one after the other; a channel that is busy skips its turn. */
	async checkNow(): Promise<void> {
		if (this.#checking || this.#d.stack.busy) return;
		this.#checking = true;
		this.#emit();
		try {
			await this.#d.shell.check();
			await this.#d.stack.check();
		} catch (error) {
			this.#d.log({ event: "update-check-failed", detail: (error as Error).message.slice(0, 300) });
		} finally {
			this.#checking = false;
			this.#checkedAt = (this.#d.now ?? (() => new Date()))().toISOString();
			this.#emit();
		}
	}

	async act(action: UpdateAction): Promise<void> {
		switch (action.type) {
			case "update-check":
				await this.checkNow();
				return;
			case "update-apply":
				await this.#d.stack.apply();
				return;
			case "update-restart":
				await this.#d.shell.restart();
				return;
			case "update-download":
				await this.#d.shell.download();
				return;
			case "update-reveal":
				this.#d.shell.reveal();
				return;
		}
	}

	/** The first check a little after the start, then every six hours. The timers do not keep the app alive. */
	start(): void {
		const later = this.#d.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
		const every = this.#d.setInterval ?? ((fn, ms) => setInterval(fn, ms));
		const run = (): void => {
			if (this.#d.enabled()) void this.checkNow();
		};
		for (const timer of [later(run, FIRST_CHECK_AFTER_MS), every(run, CHECK_EVERY_MS)]) {
			timer.unref?.();
			this.#timers.push(timer);
		}
	}

	dispose(): void {
		const clear = this.#d.clear ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
		for (const timer of this.#timers) clear(timer);
		this.#timers = [];
	}
}
