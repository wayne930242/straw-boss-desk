import type { RuntimeEvent } from "../runtime/log.ts";
import type { Recipe } from "../../../../recipe/validate.d.mts";
import { platformKey, type PlatformKey, type Stack } from "../bootstrap/stack.ts";
import { FetchRefused } from "../net/safe-fetch.ts";
import type { RepoSpec } from "../projects/runner.ts";
import type { ProjectsView } from "../../shared/projects.ts";
import type { ActiveRecipeView, RecipeAction, RecipeCardState, RecipeCardView, RecipeSource } from "../../shared/recipe-update.ts";
import type { Forge, LaterItem } from "../../shared/wizard.ts";
import { compareVersions } from "../update/verify.ts";
import type { Intake } from "../wizard/recipe-intake.ts";
import { needsInstall, recipeChanges, repoSpecs } from "./diff.ts";
import type { RecipeMemoStore } from "./store.ts";

// The Team recipe card's logic (spec: Settings, Team recipe; team-profile section 5, Delivery and updates): the daily check of the recipe's own `updateUrl`, **Replace** with another file, the change
// list, **Apply** and **Keep**. A newer version with the same `id` is validated like a new file and offered as a change list, never applied silently; **Apply** writes the file, runs the install step
// when the changes need it (the stack stops for it, as for every engine run), and then runs the projects step for what changed in the repository list. A failed install puts the old recipe back.

type Accepted = Extract<Intake, { ok: true }>;

export interface RecipeServiceDeps {
	/** The active recipe, or null for "I have no recipe". */
	active(): Recipe | null;
	stack(): Stack;
	/** The platform key of this machine (`platformKey`), for the version a tool's pin has here. */
	key?: PlatformKey;
	/** Validates a recipe file's text against the stack in force. */
	intake(fileName: string, text: string): Intake;
	/** The fetch of `updateUrl` under the SSRF rules (`net/safe-fetch.ts`); throws `FetchRefused`. */
	fetchText(url: string): Promise<{ text: string }>;
	/** The native file dialog; null when cancelled. Throws a plain message when the file cannot be read. */
	pickFile(): Promise<{ name: string; text: string } | null>;
	/** Makes `next` the active recipe (the file under `recipe/`, the controller's memory); returns the function that puts the old one back. */
	accept(next: Accepted, source: RecipeSource): () => void;
	/** Runs the install step for the active recipe with the stack stopped, and says how it ended. Throws when the stack cannot be stopped. */
	install(): Promise<{ ok: true } | { ok: false; stage: string; category: string }>;
	projects: { update(before: readonly RepoSpec[], after: readonly RepoSpec[]): Promise<void>; view(): ProjectsView; onChange(listener: () => void): () => void; retry(spec: RepoSpec): Promise<void> };
	/** Sign-ins the update adds are put off, so a banner offers them. */
	addLater(items: LaterItem[]): void;
	store: RecipeMemoStore;
	log: RuntimeEvent;
	/** The wizard is over: before that nothing is checked and nothing applies. */
	enabled(): boolean;
	now?: () => Date;
	setTimeout?: (fn: () => void, ms: number) => { unref?: () => void };
	setInterval?: (fn: () => void, ms: number) => { unref?: () => void };
	clear?: (timer: unknown) => void;
}

export const FIRST_CHECK_AFTER_MS = 20_000;
export const CHECK_EVERY_MS = 24 * 60 * 60_000;

const hostOf = (url: string): string => {
	try {
		return new URL(url).host;
	} catch {
		return "";
	}
};

export class RecipeService {
	readonly #d: RecipeServiceDeps;
	readonly #listeners = new Set<() => void>();
	#state: RecipeCardState;
	#offer: { intake: Accepted; origin: "url" | "file" } | null = null;
	#busy = false;
	/** A check, an apply or a Replace has run in this process, so the launch's first timer check has nothing left to do. */
	#touched = false;
	#timers: unknown[] = [];

