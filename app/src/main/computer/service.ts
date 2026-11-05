import type { ComputerAction, ComputerView, RemoveState } from "../../shared/computer.ts";
import type { RuntimeEvent } from "../runtime/log.ts";
import type { KeepAwake } from "./keep-awake.ts";

// Settings' Computer section (spec: Settings): keep awake and **Remove all data**. The removal is `removal/service.ts`; this joins it with the setting and the guide link.

export interface ComputerDeps {
	platform: "win32" | "darwin";
	keepAwake: Pick<KeepAwake, "on" | "change">;
	removal: {
		state: RemoveState;
		plan(): Promise<void>;
		cancel(): void;
		confirm(): Promise<void>;
		quit(): void;
	};
	/** Opens the guide's page on removing a sign-in by hand in the default browser. */
	openGuide(): void;
	log: RuntimeEvent;
}

export class ComputerService {
	readonly #d: ComputerDeps;

	constructor(deps: ComputerDeps) {
		this.#d = deps;
	}

	view(): ComputerView {
		return { platform: this.#d.platform, keepAwake: this.#d.keepAwake.on, remove: this.#d.removal.state };
	}

	async act(action: ComputerAction): Promise<void> {
		switch (action.type) {
			case "computer-keep-awake":
				// Nothing else is changed while the data is being removed.
				if (this.#d.removal.state.phase === "working" || this.#d.removal.state.phase === "done") return;
				try {
					this.#d.keepAwake.change(action.on);
					this.#d.log({ event: "keep-awake", on: action.on });
				} catch (error) {
					this.#d.log({ event: "keep-awake-failed", detail: (error as Error).message.slice(0, 200) });
				}
				return;
			case "computer-remove-plan":
				return this.#d.removal.plan();
			case "computer-remove-cancel":
				return this.#d.removal.cancel();
			case "computer-remove-confirm":
				return this.#d.removal.confirm();
			case "computer-quit":
				return this.#d.removal.quit();
			case "computer-open-guide":
				return this.#d.openGuide();
		}
	}
}
