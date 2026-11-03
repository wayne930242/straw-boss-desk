import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execRunner } from "../src/main/platform/exec.ts";

// The production runner ends its children when the engine's run is cancelled, so a quit leaves no npm or extractor running (T9-F002).
describe("execRunner and an abort signal", () => {
	it("kills the child it started when the signal aborts, and does not call that a timeout", async () => {
		const controller = new AbortController();
		const run = execRunner(process.env, controller.signal);
		const started = Date.now();
		const pending = run(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { timeoutMs: 120_000 });
		setTimeout(() => controller.abort(), 300);
		const result = await pending;
		assert.ok(Date.now() - started < 20_000, "the 60 s child did not run to its end");
		assert.equal(result.code, null);
		assert.notEqual(result.timedOut, true);
	});

	it("starts nothing once the signal has aborted (R9-F004 a)", async () => {
		const controller = new AbortController();
		controller.abort();
		// Node's own `spawn` creates the child even for a signal that has aborted and ends it on the next tick. A program that does not exist shows whether a spawn was tried:
		// it would answer `spawn ... ENOENT` or an AbortError, never the runner's own word.
		const result = await execRunner(process.env, controller.signal)(join(tmpdir(), "sbd-no-such-program-for-the-runner-test"), ["--never"]);
		assert.equal(result.code, null);
		assert.equal(result.stderr, "cancelled");
		assert.equal(result.stdout, "");
		const real = await execRunner(process.env, controller.signal)(process.execPath, ["-e", "setTimeout(() => {}, 60000)"]);
		assert.equal(real.stderr, "cancelled");
	});

	it("is unchanged without a signal", async () => {
		const result = await execRunner()(process.execPath, ["-e", "console.log('hi')"]);
		assert.equal(result.code, 0);
		assert.equal(result.stdout.trim(), "hi");
	});
});
