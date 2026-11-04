import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CLOCK_SKEW_MS, eventsSince, type LogLine } from "./harness/log-events.ts";

// R-F005: the follow e2e's mark is taken in the test process just before the app logs the event, and on Windows the two processes' clocks can differ by a few milliseconds, so a strict comparison
// could drop the very line it waits for.

const at = (event: string, ms: number): LogLine => ({ event, t: new Date(ms).toISOString() });
const MARK = Date.parse("2026-11-04T06:46:34.000Z");

describe("reading the start log with a mark", () => {
	it("drops a line stamped before the mark when no skew is allowed", () => {
		assert.equal(eventsSince([at("follow-resume", MARK - 3)], "follow-resume", MARK).length, 0);
		assert.equal(eventsSince([at("follow-resume", MARK)], "follow-resume", MARK).length, 1);
	});

	it("counts a line the app stamped a few milliseconds before the mark once the skew is allowed (the Windows run of 41785756591)", () => {
		const lines = [at("follow-resume", MARK - 12), at("power-resume", MARK - 40)];
		assert.equal(eventsSince(lines, "follow-resume", MARK, CLOCK_SKEW_MS).length, 1);
		assert.equal(eventsSince(lines, "power-resume", MARK, CLOCK_SKEW_MS).length, 1);
	});

	it("still leaves out a line older than the margin: the resume of an earlier check is 2 s or more before the mark", () => {
		const lines = [at("follow-resume", MARK - 2000), at("follow-resume", MARK - 5)];
		assert.equal(eventsSince(lines, "follow-resume", MARK, CLOCK_SKEW_MS).length, 1);
		assert.equal(CLOCK_SKEW_MS < 2000, true, "the margin is smaller than the gap between the suspend and the mark");
	});

	it("only matches the event named", () => {
		assert.equal(eventsSince([at("follow-up", MARK + 5)], "follow-resume", MARK, CLOCK_SKEW_MS).length, 0);
	});
});
