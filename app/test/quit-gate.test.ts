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

describe("the removal's stop through the gate (T14-F004)", () => {
	it("answers busy and starts nothing while an update's stop is under way, and a refusal then does not resume the stack", async () => {
		const r = rig();
		const update = r.gate.stopForUpdate();
		let ran = false;
		const outcome = await r.gate.stopForRemoval(async () => {
			ran = true;
			return { ok: true, leftovers: [] };
		});
		assert.deepEqual(outcome, { ok: false, busy: true, leftovers: [] });
		assert.equal(ran, false);
		r.endStop();
		await update;
		assert.equal(r.gate.stopped, true, "the update's stop is untouched");
		assert.deepEqual(r.calls, ["stopAll 1", "log update-stop"]);
	});

	it("answers busy while a quit's stop is under way", async () => {
		const r = rig();
		assert.equal(r.gate.beforeQuit(), false);
		assert.deepEqual(await r.gate.stopForRemoval(async () => ({ ok: true, leftovers: [] })), { ok: false, busy: true, leftovers: [] });
	});

	it("a stop that ended with programs left is undone by resumeAfterRefusedRemoval, with its own event", async () => {
		const r = rig();
		const outcome = await r.gate.stopForRemoval(async () => ({ ok: false, leftovers: [{ pid: 1, file: "node" }] }));
		assert.equal(outcome.ok, false);
		assert.equal(r.gate.stopped, false);
		const events: string[] = [];
		const gate = new QuitGate({ stopAll: async () => true, exit: () => undefined, resume: async (event) => (events.push(event), true), log: () => undefined });
		await gate.stopForRemoval(async () => ({ ok: false, leftovers: [] }));
		assert.equal(await gate.resumeAfterRefusedRemoval(), true);
		assert.deepEqual(events, ["remove-resume"]);
		// the stack can be stopped again after the undo
		assert.deepEqual(await gate.stopForRemoval(async () => ({ ok: true, leftovers: [] })), { ok: true, leftovers: [] });
		assert.equal(gate.stopped, true);
	});

	it("a quit asked during the removal's stop is not lost: a refusal leaves through the whole stop sequence instead of resuming", async () => {
		const r = rig();
		const stop = r.gate.stopForRemoval(async () => ({ ok: false, leftovers: [] }));
		assert.equal(r.gate.beforeQuit(), false);
		await stop;
		const resumed = r.gate.resumeAfterRefusedRemoval();
		r.endStop();
		assert.equal(await resumed, false);
		await tick();
		assert.deepEqual(r.calls, ["log remove-resume-quit", "stopAll 1", "exit 0"]);
	});

	it("T14R-F001: a quit asked while the removal works is held even after its stop has ended, and is answered when the removal is done, not dropped", async () => {
		const r = rig();
		const outcome = await r.gate.stopForRemoval(async () => ({ ok: true, leftovers: [] }));
		assert.equal(outcome.ok, true);
		assert.equal(r.gate.beforeQuit(), false, "the stop is over, and the quit still waits for the rest of the removal");
		assert.equal(r.gate.stopped, true);
		assert.equal(r.gate.removalDone(), true, "the removal ends: a quit was asked, so the result is to be shown");
		assert.equal(r.gate.beforeQuit(), true, "closing the result then quits through the usual rule");
		assert.equal(r.gate.removalDone(), false, "answered once");
		assert.deepEqual(r.calls, [], "the quit starts no second stop and leaves nothing half done");
	});

	it("T14R-F001: a quit asked while the removal's own stop runs is remembered, and a removal that ends is not left windowless", async () => {
		const r = rig();
		let finish: (v: { ok: boolean; leftovers: [] }) => void = () => undefined;
		const stop = r.gate.stopForRemoval(() => new Promise<{ ok: boolean; leftovers: [] }>((resolve) => (finish = resolve)));
		assert.equal(r.gate.beforeQuit(), false);
		finish({ ok: true, leftovers: [] });
		await stop;
		assert.equal(r.gate.removalDone(), true);
	});

	it("T14R-F001: with no quit asked the removal's end asks for no window, and a quit before or after the removal is unchanged", async () => {
		const r = rig();
		assert.equal(r.gate.removalDone(), false, "no removal, nothing to answer");
		await r.gate.stopForRemoval(async () => ({ ok: true, leftovers: [] }));
		assert.equal(r.gate.removalDone(), false);
		assert.equal(r.gate.beforeQuit(), true, "after the removal the app leaves as any app that is stopped");
	});

	it("T14R-F001: a refused removal ends the hold: a quit asked during it still leaves, and one asked after the app went on stops the stack and leaves as always", async () => {
		const r = rig();
		await r.gate.stopForRemoval(async () => ({ ok: false, leftovers: [] }));
		assert.equal(r.gate.beforeQuit(), false);
		const resumed = r.gate.resumeAfterRefusedRemoval();
		r.endStop();
		assert.equal(await resumed, false);
		assert.equal(r.gate.removalDone(), false, "the hold is gone: a later removal starts clean");
		const later = rig();
		await later.gate.stopForRemoval(async () => ({ ok: false, leftovers: [] }));
		assert.equal(await later.gate.resumeAfterRefusedRemoval(), true, "no quit was asked: the app goes on");
		assert.equal(later.gate.beforeQuit(), false, "a quit now is held by the stop sequence, not by the removal");
		later.endStop();
		await tick();
		assert.deepEqual(later.calls, ["resume", "stopAll 1", "exit 0"], "the stop ran: the hold of the refused removal is gone");
	});
});
