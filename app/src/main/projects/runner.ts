import type { RuntimeEvent } from "../runtime/log.ts";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { ProjectFailure, ProjectRow, ProjectsView } from "../../shared/projects.ts";
import type { AppPlatform } from "../paths.ts";
import { cloneCause, ProjectGit } from "./git.ts";
import { linkPaths, summarizeLinks } from "./links.ts";
import type { OpenOutcome } from "./open-base.ts";
import { plainOrigin, sameOrigin } from "./origin.ts";
import type { ProjectRecordStore, StoredRow } from "./record.ts";

// The projects step and the repository half of a recipe update (spec: First run, step 10; Projects: the default branch; Projects: symlinks in a repository (Windows); team-profile section 5).
// For each repository of the recipe, one at a time (the GUI opens one base at a time): clone into `<work folder>/<folder>`, or fetch a folder that is there already with the same `origin`; any
// other folder stops that repository with a plain message and is left untouched; then `git remote set-head origin <defaultBranch>` when the recipe gives one; on Windows the list of links; then the
// open as a base. A row that fails does not stop the others, and each can be retried alone. A recipe update runs only what changed (`update`).

/** The part of a recipe's repository this step needs (`recipe/validate.d.mts` `Recipe["repos"]`). */
export interface RepoSpec {
	url: string;
	folder: string;
	label: string;
	defaultBranch?: string | undefined;
}

export type Redact = (text: string) => string;

export interface ProjectsDeps {
	platform: AppPlatform;
	/** The work folder, read when a row starts. */
	workFolder(): string;
	git: ProjectGit;
	/** Opens `dir` as a base. `onTrust` says when a project trust question holds the opening. */
	openBase(input: { dir: string; label: string; deploy: string }, hooks: { onTrust(asking: boolean): void; signal: AbortSignal }): Promise<OpenOutcome>;
	record: ProjectRecordStore;
	redact: Redact;
	log: RuntimeEvent;
	/** Test hooks of the file system reads. */
	exists?: (path: string) => boolean;
	isDirectory?: (path: string) => boolean;
	listDir?: (path: string) => string[];
	makeDir?: (path: string) => void;
	newId?: () => string;
}

const hostOf = (url: string): string => {
	try {
		return new URL(url).host;
	} catch {
		return "";
	}
};

const fresh = (spec: RepoSpec): ProjectRow => ({
	folder: spec.folder,
	label: spec.label,
	host: hostOf(spec.url),
	defaultBranch: spec.defaultBranch ?? null,
	phase: "waiting",
	step: null,
	reused: false,
	opened: false,
	links: null,
	failure: null,
	detail: "",
});

class RowFailed extends Error {
	readonly failure: ProjectFailure;
	readonly line: string;
	constructor(failure: ProjectFailure, line = "") {
		super(failure.kind);
		this.failure = failure;
		this.line = line;
	}
}

export class ProjectsRunner {
	readonly #d: ProjectsDeps;
	readonly #rows = new Map<string, StoredRow>();
	readonly #listeners = new Set<() => void>();
	#abort = new AbortController();
	/** The work folder the stored rows were made for. */
	#savedWorkFolder: string | null;
	#chain: Promise<void> = Promise.resolve();

	constructor(deps: ProjectsDeps) {
		this.#d = deps;
		const saved = deps.record.read();
		if (saved !== null) for (const row of saved.rows) this.#rows.set(row.folder, row);
		this.#savedWorkFolder = saved?.workFolder ?? null;
	}

