import type { ForgeAction, ForgeFlow, ForgeView } from "../../src/shared/accounts.ts";
import type { Forge } from "../../src/shared/wizard.ts";
import type { WizardAccounts } from "../../src/main/wizard/controller.ts";

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