	constructor(deps: RecipeServiceDeps) {
		this.#d = deps;
		this.#state = { phase: "idle", checkedAt: deps.store.read().checkedAt };
		deps.projects.onChange(() => this.#emit());
	}

	onChange(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	#emit(): void {
		for (const l of this.#listeners) l();
	}

	#set(state: RecipeCardState): void {
		this.#state = state;
		this.#emit();
	}

	get busy(): boolean {
		return this.#busy;
	}

	view(): RecipeCardView {
		const recipe = this.#d.active();
		const memo = this.#d.store.read();
		let active: ActiveRecipeView | null = null;
		if (recipe !== null) {
			const source: RecipeSource = memo.source ?? { kind: "file", fileName: `${recipe.id}.json` };
			active = { id: recipe.id, name: recipe.name, version: recipe.version, source, updateHost: recipe.updateUrl === undefined ? null : hostOf(recipe.updateUrl) };
		}
		return { active, state: this.#state, projects: this.#d.projects.view(), enabled: this.#d.enabled() };
	}

	// ---- checking and replacing --------------------------------------------------------------------------------------------

	#changesFor(candidate: Recipe): ReturnType<typeof recipeChanges> {
		const stack = this.#d.stack();
		const key = this.#d.key ?? platformKey(process.platform, process.arch);
		return recipeChanges(this.#d.active(), candidate, (name) => stack.optionalTools[name]?.assets[key]?.version ?? null);
	}

	/** The offer for `intake`, or the reason it is not one. */
	#judge(intake: Accepted, origin: "url" | "file"): RecipeCardState {
		const active = this.#d.active();
		const replaces = active === null || intake.recipe.id !== active.id;
		// An update keeps the id; a different id is a different recipe, which only the PM's own file may replace.
		if (origin === "url" && active !== null && replaces) return { phase: "refused", reason: "other-id", version: intake.recipe.version };
		if (!replaces && active !== null) {
			const order = compareVersions(intake.recipe.version, active.version);
			if (order <= 0) return origin === "url" ? { phase: "idle", checkedAt: this.#d.store.read().checkedAt } : { phase: "refused", reason: "not-newer", version: intake.recipe.version };
			const kept = this.#d.store.read().kept;
			if (origin === "url" && kept !== null && kept.id === intake.recipe.id && compareVersions(intake.recipe.version, kept.version) <= 0) return { phase: "kept", version: kept.version };
		}
		this.#offer = { intake, origin };
		return { phase: "offered", origin, id: intake.recipe.id, name: intake.recipe.name, version: intake.recipe.version, replaces, changes: this.#changesFor(intake.recipe), sha256: intake.sha256 };
	}

	#refuseInvalid(refused: Array<{ field: string; rule: string }>): RecipeCardState {
		return { phase: "refused", reason: "invalid", fields: refused.map((r) => ({ field: r.field, rule: r.rule })) };
	}

	/** Asks the recipe's `updateUrl`. A recipe without one has nothing to ask. */
	async check(options: { background?: boolean } = {}): Promise<void> {
		if (this.#busy || !this.#d.enabled()) return;
		// An outcome the PM has not acted on stays until the PM's next action: a timer never replaces it.
		if (options.background === true && (this.#state.phase === "applied" || this.#state.phase === "failed")) return;
		this.#touched = true;
		const active = this.#d.active();
		const url = active?.updateUrl;
		if (url === undefined) {
			this.#set({ phase: "idle", checkedAt: this.#d.store.read().checkedAt });
			return;
		}
		this.#busy = true;
		this.#offer = null;
		this.#set({ phase: "checking" });
		try {
			let text: string;
			try {
				text = (await this.#d.fetchText(url)).text;
			} catch (error) {
				if (error instanceof FetchRefused) {
					this.#d.log({ event: "recipe-fetch-refused", reason: error.reason, host: hostOf(error.url), status: error.status, detail: error.detail?.slice(0, 200) });
					this.#set({ phase: "refused", reason: "fetch", fetch: error.reason, ...(error.status !== undefined ? { status: error.status } : {}) });
					return;
				}
				throw error;
			}
			const intake = this.#d.intake(`${active?.id ?? "recipe"}.json`, text);
			this.#d.log({ event: "recipe-fetched", ok: intake.ok });
			const checkedAt = (this.#d.now ?? (() => new Date()))().toISOString();
			this.#d.store.update({ checkedAt });
			this.#set(intake.ok ? this.#judge(intake, "url") : this.#refuseInvalid(intake.refused));
			if (this.#state.phase === "idle") this.#set({ phase: "idle", checkedAt });
		} catch (error) {
			this.#d.log({ event: "recipe-check-failed", detail: (error as Error).message.slice(0, 300) });
			this.#set({ phase: "error", kind: "other", detail: (error as Error).message.split(/\r?\n/)[0]?.slice(0, 300) ?? "" });
		} finally {
			this.#busy = false;
			this.#emit();
		}
	}

	/** **Replace**: a file the PM chooses, shown as the same change list. */
	async replace(): Promise<void> {
		if (this.#busy || !this.#d.enabled()) return;
		this.#busy = true;
		// The PM is at the card: the launch's first timer check must not clear the offer that the chosen file is about to make (CIN-F010).
		this.#touched = true;
		try {
			let picked: { name: string; text: string } | null;
			try {
				picked = await this.#d.pickFile();
			} catch (error) {
				this.#d.log({ event: "recipe-unreadable", detail: (error as Error).message.slice(0, 200) });
				this.#set({ phase: "refused", reason: "unreadable" });
				return;
			}
			if (picked === null) return;
			const intake = this.#d.intake(picked.name, picked.text);
			if (!intake.ok) {
				this.#d.log({ event: "recipe-refused", refused: intake.refused.map((r) => `${r.field}:${r.rule}`) });
				this.#set(this.#refuseInvalid(intake.refused));
				return;
			}
			this.#offer = null;
			this.#set(this.#judge(intake, "file"));
		} finally {
			this.#busy = false;
			this.#emit();
		}
	}

	keep(): void {
		const offer = this.#offer;
		if (this.#state.phase !== "offered" || offer === null) return;
		this.#offer = null;
		// A file the PM chose and then kept out is dropped without a memory; an update is not offered again until a higher version.
		if (offer.origin === "url") this.#d.store.update({ kept: { id: offer.intake.recipe.id, version: offer.intake.recipe.version } });
		this.#set(offer.origin === "url" ? { phase: "kept", version: offer.intake.recipe.version } : { phase: "idle", checkedAt: this.#d.store.read().checkedAt });
	}

	// ---- applying ----------------------------------------------------------------------------------------------------------

	async apply(): Promise<void> {
		const offer = this.#offer;
		if (this.#busy || offer === null || this.#state.phase !== "offered" || !this.#d.enabled()) return;
		this.#busy = true;
		this.#touched = true;
		const before = this.#d.active();
		const next = offer.intake;
		const source: RecipeSource = offer.origin === "url" ? { kind: "url", host: hostOf(before?.updateUrl ?? "") } : { kind: "file", fileName: next.fileName };
		try {
			this.#set({ phase: "applying", step: "recipe" });
			const undo = this.#d.accept(next, source);
			if (needsInstall(before, next.recipe)) {
				this.#set({ phase: "applying", step: "install" });
				let outcome: Awaited<ReturnType<RecipeServiceDeps["install"]>>;
				try {
					outcome = await this.#d.install();
				} catch (error) {
					undo();
					const detail = (error as Error).message.split(/\r?\n/)[0]?.slice(0, 300) ?? "";
					this.#d.log({ event: "recipe-apply-failed", detail });
					this.#set({ phase: "error", kind: /stop|busy/i.test(detail) ? "busy" : "other", detail });
					return;
				}
				if (!outcome.ok) {
					// The old recipe comes back, and the install runs once more for it so the machine matches the recipe again.
					undo();
					let restored = false;
					try {
						restored = (await this.#d.install()).ok;
					} catch {
						restored = false;
					}
					this.#d.log({ event: "recipe-apply-rolled-back", stage: outcome.stage, category: outcome.category, restored });
					this.#set({ phase: "failed", stage: outcome.stage, category: outcome.category, restored, at: (this.#d.now ?? (() => new Date()))().toISOString() });
					return;
				}
			}
			this.#d.store.update({ source, kept: null });
			const added: Forge[] = next.recipe.forges.filter((f) => !(before?.forges ?? []).some((o) => o.kind === f.kind && o.host === f.host)).map((f) => ({ kind: f.kind, host: f.host }));
			if (added.length > 0) this.#d.addLater(added.map((f) => ({ item: f.kind, host: f.host })));
			this.#offer = null;
			// The projects step is not waited for: a base held on a trust question waits for the PM's answer in the GUI, and the card shows each row meanwhile.
			void this.#d.projects.update(repoSpecs(before), repoSpecs(next.recipe)).catch((error: Error) => this.#d.log({ event: "recipe-projects-failed", detail: error.message.slice(0, 200) }));
			this.#set({ phase: "applied", version: next.recipe.version, at: (this.#d.now ?? (() => new Date()))().toISOString() });
		} finally {
			this.#busy = false;
			this.#emit();
		}
	}

	async act(action: RecipeAction): Promise<void> {
		switch (action.type) {
			case "recipe-check":
				return this.check();
			case "recipe-apply":
				return this.apply();
			case "recipe-keep":
				return this.keep();
			case "recipe-replace":
				return this.replace();
			case "project-retry": {
				const spec = repoSpecs(this.#d.active()).find((s) => s.folder === action.folder);
				if (spec !== undefined) await this.#d.projects.retry(spec);
				return;
			}
		}
	}

	/** The first check a little after the start, then once a day. The timers do not keep the app alive. */
	start(): void {
		const later = this.#d.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
		const every = this.#d.setInterval ?? ((fn, ms) => setInterval(fn, ms));
		const run = (): void => void this.check({ background: true });
		const first = (): void => {
			if (!this.#touched) run();
		};
		for (const timer of [later(first, FIRST_CHECK_AFTER_MS), every(run, CHECK_EVERY_MS)]) {
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
