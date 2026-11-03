import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { relaunchNotice } from "./relaunch-time.ts";

describe("the relaunch time (R9-F004 d)", () => {
	it("is a plain line up to the design's 30 s, and a warning annotation above it", () => {
		assert.equal(relaunchNotice(2900), "relaunch reached the GUI in 2.9 s");
		assert.equal(relaunchNotice(30_000), "relaunch reached the GUI in 30.0 s");
		const slow = relaunchNotice(30_100);
		assert.match(slow, /^::warning title=Slow relaunch::relaunch reached the GUI in 30\.1 s, the design says 30 s/);
		assert.match(slow, /\nrelaunch reached the GUI in 30\.1 s$/);
		assert.match(relaunchNotice(44_900), /^::warning /);
	});
});
