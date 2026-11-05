import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { QuitGate } from "../src/main/quit-gate.ts";

// The quit gate behind index.ts (R13B-F004): a quit asked while an update's stop is under way is remembered, and the app leaves when the installer then fails to start.

function rig(options: { resumed?: boolean } = {}) {
	const calls: string[] = [];
	let finishStop: (ok: boolean) => void = () => undefined;
	let stops = 0;
	const gate = new QuitGate({
		stopAll: () => {
			stops++;
			calls.push(`stopAll ${stops}`);
			return new Promise<boolean>((resolve) => (finishStop = resolve));
		},
		exit: (code) => void calls.push(`exit ${code}`),
		resume: async () => (calls.push("resume"), options.resumed ?? true),
		log: (fields) => void calls.push(`log ${fields.event}`),
	});
	return { gate, calls, endStop: (ok = true) => finishStop(ok) };
}
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe("the quit gate", () => {
	it("holds a quit until the stop sequence ends, then leaves; the quit the stop itself makes is let through", async () => {
		const r = rig();
		assert.equal(r.gate.beforeQuit(), false, "held");
		assert.equal(r.gate.beforeQuit(), false, "still held, and the stop does not run twice");
		r.endStop();
		await tick();
		assert.deepEqual(r.calls, ["stopAll 1", "exit 0"]);
		assert.equal(r.gate.beforeQuit(), true, "the leaving quit passes");
	});

	it("an update's stop lets electron-updater's quit through, and a failed installer resumes the app as it was", async () => {
		const r = rig();
		const stop = r.gate.stopForUpdate();
		r.endStop();
		await stop;
		assert.equal(r.gate.beforeQuit(), true);
		assert.equal(await r.gate.resumeAfterFailedUpdate(), true);
		assert.deepEqual(r.calls, ["stopAll 1", "log update-stop", "resume"]);
		assert.equal(r.gate.stopped, false);
	});

	it("a quit asked during the update's stop is not lost: when the installer fails to start, the app leaves through the whole stop sequence instead of resuming", async () => {
		const r = rig();
		const stop = r.gate.stopForUpdate();
		assert.equal(r.gate.beforeQuit(), false, "held, as any quit during a stop is");
		r.endStop();
		await stop;
		const resumed = r.gate.resumeAfterFailedUpdate();
		r.endStop();
		assert.equal(await resumed, false, "the agents are not started again");
		await tick();
		assert.deepEqual(r.calls, ["stopAll 1", "log update-stop", "log update-resume-quit", "stopAll 2", "exit 0"]);
		assert.equal(r.calls.includes("resume"), false);
	});

	it("reports whether the agents started when it does resume", async () => {
		const r = rig({ resumed: false });
		const stop = r.gate.stopForUpdate();
		r.endStop();
		await stop;
		assert.equal(await r.gate.resumeAfterFailedUpdate(), false);
	});
});
