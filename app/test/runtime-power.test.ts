import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import { attachPower } from "../src/main/runtime/power.ts";

// `suspend` and `resume` reach the supervisor, and unwiring leaves the monitor as it was (spec: Crash and sleep).
describe("power", () => {
	it("pauses at suspend, resumes at resume, logs both, and unwires", () => {
		const monitor = new EventEmitter();
		const calls: string[] = [];
		const log: Array<Record<string, unknown>> = [];
		const off = attachPower(monitor, { suspend: () => calls.push("suspend"), resume: () => calls.push("resume") }, (f) => log.push(f));
		monitor.emit("suspend");
		monitor.emit("resume");
		assert.deepEqual(calls, ["suspend", "resume"]);
		assert.deepEqual(log.map((l) => l.event), ["power-suspend", "power-resume"]);
		off();
		monitor.emit("suspend");
		assert.deepEqual(calls, ["suspend", "resume"]);
		assert.equal(monitor.listenerCount("suspend") + monitor.listenerCount("resume"), 0);
	});
});
