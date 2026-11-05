import type { ClaudeAction, ClaudeFlow, ClaudeState, ClaudeView, ForgeAction, ForgeFlow, ForgeView, LinearAction, LinearFlow, LinearState, LinearView } from "../../src/shared/accounts.ts";
import type { Forge } from "../../src/shared/wizard.ts";
import type { ProjectsView } from "../../src/shared/projects.ts";
import type { RepoSpec } from "../../src/main/projects/runner.ts";
import type { WizardAccounts, WizardClaude, WizardLinear, WizardProjects } from "../../src/main/wizard/controller.ts";

/** The controller's view of the code-host sign-in, scripted by a test: it records what the controller asked and lets the test set a host's flow. */
export class FakeAccounts implements WizardAccounts {
	readonly flows = new Map<string, ForgeFlow>();
	readonly begun: string[] = [];
	readonly cancelled: string[] = [];
	readonly actions: ForgeAction[] = [];
	readonly #changed = new Set<() => void>();
	readonly #signedIn = new Set<(kind: Forge["kind"], host: string) => void>();
	/** What `begin` leaves the flow at (default `ready`, as a clean store does). */
	afterBegin: ForgeFlow = { phase: "ready" };

	views(forges: readonly Forge[]): ForgeView[] {
		return forges.map((f) => ({ kind: f.kind, host: f.host, state: "not-signed-in" as const, entries: [], flow: this.flowOf(f.host) }));
	}
	async act(action: ForgeAction): Promise<void> {
		this.actions.push(action);
	}
	async begin(_kind: Forge["kind"], host: string): Promise<void> {
		this.begun.push(host);
		this.setFlow(host, this.afterBegin);
	}
	cancel(host: string): void {
		this.cancelled.push(host);
	}
	flowOf(host: string): ForgeFlow {
		return this.flows.get(host) ?? { phase: "idle" };
	}
	onChange(listener: () => void): () => void {
		this.#changed.add(listener);
		return () => this.#changed.delete(listener);
	}
	onSignedIn(listener: (kind: Forge["kind"], host: string) => void): () => void {
		this.#signedIn.add(listener);
		return () => this.#signedIn.delete(listener);
	}
	setFlow(host: string, flow: ForgeFlow): void {
		this.flows.set(host, flow);
		for (const l of this.#changed) l();
	}
	signedIn(kind: Forge["kind"], host: string): void {
		for (const l of this.#signedIn) l(kind, host);
	}
}

/** The controller's view of the Claude sign-in, scripted by a test. */
export class FakeClaude implements WizardClaude {
	flow: ClaudeFlow = { phase: "idle" };
	state: ClaudeState = "unknown";
	readonly actions: ClaudeAction[] = [];
	cancels = 0;
	refreshes = 0;
	/** What `refresh` leaves the state at (default not signed in). */
	afterRefresh: ClaudeState = "not-signed-in";
	readonly #changed = new Set<() => void>();
	readonly #signedIn = new Set<() => void>();
	view(): ClaudeView {
		return { state: this.state, storage: "keychain", flow: this.flow };
	}
	async act(action: ClaudeAction): Promise<void> {
		this.actions.push(action);
	}
	cancel(): void {
		this.cancels++;
	}
	async refresh(): Promise<void> {
		this.refreshes++;
		this.state = this.afterRefresh;
		this.set(this.flow);
	}
	onChange(listener: () => void): () => void {
		this.#changed.add(listener);
		return () => this.#changed.delete(listener);
	}
	onSignedIn(listener: () => void): () => void {
		this.#signedIn.add(listener);
		return () => this.#signedIn.delete(listener);
	}
	set(flow: ClaudeFlow, state: ClaudeState = this.state): void {
		this.flow = flow;
		this.state = state;
		for (const l of this.#changed) l();
	}
	signedIn(): void {
		this.state = "signed-in";
		for (const l of this.#signedIn) l();
	}
}

/** The controller's view of the Linear key, scripted by a test. */
export class FakeLinear implements WizardLinear {
	flow: LinearFlow = { phase: "idle" };
	state: LinearState = "not-saved";
	restart: LinearView["restart"] = { phase: "none" };
	encryption: boolean | null = true;
	readonly actions: LinearAction[] = [];
	resets = 0;
	probes = 0;
	readonly #changed = new Set<() => void>();
	readonly #saved = new Set<() => void>();
	view(): LinearView {
		return { state: this.state, flow: this.flow, restart: this.restart, encryption: this.encryption };
	}
	async act(action: LinearAction): Promise<void> {
		this.actions.push(action);
	}
	async probe(): Promise<void> {
		this.probes++;
	}
	reset(): void {
		this.resets++;
		this.set({ phase: "idle" });
	}
	onChange(listener: () => void): () => void {
		this.#changed.add(listener);
		return () => this.#changed.delete(listener);
	}
	onSaved(listener: () => void): () => void {
		this.#saved.add(listener);
		return () => this.#saved.delete(listener);
	}
	set(flow: LinearFlow, state: LinearState = this.state): void {
		this.flow = flow;
		this.state = state;
		for (const l of this.#changed) l();
	}
	saved(): void {
		this.state = "saved";
		for (const l of this.#saved) l();
	}
}

/** The controller's view of the projects step, scripted by a test: it records the passes and the retries and lets the test set what the step shows. */
export class FakeProjects implements WizardProjects {
	current: ProjectsView = { rows: [], running: false, held: false };
	readonly begun: Array<readonly RepoSpec[]> = [];
	readonly retried: RepoSpec[] = [];
	readonly #changed = new Set<() => void>();
	view(): ProjectsView {
		return this.current;
	}
	async begin(specs: readonly RepoSpec[]): Promise<void> {
		this.begun.push(specs);
	}
	async retry(spec: RepoSpec): Promise<void> {
		this.retried.push(spec);
	}
	onChange(listener: () => void): () => void {
		this.#changed.add(listener);
		return () => this.#changed.delete(listener);
	}
	set(view: ProjectsView): void {
		this.current = view;
		for (const l of this.#changed) l();
	}
}
