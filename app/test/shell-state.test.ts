import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { bannerState, failureState, screenState } from "../src/main/shell-state.ts";

describe("what the shell page is told", () => {
	it("carries a failure's kind, reason, pid, leftovers and Repair, and nothing else", () => {
		const state = failureState({ kind: "sb-unverified", reason: "r", unverifiedSb: 300, leftovers: [{ pid: 300, file: "node" }], offerRepair: true, startError: { code: "x", text: "secret detail" }, step: "gui", wait: "start" });
		assert.deepEqual(state, { mode: "screen", screen: "failed", failure: { kind: "sb-unverified", reason: "r", pid: 300, leftovers: [{ pid: 300, file: "node" }], offerRepair: true } });
		assert.deepEqual(failureState({ kind: "start", reason: "" }), { mode: "screen", screen: "failed", failure: { kind: "start", reason: "" } });
	});

	it("maps the follower's screens and banners", () => {
		assert.deepEqual(screenState({ kind: "gui-stopped" }), { mode: "screen", screen: "gui-stopped" });
		assert.deepEqual(screenState({ kind: "server-stopped" }), { mode: "screen", screen: "server-stopped" });
		assert.deepEqual(screenState({ kind: "failed", failure: { kind: "gui", reason: "x" } }), { mode: "screen", screen: "failed", failure: { kind: "gui", reason: "x" } });
		assert.deepEqual(bannerState("restarting"), { mode: "banner", banner: "restarting" });
		assert.deepEqual(bannerState(undefined), { mode: "none" });
	});
});
