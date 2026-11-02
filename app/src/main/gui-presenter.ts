import type { SupervisorState } from "./runtime/supervisor.ts";

// What the window shows of the GUI, and when (spec: Runtime supervisor, Start; Window close). The supervisor announces the GUI's address once per start or restart, and a window may not exist
// at that moment: on macOS the window can be closed while the app and the stack keep running, and a window opened later (the Dock icon, a second launch) must show the running GUI, not the
// welcome page (T8A-F004). So the address is kept here, in memory only: it carries the page token, so it is never logged or written.

/** The part of a window this module drives: the GUI view and the shell view above it. */
export interface GuiSurface {
	/** Loads `url` in the GUI view, calls `onLoaded` once the page has loaded, and hides the shell view. */
	show(url: string, onLoaded: () => void): void;
}

export interface GuiPresenterDeps {
	state(): SupervisorState;
	/** The page has loaded: the supervisor reads the start times, polls `server.json`, and prunes. */
	guiShown(): void;
}

export class GuiPresenter {
	readonly #deps: GuiPresenterDeps;
	#url: string | null = null;
	#surface: GuiSurface | null = null;

	constructor(deps: GuiPresenterDeps) {
		this.#deps = deps;
	}

	/** The supervisor's `gui-url`: remembered, and shown at once when a window is open. */
	onGuiUrl(url: string): void {
		this.#url = url;
		this.#surface?.show(url, this.#deps.guiShown);
	}

	/** A window opened. Returns true when it shows the running GUI at once: the address is known and the stack runs. */
	attach(surface: GuiSurface): boolean {
		this.#surface = surface;
		if (this.#url === null || this.#deps.state() !== "running") return false;
		surface.show(this.#url, this.#deps.guiShown);
		return true;
	}

	/** The window closed; the address stays for the next one. */
	detach(): void {
		this.#surface = null;
	}
}
