import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GuiPresenter, type GuiSurface } from "../src/main/gui-presenter.ts";
import type { SupervisorState } from "../src/main/runtime/supervisor.ts";

// The window shows the running GUI whenever it opens, not only when the supervisor announces the address (T8A-F004: on macOS the window can be closed while the stack runs).

const URL_A = "http://127.0.0.1:41234/0123456789abcdef0123456789abcdef/";
const URL_B = "http://127.0.0.1:41234/fedcba9876543210fedcba9876543210/";

function setup(initial: SupervisorState = "idle") {
	let state: SupervisorState = initial;
	let shown = 0;
	const presenter = new GuiPresenter({ state: () => state, guiShown: () => void shown++ });
	const surface = (): GuiSurface & { loads: string[]; loaded: Array<() => void> } => {
		const s = {
			loads: [] as string[],
			loaded: [] as Array<() => void>,
			show(url: string, onLoaded: () => void) {
				s.loads.push(url);
				s.loaded.push(onLoaded);
			},
		};
		return s;
	};
	return { presenter, surface, setState: (next: SupervisorState) => (state = next), shownCount: () => shown };
}

describe("the window and the GUI's address", () => {
	it("shows an address the supervisor announces while a window is open, and tells the supervisor once the page has loaded", () => {
		const w = setup("starting");
		const window = w.surface();
		assert.equal(w.presenter.attach(window), false, "nothing to show before the stack runs");
		w.setState("running");
		w.presenter.onGuiUrl(URL_A);
		assert.deepEqual(window.loads, [URL_A]);
		assert.equal(w.shownCount(), 0);
		window.loaded[0]?.();
		assert.equal(w.shownCount(), 1);
	});

	it("a window opened after the first one was closed shows the running GUI at once (macOS: Dock icon or a second launch)", () => {
		const w = setup("starting");
		const first = w.surface();
		w.presenter.attach(first);
		w.setState("running");
		w.presenter.onGuiUrl(URL_A);
		w.presenter.detach();
		const second = w.surface();
		assert.equal(w.presenter.attach(second), true);
		assert.deepEqual(second.loads, [URL_A]);
		second.loaded[0]?.();
		assert.equal(w.shownCount(), 1);
	});

	it("keeps the address announced while no window was open, and shows the newest one", () => {
		const w = setup("running");
		w.presenter.onGuiUrl(URL_A);
		w.presenter.onGuiUrl(URL_B);
		const window = w.surface();
		assert.equal(w.presenter.attach(window), true);
		assert.deepEqual(window.loads, [URL_B]);
	});

	it("shows nothing of a stack that is not running: stopped, stopping, failed, or starting again", () => {
		const w = setup("running");
		w.presenter.onGuiUrl(URL_A);
		for (const state of ["stopping", "idle", "failed", "starting"] as const) {
			w.setState(state);
			const window = w.surface();
			assert.equal(w.presenter.attach(window), false, state);
			assert.deepEqual(window.loads, [], state);
			w.presenter.detach();
		}
	});

	it("a closed window is not driven any more", () => {
		const w = setup("running");
		const window = w.surface();
		w.presenter.attach(window);
		w.presenter.detach();
		w.presenter.onGuiUrl(URL_A);
		assert.deepEqual(window.loads, []);
	});
});
