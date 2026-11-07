import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RemoveState } from "../src/shared/computer.ts";
import type { CleanupCommand } from "../src/main/removal/cleanup.ts";
import { QuitGate } from "../src/main/quit-gate.ts";
import { afterRemovalChange, ExitCleanup, holdQuit, quitsWhenWindowsClose, removalStop } from "../src/main/removal/wiring.ts";

// The connections between **Remove all data** and the quit gate (T14R2-F002). They run against a real QuitGate, so a removal stop that goes around the gate, or an end that forgets a held quit, fails here
// and not only in a code read.

function rig() {
	const calls: string[] = [];
	const gate = new QuitGate({
		stopAll: async () => (calls.push("stopAll"), true),
		exit: (code) => void calls.push(`exit ${code}`),
		resume: async (event) => (calls.push(`resume ${event}`), true),
		log: (fields) => void calls.push(`log ${fields.event}`),
	});
	const keepAwake = { release: () => void calls.push("keepAwake.release"), apply: () => void calls.push("keepAwake.apply") };
	const wiring = (stopSequence: () => Promise<{ ok: boolean; leftovers: Array<{ pid: number; file: string }> }> = async () => (calls.push("stopSequence"), { ok: true, leftovers: [] })) => removalStop({ gate, keepAwake, stopSequence });
	return { gate, calls, wiring };
}
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe("removalStop: the removal's stop goes through the quit gate", () => {
	it("holds a quit asked after the stop until the removal says it is done, which is what puts the result in a window (T14R-F001)", async () => {
		const r = rig();
		const outcome = await r.wiring().stop();
		assert.deepEqual(outcome, { ok: true, leftovers: [] });
		assert.equal(r.gate.beforeQuit(), false, "held: the stop is over but the removal is not");
		assert.equal(r.gate.removalDone(), true, "a quit was asked while the removal held the gate");
		assert.equal(r.gate.beforeQuit(), true, "closing the result then quits");
		assert.deepEqual(r.calls, ["keepAwake.release", "stopSequence"], "the gate started no stop of its own for the held quit");
	});

	it("lets keep awake go before the stop starts", async () => {
		const r = rig();
		await r.wiring().stop();
		assert.deepEqual(r.calls, ["keepAwake.release", "stopSequence"]);
	});

	it("answers busy when another stop is under way, starts nothing, and touches no keep awake", async () => {
		const r = rig();
		let finish: (ok: boolean) => void = () => undefined;
		const busyGate = new QuitGate({ stopAll: () => new Promise<boolean>((resolve) => (finish = resolve)), exit: () => undefined, resume: async () => true, log: () => undefined });
		assert.equal(busyGate.beforeQuit(), false);
		const w = removalStop({ gate: busyGate, keepAwake: { release: () => void r.calls.push("keepAwake.release"), apply: () => void r.calls.push("keepAwake.apply") }, stopSequence: async () => (r.calls.push("stopSequence"), { ok: true, leftovers: [] }) });
		assert.deepEqual(await w.stop(), { ok: false, busy: true, leftovers: [] });
		assert.deepEqual(r.calls, []);
		finish(true);
		await tick();
	});

	it("a refused removal resumes through the gate, which ends the hold, and then applies keep awake again", async () => {
		const r = rig();
		const w = r.wiring(async () => (r.calls.push("stopSequence"), { ok: false, leftovers: [{ pid: 4, file: "herdr" }] }));
		assert.equal((await w.stop()).ok, false);
		await w.resume();
		assert.deepEqual(r.calls, ["keepAwake.release", "stopSequence", "resume remove-resume", "keepAwake.apply"]);
		assert.equal(r.gate.removalDone(), false, "the hold is gone");
	});

	it("a quit asked during a refused removal's stop leaves through the whole stop sequence instead of resuming", async () => {
		const r = rig();
		const w = r.wiring(async () => ({ ok: false, leftovers: [] }));
		await w.stop();
		assert.equal(r.gate.beforeQuit(), false);
		await w.resume();
		await tick();
		assert.deepEqual(r.calls.filter((c) => c !== "keepAwake.apply"), ["keepAwake.release", "log remove-resume-quit", "stopAll", "exit 0"], "no resume: the app leaves");
	});
});

