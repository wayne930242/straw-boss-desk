import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hasStopStack } from "../src/main/runtime/args.ts";

describe("--stop-stack", () => {
	it("is found in the arguments of this launch and of a second instance, and nowhere else", () => {
		assert.equal(hasStopStack(["/app/Straw Boss Desk", "--stop-stack"]), true);
		assert.equal(hasStopStack(["C:\\app\\sbd.exe", "--lang=en-US", "--stop-stack"]), true);
		assert.equal(hasStopStack(["/app", "--stop-stack=1"]), false, "a value is another switch");
		assert.equal(hasStopStack(["/app", "--stop-stacks"]), false);
		assert.equal(hasStopStack(["/app", "--root=/x/--stop-stack"]), false);
		assert.equal(hasStopStack([]), false);
	});
});
