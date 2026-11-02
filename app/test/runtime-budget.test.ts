import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RENDERER_GONE_MAX, RENDERER_GONE_WINDOW_MS, SERVER_RESTART_MAX, SERVER_RESTART_WINDOW_MS, SlidingBudget } from "../src/main/runtime/budget.ts";

// The crash budgets of **Crash and sleep**: more than 3 restarts in 10 minutes stop the retrying, and a renderer lost twice in a minute fails.
describe("the sliding budget", () => {
	it("is spent by the fourth restart within 10 minutes, not the third", () => {
		const b = new SlidingBudget(SERVER_RESTART_MAX, SERVER_RESTART_WINDOW_MS);
		assert.deepEqual([0, 1000, 2000].map((t) => b.hit(t)), [false, false, false]);
		assert.equal(b.hit(3000), true);
	});

	it("forgets restarts older than the window: three, then 11 minutes of quiet, then three more are fine", () => {
		const b = new SlidingBudget(SERVER_RESTART_MAX, SERVER_RESTART_WINDOW_MS);
		for (const t of [0, 1000, 2000]) b.hit(t);
		const later = SERVER_RESTART_WINDOW_MS + 5000;
		assert.equal(b.count(later), 0);
		assert.deepEqual([later, later + 1, later + 2].map((t) => b.hit(t)), [false, false, false]);
		assert.equal(b.hit(later + 3), true);
	});

	it("counts events at the edge of the window as inside it until the window has passed", () => {
		const b = new SlidingBudget(1, 1000);
		assert.equal(b.hit(0), false);
		assert.equal(b.hit(999), true);
		const c = new SlidingBudget(1, 1000);
		assert.equal(c.hit(0), false);
		assert.equal(c.hit(1000), false, "exactly one window later the first no longer counts");
	});

	it("fails the renderer's second loss within a minute, and reloads after a quiet minute", () => {
		const b = new SlidingBudget(RENDERER_GONE_MAX, RENDERER_GONE_WINDOW_MS);
		assert.equal(b.hit(0), false, "the first loss reloads");
		assert.equal(b.hit(30_000), true, "the second within a minute shows the failure screen");
		const c = new SlidingBudget(RENDERER_GONE_MAX, RENDERER_GONE_WINDOW_MS);
		c.hit(0);
		assert.equal(c.hit(61_000), false);
	});

	it("starts again from nothing after reset", () => {
		const b = new SlidingBudget(1, 1000);
		b.hit(0);
		b.reset();
		assert.equal(b.count(1), 0);
		assert.equal(b.hit(1), false);
	});
});
