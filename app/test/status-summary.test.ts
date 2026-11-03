import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { statusSummary } from "./harness/status-summary.ts";

describe("statusSummary (T9-F005)", () => {
	it("prints the named fields and the key names, and never the GUI's token or address", () => {
		const out = statusSummary(JSON.stringify({ state: "live", primary: true, desk: true, version: "0.53.0", gui: { port: 1234, token: "af912c50deadbeef", url: "http://127.0.0.1:1234/af912c50deadbeef/" } }));
		assert.match(out, /"state":"live"/);
		assert.match(out, /"primary":true/);
		assert.ok(!out.includes("af912c50"), out);
		assert.ok(!out.includes("127.0.0.1"), out);
		assert.match(out, /fields: state, primary, desk, version, gui/);
	});

	it("prints nothing of an output that is not a JSON object", () => {
		assert.equal(statusSummary("token=af912c50 not json"), "(the status output is not JSON)");
		assert.equal(statusSummary('["af912c50"]'), "(the status output is not an object)");
	});
});