	onChange(listener: () => void): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	view(): ProjectsView {
		const rows = [...this.#rows.values()].map(({ url: _url, ...row }) => ({ ...row, links: row.links === null ? null : { ...row.links, paths: [...row.links.paths] } }));
		return { rows, running: rows.some((r) => r.phase === "working"), held: rows.some((r) => r.phase === "trust") };
	}

	/** Rows are shown in the recipe's order, and only for repositories the active recipe lists. */
	#keepOnly(specs: readonly RepoSpec[]): void {
		const order = new Map(specs.map((s, i) => [s.folder, i]));
		for (const folder of [...this.#rows.keys()]) if (!order.has(folder)) this.#rows.delete(folder);
		const sorted = [...this.#rows.values()].sort((a, b) => (order.get(a.folder) ?? 0) - (order.get(b.folder) ?? 0));
		this.#rows.clear();
		for (const row of sorted) this.#rows.set(row.folder, row);
	}

	#emit(): void {
		for (const l of this.#listeners) l();
	}

	#save(): void {
		try {
			this.#d.record.write({ schema: 1, workFolder: this.#d.workFolder(), rows: [...this.#rows.values()] });
		} catch (error) {
			this.#d.log({ event: "projects-record-failed", detail: (error as Error).message.slice(0, 200) });
		}
	}

	#enqueue(work: () => Promise<void>): Promise<void> {
		const next = this.#chain.then(work, work);
		this.#chain = next.catch(() => undefined);
		return next;
	}

	/**
	 * The first pass (the wizard's projects step, and a retry of the whole step after a quit): every repository of `specs`, in order. A row that is done in the record for the same address,
	 * default branch and work folder is left as it is, so a relaunch in the middle of the step goes on from the repositories that are left.
	 */
	begin(specs: readonly RepoSpec[]): Promise<void> {
		const sameWorkFolder = this.#savedWorkFolder === null || this.#savedWorkFolder === this.#d.workFolder();
		this.#keepOnly(specs);
		for (const spec of specs) {
			const kept = this.#rows.get(spec.folder);
			const done = kept !== undefined && sameWorkFolder && kept.phase === "done" && kept.url === spec.url && kept.defaultBranch === (spec.defaultBranch ?? null);
			if (!done) this.#rows.set(spec.folder, { ...fresh(spec), url: spec.url });
		}
		this.#savedWorkFolder = this.#d.workFolder();
		this.#save();
		this.#emit();
		return this.#enqueue(async () => {
			for (const spec of specs) {
				const row = this.#rows.get(spec.folder);
				if (row === undefined || row.phase !== "waiting") continue;
				await this.#run(spec, "full");
			}
		});
	}

	/**
	 * A recipe update: a repository the recipe adds, or whose address changed, runs in full; one whose `defaultBranch` changed runs `set-head` again and nothing else; one that changed in neither
	 * is not touched; one the recipe no longer lists leaves the list and stays on disk and in the GUI.
	 */
	update(before: readonly RepoSpec[], after: readonly RepoSpec[]): Promise<void> {
		const old = new Map(before.map((s) => [s.folder, s]));
		const plan: Array<{ spec: RepoSpec; mode: "full" | "head" }> = [];
		for (const spec of after) {
			const was = old.get(spec.folder);
			if (was === undefined || was.url !== spec.url) plan.push({ spec, mode: "full" });
			else if ((was.defaultBranch ?? null) !== (spec.defaultBranch ?? null)) plan.push({ spec, mode: "head" });
			else if (!this.#rows.has(spec.folder)) this.#rows.set(spec.folder, { ...fresh(spec), url: spec.url });
		}
		this.#keepOnly(after);
		for (const { spec, mode } of plan) {
			const kept = this.#rows.get(spec.folder);
			// A head-only run shows the row working again but keeps what it knew (open, links); a full run starts the row over.
			this.#rows.set(spec.folder, mode === "head" && kept !== undefined ? { ...kept, label: spec.label, defaultBranch: spec.defaultBranch ?? null, url: spec.url, phase: "waiting", failure: null, detail: "" } : { ...fresh(spec), url: spec.url });
		}
		this.#save();
		this.#emit();
		return this.#enqueue(async () => {
			for (const { spec, mode } of plan) await this.#run(spec, mode);
		});
	}

	/** Retries one failed row alone, in full. */
	retry(spec: RepoSpec): Promise<void> {
		const row = this.#rows.get(spec.folder);
		if (row === undefined || row.phase !== "failed") return Promise.resolve();
		this.#rows.set(spec.folder, { ...fresh(spec), url: spec.url, opened: row.opened });
		this.#save();
		this.#emit();
		return this.#enqueue(() => this.#run(spec, "full"));
	}

	/** Ends what is in flight: the open is aborted and no further row starts. */
	dispose(): void {
		this.#abort.abort();
	}

	/** The signal that ends the Git calls and the open: the Git wrapper reads it per call, so `resume` gives later calls a live one. */
	get signal(): AbortSignal {
		return this.#abort.signal;
	}

	/** After a quit that was undone (the installer of an update could not start): rows may run again. */
	resume(): void {
		if (this.#abort.signal.aborted) this.#abort = new AbortController();
	}

	/** Waits until every queued row has ended. */
	idle(): Promise<void> {
		return this.#chain;
	}

	// ---- one row -----------------------------------------------------------------------------------------------------------

	#patch(folder: string, change: Partial<StoredRow>): void {
		const row = this.#rows.get(folder);
		if (row === undefined) return;
		this.#rows.set(folder, { ...row, ...change });
		this.#emit();
	}

	#step(folder: string, step: ProjectRow["step"]): void {
		this.#patch(folder, { phase: "working", step });
	}

	async #run(spec: RepoSpec, mode: "full" | "head"): Promise<void> {
		if (this.#abort.signal.aborted) return;
		this.#patch(spec.folder, { phase: "working", step: mode === "head" ? "head" : null, failure: null, detail: "" });
		try {
			await (mode === "head" ? this.#headOnly(spec) : this.#full(spec));
			this.#patch(spec.folder, { phase: "done", step: null, failure: null, detail: "" });
		} catch (error) {
			if (error instanceof RowFailed) {
				this.#d.log({ event: "project-failed", folder: spec.folder, failure: error.failure.kind, ...("cause" in error.failure ? { cause: error.failure.cause } : {}) });
				this.#patch(spec.folder, { phase: "failed", step: null, failure: error.failure, detail: this.#d.redact(error.line).slice(0, 300) });
			} else {
				const line = (error as Error).message.split(/\r?\n/)[0] ?? "";
				this.#d.log({ event: "project-failed", folder: spec.folder, failure: "unexpected", detail: this.#d.redact(line).slice(0, 200) });
				this.#patch(spec.folder, { phase: "failed", step: null, failure: { kind: "git", step: "origin" }, detail: this.#d.redact(line).slice(0, 300) });
			}
		} finally {
			this.#save();
			this.#emit();
		}
	}

	#targetOf(spec: RepoSpec): string {
		const target = join(this.#d.workFolder(), spec.folder);
		// The validator allows a single folder name; a hand-edited file might not, and the check costs nothing.
		if (spec.folder === "" || basename(spec.folder) !== spec.folder || spec.folder.includes("..") || dirname(target) !== join(this.#d.workFolder())) throw new RowFailed({ kind: "git", step: "origin" }, "the folder is not a single name");
		return target;
	}

	async #headOnly(spec: RepoSpec): Promise<void> {
		const target = this.#targetOf(spec);
		const exists = this.#d.exists ?? existsSync;
		if (!exists(join(target, ".git"))) return this.#full(spec);
		await this.#setHead(spec, target);
	}

	async #setHead(spec: RepoSpec, target: string): Promise<void> {
		const branch = spec.defaultBranch;
		if (branch === undefined) return;
		this.#step(spec.folder, "head");
		const result = await this.#d.git.setHead(target, branch);
		if (result.code === 0) return;
		const line = result.stderr.trim().split(/\r?\n/)[0] ?? "";
		// `git remote set-head` checks that `refs/remotes/origin/<branch>` exists after the fetch: its refusal is a branch `origin` does not have.
		if (/Not a valid ref/i.test(result.stderr)) throw new RowFailed({ kind: "branch-missing", branch }, line);
		throw new RowFailed({ kind: "git", step: "head" }, line);
	}

	async #full(spec: RepoSpec): Promise<void> {
		if (spec.folder.normalize("NFC").toLowerCase() === "straw boss") throw new RowFailed({ kind: "reserved-folder" });
		const d = this.#d;
		const exists = d.exists ?? existsSync;
		const isDirectory = d.isDirectory ?? ((p: string) => statSync(p).isDirectory());
		const listDir = d.listDir ?? ((p: string) => readdirSync(p));
		const work = d.workFolder();
		try {
			(d.makeDir ?? ((p: string) => void mkdirSync(p, { recursive: true })))(work);
		} catch (error) {
			throw new RowFailed({ kind: "git", step: "origin" }, (error as Error).message);
		}
		const target = this.#targetOf(spec);
		let reuse = false;
		if (exists(target)) {
			if (!isDirectory(target)) throw new RowFailed({ kind: "not-empty" });
			if (exists(join(target, ".git"))) {
				let origin: string | null;
				try {
					origin = await d.git.originOf(target);
				} catch (error) {
					throw new RowFailed({ kind: "git", step: "origin" }, (error as Error).message.split(/\r?\n/)[0] ?? "");
				}
				if (origin === null || !sameOrigin(origin, spec.url)) throw new RowFailed({ kind: "other-origin" }, origin === null ? "the folder's repository has no origin" : `origin is ${plainOrigin(origin)}`);
				reuse = true;
			} else if (listDir(target).length > 0) {
				throw new RowFailed({ kind: "not-empty" });
			}
		}
		if (reuse) {
			this.#step(spec.folder, "fetching");
			const fetched = await d.git.fetch(target);
			if (fetched.code !== 0) throw new RowFailed({ kind: "clone", cause: cloneCause(fetched) }, fetched.stderr.trim().split(/\r?\n/)[0] ?? "");
			this.#patch(spec.folder, { reused: true });
		} else {
			this.#step(spec.folder, "cloning");
			const cloned = await d.git.clone(spec.url, target, work);
			if (cloned.code !== 0) throw new RowFailed({ kind: "clone", cause: cloneCause(cloned) }, cloned.stderr.trim().split(/\r?\n/)[0] ?? "");
			this.#patch(spec.folder, { reused: false });
		}
		await this.#setHead(spec, target);
		await this.#links(spec, target);
		await this.#open(spec, target);
	}

	/** Windows only: lists the links the checkout could not make. Where the platform makes links, no Git process runs for it. */
	async #links(spec: RepoSpec, target: string): Promise<void> {
		if (this.#d.platform !== "win32") {
			this.#patch(spec.folder, { links: null });
			return;
		}
		this.#step(spec.folder, "links");
		const listing = await this.#d.git.linkEntries(target);
		if (listing.code !== 0) throw new RowFailed({ kind: "git", step: "links" }, listing.stderr.trim().split(/\r?\n/)[0] ?? "");
		this.#patch(spec.folder, { links: summarizeLinks(linkPaths(listing.stdout)) });
	}

	async #open(spec: RepoSpec, target: string): Promise<void> {
		const row = this.#rows.get(spec.folder);
		// A base opened by an earlier run is not opened a second time (the GUI would hold two workspaces for one folder).
		if (row?.opened === true) return;
		this.#step(spec.folder, "opening");
		const deploy = (this.#d.newId ?? (() => `sbd-${Math.random().toString(16).slice(2, 12)}${Date.now().toString(16)}`))();
		const outcome = await this.#d.openBase(
			{ dir: target, label: spec.label, deploy },
			{
				signal: this.#abort.signal,
				onTrust: (asking) => {
					// The question is answered in the GUI; the row says so, and the step may go on meanwhile.
					if (asking) this.#patch(spec.folder, { phase: "trust", step: null });
					else this.#patch(spec.folder, { phase: "working", step: "opening" });
				},
			},
		);
		if (outcome.ok) {
			this.#patch(spec.folder, { opened: true });
			return;
		}
		throw new RowFailed({ kind: "open", cause: outcome.cause }, outcome.reason);
	}
}