describe("afterRemovalChange: a quit held during the removal is answered when it is done", () => {
	const wire = (gate: QuitGate, phase: RemoveState["phase"], calls: string[]) =>
		afterRemovalChange({ phase, gate, openWindow: () => void calls.push("openWindow"), showComputer: () => void calls.push("showComputer"), focus: () => void calls.push("focus") });

	it("opens a window if none is open, shows the Computer page, and focuses it, in that order, once", async () => {
		const r = rig();
		await r.wiring().stop();
		assert.equal(r.gate.beforeQuit(), false);
		const shown: string[] = [];
		wire(r.gate, "done", shown);
		wire(r.gate, "done", shown);
		assert.deepEqual(shown, ["openWindow", "showComputer", "focus"]);
	});

	it("shows nothing when no quit was asked", async () => {
		const r = rig();
		await r.wiring().stop();
		const shown: string[] = [];
		wire(r.gate, "done", shown);
		assert.deepEqual(shown, []);
	});

	it("waits for the done phase and does not use up the held quit before it", async () => {
		const r = rig();
		await r.wiring().stop();
		assert.equal(r.gate.beforeQuit(), false);
		const shown: string[] = [];
		wire(r.gate, "working", shown);
		wire(r.gate, "stop-failed", shown);
		assert.deepEqual(shown, []);
		wire(r.gate, "done", shown);
		assert.deepEqual(shown, ["openWindow", "showComputer", "focus"]);
	});
});

describe("holdQuit and quitsWhenWindowsClose", () => {
	it("cancels a quit the gate holds and lets one through that it does not", async () => {
		const r = rig();
		await r.wiring().stop();
		let prevented = 0;
		holdQuit(r.gate, { preventDefault: () => void prevented++ });
		assert.equal(prevented, 1);
		r.gate.removalDone();
		holdQuit(r.gate, { preventDefault: () => void prevented++ });
		assert.equal(prevented, 1, "a quit after the removal's end is let through");
	});

	it("Windows quits with its last window; macOS keeps running except after the removal is done", () => {
		const phases: RemoveState["phase"][] = ["idle", "planning", "working", "stop-failed", "busy", "failed", "done"];
		for (const phase of phases) {
			assert.equal(quitsWhenWindowsClose("win32", phase), true, `win32 ${phase}`);
			assert.equal(quitsWhenWindowsClose("darwin", phase), phase === "done", `darwin ${phase}`);
		}
	});
});

describe("ExitCleanup: the cleanup the removal armed", () => {
	const locate = { system: (tool: string) => `/sys/${tool}` };
	const make = (platform: NodeJS.Platform, spawn: (c: CleanupCommand) => void) => new ExitCleanup({ platform, pid: 4242, locate, spawn });

	it("starts nothing when nothing was armed", () => {
		const started: CleanupCommand[] = [];
		make("darwin", (c) => void started.push(c)).run();
		assert.deepEqual(started, []);
	});

	it("starts the armed cleanup once, for the app's own pid, with the marker flag it was armed with (T14R-F002)", () => {
		for (const marked of [true, false]) {
			const started: CleanupCommand[] = [];
			const cleanup = make("darwin", (c) => void started.push(c));
			cleanup.arm({ root: "/r/sbd", fallbackDir: "/h/.straw-boss-desk/ab12cd34", marked });
			cleanup.run();
			cleanup.run();
			assert.equal(started.length, 1, "once");
			assert.deepEqual(started[0]?.args.slice(2), ["sh", "/r/sbd", "/h/.straw-boss-desk/ab12cd34", "4242", marked ? "1" : ""]);
		}
		const win: CleanupCommand[] = [];
		const cleanup = make("win32", (c) => void win.push(c));
		cleanup.arm({ root: "C:\\r\\sbd", fallbackDir: null, marked: true });
		cleanup.run();
		assert.equal(win[0]?.env.SBD_RM_MARKED, "1");
		assert.equal(win[0]?.env.SBD_RM_PID, "4242");
	});

	it("a cleanup that cannot start is not retried and does not throw: the marker in the root has the next launch finish it", () => {
		let attempts = 0;
		const cleanup = make("darwin", () => {
			attempts++;
			throw new Error("spawn failed");
		});
		cleanup.arm({ root: "/r/sbd", fallbackDir: null, marked: true });
		assert.doesNotThrow(() => cleanup.run());
		cleanup.run();
		assert.equal(attempts, 1);
	});
});
